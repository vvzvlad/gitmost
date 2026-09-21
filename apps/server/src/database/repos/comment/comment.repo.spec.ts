import { CommentRepo } from './comment.repo';

/**
 * Enrichment coverage for CommentRepo.findById (#300).
 *
 * The {agent,launcher} avatar stack must be attached on the SINGLE-ROW read
 * path, not only on findPageComments — the live websocket broadcasts
 * (commentCreated/commentUpdated/commentResolved) return a comment loaded via
 * findById. These tests would FAIL against the previous un-enriched findById
 * (which returned the raw row without calling attachCommentAgent and without
 * selecting the agent-role subquery).
 *
 * The Kysely db is replaced by a chainable recorder so the query never touches a
 * real database: it records the `.select(...)` args (to prove the agent-role
 * subquery is selected on the includeCreator path) and returns a preset row from
 * executeTakeFirst (to prove attachCommentAgent maps it into {agent,launcher}).
 */
describe('CommentRepo.findById — agent avatar stack enrichment', () => {
  function makeRepo(row: unknown) {
    const selectArgs: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      selectFrom: () => builder,
      selectAll: () => builder,
      select: (arg: unknown) => {
        selectArgs.push(arg);
        return builder;
      },
      // Kysely's $if(condition, cb) invokes cb(qb) only when the condition is
      // truthy; mirror that so gating (includeCreator) is exercised faithfully.
      $if: (cond: unknown, cb: (qb: unknown) => unknown) => {
        if (cond) cb(builder);
        return builder;
      },
      where: () => builder,
      executeTakeFirst: async () => row,
    };
    const db = { selectFrom: () => builder };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new CommentRepo(db as any);
    return { repo, selectArgs };
  }

  const enrichOpts = { includeCreator: true, includeResolvedBy: true };

  it('internal agent chat WITH role: returns agent = role, launcher = creator, and strips agentRole', async () => {
    const { repo, selectArgs } = makeRepo({
      id: 'c-1',
      createdSource: 'agent',
      aiChatId: 'chat-1',
      creator: { name: 'Alice', avatarUrl: 'a.png' },
      agentRole: { name: 'Researcher', emoji: '🔬' },
    });

    const result: any = await repo.findById('c-1', enrichOpts);

    expect(result.agent).toEqual({
      name: 'Researcher',
      emoji: '🔬',
      avatarUrl: null,
    });
    expect(result.launcher).toEqual({ name: 'Alice', avatarUrl: 'a.png' });
    // The internal join column must never leak to the client.
    expect(result).not.toHaveProperty('agentRole');
    // The enrichment SELECTs the agent-role subquery on the includeCreator path
    // (mirrors the list-query proof; absent in the pre-fix findById).
    expect(selectArgs).toContain(repo.withAgentRole);
  });

  it('external MCP agent (aiChatId null): agent = the account, launcher = null', async () => {
    const { repo } = makeRepo({
      id: 'c-2',
      createdSource: 'agent',
      aiChatId: null,
      creator: { name: 'MCP Bot', avatarUrl: 'bot.png' },
      agentRole: null,
    });

    const result: any = await repo.findById('c-2', enrichOpts);

    expect(result.agent).toEqual({ name: 'MCP Bot', avatarUrl: 'bot.png' });
    expect(result.launcher).toBeNull();
    expect(result).not.toHaveProperty('agentRole');
  });

  // #559 — external-MCP (api_key) provenance, FORM 3. The row carries
  // createdSource='agent', aiChatId null, a non-null createdApiKeyId, and the
  // key-name join object (`apiKey`). attachCommentAgent must thread
  // api_key_id + apiKeyName into resolveAgentProvenance so the persona is the
  // NAMED key, launcher null, and the join-only `apiKey` object is stripped.
  //
  // NON-VACUITY: if the read-side threading is reverted (attachCommentAgent no
  // longer passes api_key_id / apiKeyName, or the resolver's external-MCP branch
  // is removed) this row falls into the degenerate external form and `agent`
  // becomes the creator ('MCP Bot') instead of the key name — reddening this.
  it('external MCP with api_key name (form 3): agent = key name, launcher = null, apiKey stripped', async () => {
    const { repo } = makeRepo({
      id: 'c-5',
      createdSource: 'agent',
      aiChatId: null,
      createdApiKeyId: 'key-1',
      apiKey: { name: 'agent-node-2' },
      creator: { name: 'MCP Bot', avatarUrl: 'bot.png' },
      agentRole: null,
    });

    const result: any = await repo.findById('c-5', enrichOpts);

    expect(result.agent).toEqual({ name: 'agent-node-2', avatarUrl: null });
    expect(result.launcher).toBeNull();
    // The join-only key-name object must never leak to the client (the raw
    // createdApiKeyId column stays, like aiChatId).
    expect(result).not.toHaveProperty('apiKey');
  });

  // #559 — external-MCP FALLBACK: a non-null createdApiKeyId but a null `apiKey`
  // join (the key was hard-deleted, or the key row carries no name). The persona
  // falls back to the EXTERNAL_MCP_FALLBACK_NAME ('External MCP').
  it('external MCP with a hard-deleted/absent key: agent = "External MCP" fallback', async () => {
    const { repo } = makeRepo({
      id: 'c-6',
      createdSource: 'agent',
      aiChatId: null,
      createdApiKeyId: 'key-1',
      apiKey: null,
      creator: { name: 'MCP Bot', avatarUrl: 'bot.png' },
      agentRole: null,
    });

    const result: any = await repo.findById('c-6', enrichOpts);

    expect(result.agent).toEqual({ name: 'External MCP', avatarUrl: null });
    expect(result.launcher).toBeNull();
    expect(result).not.toHaveProperty('apiKey');
  });

  it('non-agent comment: neither agent nor launcher is attached', async () => {
    const { repo } = makeRepo({
      id: 'c-3',
      createdSource: 'user',
      aiChatId: null,
      creator: { name: 'Bob', avatarUrl: null },
      agentRole: null,
    });

    const result: any = await repo.findById('c-3', enrichOpts);

    expect(result).not.toHaveProperty('agent');
    expect(result).not.toHaveProperty('launcher');
    // A plain human comment still strips the internal join column.
    expect(result).not.toHaveProperty('agentRole');
  });

  it('missing row: returns undefined without crashing the enrichment', async () => {
    const { repo } = makeRepo(undefined);
    await expect(repo.findById('nope', enrichOpts)).resolves.toBeUndefined();
  });

  it('non-includeCreator callers keep the plain shape (no enrichment, no agent-role select)', async () => {
    const { repo, selectArgs } = makeRepo({
      id: 'c-4',
      createdSource: 'agent',
      aiChatId: 'chat-1',
    });

    // No opts => the enrichment (and its subquery select) must be skipped, so
    // callers doing a bare lookup (parent-comment check, controller findOne)
    // are unaffected by the additive fields.
    const result: any = await repo.findById('c-4');

    expect(result).not.toHaveProperty('agent');
    expect(result).not.toHaveProperty('launcher');
    expect(selectArgs).not.toContain(repo.withAgentRole);
  });
});
