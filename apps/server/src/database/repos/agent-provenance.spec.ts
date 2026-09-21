import {
  resolveAgentProvenance,
  EXTERNAL_MCP_FALLBACK_NAME,
} from './agent-provenance';
import {
  commentAgentRoleQuery,
  commentApiKeyNameQuery,
} from './comment/comment.repo';
import {
  pageHistoryAgentRoleQuery,
  pageHistoryApiKeyNameQuery,
} from './page/page-history.repo';

/**
 * The server-authoritative "agent avatar stack" resolver (#300) normalizes the
 * two provenance shapes into { agent (front), launcher (behind) } so the client
 * never branches. These tests pin the exact resolved shape for the three agent
 * cases plus the non-agent pass-through.
 */
describe('resolveAgentProvenance', () => {
  const human = { name: 'Alice', avatarUrl: 'a.png' };

  it('internal chat WITH role: agent = role (emoji, no avatar), launcher = human', () => {
    const result = resolveAgentProvenance({
      isAgent: true,
      aiChatId: 'chat-1',
      creator: human,
      agentRole: { name: 'Researcher', emoji: '🔬' },
    });
    expect(result).toEqual({
      agent: { name: 'Researcher', emoji: '🔬', avatarUrl: null },
      launcher: { name: 'Alice', avatarUrl: 'a.png' },
    });
  });

  it('internal chat WITHOUT role: agent = "AI agent" fallback, launcher = human', () => {
    const result = resolveAgentProvenance({
      isAgent: true,
      aiChatId: 'chat-1',
      creator: human,
      agentRole: null,
    });
    expect(result).toEqual({
      agent: { name: 'AI agent', avatarUrl: null },
      launcher: { name: 'Alice', avatarUrl: 'a.png' },
    });
    // The fallback agent carries no emoji (only sparkles glyph on the client).
    expect(result?.agent).not.toHaveProperty('emoji');
  });

  it('degenerate external (aiChatId null, no api key): agent = the account itself, launcher = null', () => {
    const result = resolveAgentProvenance({
      isAgent: true,
      aiChatId: null,
      creator: { name: 'MCP Bot', avatarUrl: 'bot.png' },
      agentRole: null,
    });
    expect(result).toEqual({
      agent: { name: 'MCP Bot', avatarUrl: 'bot.png' },
      launcher: null,
    });
  });

  // #559 — external MCP: api_key_id present (aiChatId null) → the persona is the
  // named key, NOT the human account. Launcher is null (no separate human).
  it('external MCP (api_key + name): agent = the key name, launcher = null', () => {
    const result = resolveAgentProvenance({
      isAgent: true,
      aiChatId: null,
      api_key_id: 'key-1',
      apiKeyName: 'agent-node-2',
      // The creator is the human key OWNER; it must NOT surface as the persona.
      creator: { name: 'Alice', avatarUrl: 'a.png' },
      agentRole: null,
    });
    expect(result).toEqual({
      agent: { name: 'agent-node-2', avatarUrl: null },
      launcher: null,
    });
  });

  it('external MCP (api_key present, name null/revoked): agent = the External MCP fallback', () => {
    const result = resolveAgentProvenance({
      isAgent: true,
      aiChatId: null,
      api_key_id: 'key-1',
      apiKeyName: null,
      creator: { name: 'Alice', avatarUrl: 'a.png' },
      agentRole: null,
    });
    expect(result).toEqual({
      agent: { name: EXTERNAL_MCP_FALLBACK_NAME, avatarUrl: null },
      launcher: null,
    });
    expect(EXTERNAL_MCP_FALLBACK_NAME).toBe('External MCP');
  });

  // An internal-agent write must be UNCHANGED even if an api_key_id somehow rode
  // along: aiChatId != null keeps it on the role/launcher branch (form 2).
  it('internal agent is unaffected by a stray api_key_id (aiChatId wins)', () => {
    const result = resolveAgentProvenance({
      isAgent: true,
      aiChatId: 'chat-1',
      api_key_id: 'key-9',
      apiKeyName: 'ignored',
      creator: human,
      agentRole: { name: 'Researcher', emoji: '🔬' },
    });
    expect(result).toEqual({
      agent: { name: 'Researcher', emoji: '🔬', avatarUrl: null },
      launcher: { name: 'Alice', avatarUrl: 'a.png' },
    });
  });

  it('non-agent content: returns null so the caller omits both fields', () => {
    expect(
      resolveAgentProvenance({
        isAgent: false,
        aiChatId: null,
        creator: human,
        agentRole: null,
      }),
    ).toBeNull();
  });
});

/**
 * The role-resolution subquery must NOT filter on enabled/deletedAt: historical
 * agent content keeps its signature even after the role is disabled or
 * soft-deleted (same rule as AiAgentRoleRepo.findById, NOT findLiveEnabled). We
 * record the query-builder calls and assert the join binds only id<->roleId and
 * that `where` is never called with an enabled/deletedAt filter.
 */
describe('agent role subquery — no live/enabled filter', () => {
  function makeRecorder() {
    const calls: { method: string; args: unknown[] }[] = [];
    const builder = new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: unknown[]) => {
            calls.push({ method: prop, args });
            return builder;
          };
        },
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eb = {
      selectFrom: (...args: unknown[]) => (
        calls.push({ method: 'selectFrom', args }),
        builder
      ),
    } as any;
    return { eb, calls };
  }

  function assertNoLiveFilter(
    query: (eb: any) => unknown, // eslint-disable-line @typescript-eslint/no-explicit-any
    chatIdColumn: string,
  ) {
    const { eb, calls } = makeRecorder();
    query(eb);

    const innerJoin = calls.find((c) => c.method === 'innerJoin');
    expect(innerJoin?.args).toEqual([
      'aiAgentRoles',
      'aiAgentRoles.id',
      'aiChats.roleId',
    ]);

    const whereRef = calls.find((c) => c.method === 'whereRef');
    expect(whereRef?.args).toEqual(['aiChats.id', '=', chatIdColumn]);

    // The security-narrowing filters used by findLiveEnabled must be ABSENT.
    const filtered = calls
      .flatMap((c) => c.args)
      .filter((a) => a === 'enabled' || a === 'deletedAt');
    expect(filtered).toEqual([]);
    // No `where(...)` at all (only the join + whereRef).
    expect(calls.some((c) => c.method === 'where')).toBe(false);
  }

  it('comment subquery joins by id only, keyed on comments.aiChatId', () => {
    assertNoLiveFilter(commentAgentRoleQuery, 'comments.aiChatId');
  });

  it('page-history subquery joins by id only, keyed on lastUpdatedAiChatId', () => {
    assertNoLiveFilter(
      pageHistoryAgentRoleQuery,
      'pageHistory.lastUpdatedAiChatId',
    );
  });

  // #559 — the external-MCP key-name join must ALSO omit any deletedAt filter, so
  // the persona survives a key REVOKE (soft-delete) exactly like the role join.
  function assertApiKeyNoDeletedFilter(
    query: (eb: any) => unknown, // eslint-disable-line @typescript-eslint/no-explicit-any
    apiKeyIdColumn: string,
  ) {
    const { eb, calls } = makeRecorder();
    query(eb);

    const selectFrom = calls.find((c) => c.method === 'selectFrom');
    expect(selectFrom?.args).toEqual(['apiKeys']);

    const whereRef = calls.find((c) => c.method === 'whereRef');
    expect(whereRef?.args).toEqual(['apiKeys.id', '=', apiKeyIdColumn]);

    // No deletedAt filter anywhere (revoke must not hide the historical name).
    const filtered = calls
      .flatMap((c) => c.args)
      .filter((a) => a === 'deletedAt');
    expect(filtered).toEqual([]);
    expect(calls.some((c) => c.method === 'where')).toBe(false);
  }

  it('comment api-key join keys on createdApiKeyId with no deletedAt filter', () => {
    assertApiKeyNoDeletedFilter(
      commentApiKeyNameQuery,
      'comments.createdApiKeyId',
    );
  });

  it('page-history api-key join keys on lastUpdatedApiKeyId with no deletedAt filter', () => {
    assertApiKeyNoDeletedFilter(
      pageHistoryApiKeyNameQuery,
      'pageHistory.lastUpdatedApiKeyId',
    );
  });
});
