import { PageHistoryRepo } from './page-history.repo';

/**
 * Enrichment coverage for the page-history agent avatar stack (#300/#304).
 *
 * attachPageHistoryAgent maps a DIFFERENT column set than comments —
 * `lastUpdatedSource` / `lastUpdatedAiChatId` / `lastUpdatedBy` instead of
 * `createdSource` / `aiChatId` / `creator` — so it needs its own direct proof
 * that the {agent,launcher} pair resolves for each provenance shape and that the
 * internal `agentRole` join column is stripped.
 *
 * The mapping is exercised through findPageHistoryByPageId (the only page-history
 * path that enriches). The Kysely db is a chainable recorder: query-builder
 * methods return the builder and `.execute()` (called by
 * executeWithCursorPagination) yields preset rows, so no real database is
 * touched. The `.select((eb) => ...)` callbacks are recorded but never invoked,
 * so the preset row stands in for what the DB would have returned.
 *
 * NON-VACUITY: against an identity mapping (raw row pass-through) the agent-case
 * assertions fail — `agent`/`launcher` would be undefined and the internal
 * `agentRole` column would leak.
 */
describe('PageHistoryRepo.findPageHistoryByPageId — agent avatar stack enrichment', () => {
  function makeRepo(rows: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      selectFrom: () => builder,
      select: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      execute: async () => rows,
    };
    const db = { selectFrom: () => builder };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new PageHistoryRepo(db as any);
  }

  // perPage high enough that a single preset row never triggers the extra-row
  // "has next page" branch (which would call generateCursor).
  const pagination = { limit: 50 } as any;

  const firstItem = async (row: Record<string, unknown>) => {
    const repo = makeRepo([row]);
    const result = await repo.findPageHistoryByPageId('page-1', pagination);
    return result.items[0] as any;
  };

  it('internal chat WITH role: agent = role (emoji, no avatar), launcher = human, agentRole stripped', async () => {
    const item = await firstItem({
      id: 'ph-1',
      lastUpdatedSource: 'agent',
      lastUpdatedAiChatId: 'chat-1',
      lastUpdatedBy: { name: 'Alice', avatarUrl: 'a.png' },
      agentRole: { name: 'Editor', emoji: '✏️' },
    });

    expect(item.agent).toEqual({
      name: 'Editor',
      emoji: '✏️',
      avatarUrl: null,
    });
    expect(item.launcher).toEqual({ name: 'Alice', avatarUrl: 'a.png' });
    // The internal join column must never leak to the client.
    expect(item).not.toHaveProperty('agentRole');
  });

  it('internal chat WITHOUT role: agent = "AI agent" fallback, launcher = human', async () => {
    const item = await firstItem({
      id: 'ph-2',
      lastUpdatedSource: 'agent',
      lastUpdatedAiChatId: 'chat-1',
      lastUpdatedBy: { name: 'Alice', avatarUrl: 'a.png' },
      agentRole: null,
    });

    expect(item.agent).toEqual({ name: 'AI agent', avatarUrl: null });
    expect(item.agent).not.toHaveProperty('emoji');
    expect(item.launcher).toEqual({ name: 'Alice', avatarUrl: 'a.png' });
    expect(item).not.toHaveProperty('agentRole');
  });

  it('external MCP (lastUpdatedAiChatId null): agent = the account itself, launcher = null', async () => {
    const item = await firstItem({
      id: 'ph-3',
      lastUpdatedSource: 'agent',
      lastUpdatedAiChatId: null,
      lastUpdatedBy: { name: 'MCP Bot', avatarUrl: 'bot.png' },
      agentRole: null,
    });

    expect(item.agent).toEqual({ name: 'MCP Bot', avatarUrl: 'bot.png' });
    expect(item.launcher).toBeNull();
    expect(item).not.toHaveProperty('agentRole');
  });

  // #559 — external-MCP (api_key) provenance, FORM 3. The row carries
  // lastUpdatedSource='agent', lastUpdatedAiChatId null, a non-null
  // lastUpdatedApiKeyId, and the key-name join object (`apiKey`).
  // attachPageHistoryAgent must thread api_key_id + apiKeyName into
  // resolveAgentProvenance so the persona is the NAMED key, launcher null, and
  // the join-only `apiKey` object is stripped.
  //
  // NON-VACUITY: if the read-side threading is reverted (attachPageHistoryAgent
  // no longer passes api_key_id / apiKeyName, or the resolver's external-MCP
  // branch is removed) this row falls into the degenerate external form and
  // `agent` becomes lastUpdatedBy ('MCP Bot') instead of the key name.
  it('external MCP with api_key name (form 3): agent = key name, launcher = null, apiKey stripped', async () => {
    const item = await firstItem({
      id: 'ph-5',
      lastUpdatedSource: 'agent',
      lastUpdatedAiChatId: null,
      lastUpdatedApiKeyId: 'key-1',
      apiKey: { name: 'agent-node-2' },
      lastUpdatedBy: { name: 'MCP Bot', avatarUrl: 'bot.png' },
      agentRole: null,
    });

    expect(item.agent).toEqual({ name: 'agent-node-2', avatarUrl: null });
    expect(item.launcher).toBeNull();
    // The join-only key-name object must never leak to the client (the raw
    // lastUpdatedApiKeyId column stays, like lastUpdatedAiChatId).
    expect(item).not.toHaveProperty('apiKey');
  });

  // #559 — external-MCP FALLBACK: a non-null lastUpdatedApiKeyId but a null
  // `apiKey` join (the key was hard-deleted, or carries no name). The persona
  // falls back to the EXTERNAL_MCP_FALLBACK_NAME ('External MCP').
  it('external MCP with a hard-deleted/absent key: agent = "External MCP" fallback', async () => {
    const item = await firstItem({
      id: 'ph-6',
      lastUpdatedSource: 'agent',
      lastUpdatedAiChatId: null,
      lastUpdatedApiKeyId: 'key-1',
      apiKey: null,
      lastUpdatedBy: { name: 'MCP Bot', avatarUrl: 'bot.png' },
      agentRole: null,
    });

    expect(item.agent).toEqual({ name: 'External MCP', avatarUrl: null });
    expect(item.launcher).toBeNull();
    expect(item).not.toHaveProperty('apiKey');
  });

  it('non-agent (lastUpdatedSource !== "agent"): neither agent nor launcher, agentRole stripped', async () => {
    const item = await firstItem({
      id: 'ph-4',
      lastUpdatedSource: 'user',
      lastUpdatedAiChatId: null,
      lastUpdatedBy: { name: 'Bob', avatarUrl: null },
      agentRole: null,
    });

    expect(item).not.toHaveProperty('agent');
    expect(item).not.toHaveProperty('launcher');
    // A plain human row still strips the internal join column.
    expect(item).not.toHaveProperty('agentRole');
  });
});
