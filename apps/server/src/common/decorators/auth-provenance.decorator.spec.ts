import {
  resolveProvenance,
  agentSourceFields,
} from './auth-provenance.decorator';

/**
 * Unit tests for the shared provenance helpers (#143 review, Arch A & follow-up
 * 5). resolveProvenance is the single source of truth wired into BOTH transport
 * seams (REST jwt.strategy + collab authentication.extension) — testing it here
 * pins the derivation matrix so the seams can't silently drift. agentSourceFields
 * is the one-place write-stamp idiom reused at every insert/update site.
 */
describe('resolveProvenance', () => {
  it("flags an is_agent user as 'agent' even with no claim (the closed collab gap)", () => {
    expect(resolveProvenance({ isAgent: true }, undefined)).toEqual({
      actor: 'agent',
      aiChatId: null,
      apiKeyId: null,
    });
  });

  it("an is_agent user keeps the claim's aiChatId when present", () => {
    expect(
      resolveProvenance({ isAgent: true }, { aiChatId: 'chat-1' }),
    ).toEqual({ actor: 'agent', aiChatId: 'chat-1', apiKeyId: null });
  });

  it("honors a signed actor='agent' claim on a non-agent user (internal AI-chat token)", () => {
    expect(
      resolveProvenance(
        { isAgent: false },
        { actor: 'agent', aiChatId: 'chat-2' },
      ),
    ).toEqual({ actor: 'agent', aiChatId: 'chat-2', apiKeyId: null });
  });

  it("a plain user with no claim resolves to 'user' with null chat", () => {
    expect(resolveProvenance({ isAgent: false }, undefined)).toEqual({
      actor: 'user',
      aiChatId: null,
      apiKeyId: null,
    });
  });

  it('tolerates a null/undefined user (defaults to the claim, else user)', () => {
    expect(resolveProvenance(null, null)).toEqual({
      actor: 'user',
      aiChatId: null,
      apiKeyId: null,
    });
    expect(resolveProvenance(undefined, { actor: 'agent' })).toEqual({
      actor: 'agent',
      aiChatId: null,
      apiKeyId: null,
    });
  });

  // #559 — an api_key principal ALWAYS resolves to an external-MCP 'agent' write,
  // even for an ordinary (non-is_agent) user's PERSONAL key, and carries the key
  // id through as apiKeyId (aiChatId stays null on this path).
  it("stamps 'agent' + apiKeyId for a non-agent user's personal api key", () => {
    expect(resolveProvenance({ isAgent: false }, null, 'key-1')).toEqual({
      actor: 'agent',
      aiChatId: null,
      apiKeyId: 'key-1',
    });
  });

  it('an is_agent user over an api key still carries the key id', () => {
    expect(resolveProvenance({ isAgent: true }, null, 'key-2')).toEqual({
      actor: 'agent',
      aiChatId: null,
      apiKeyId: 'key-2',
    });
  });
});

describe('agentSourceFields', () => {
  it('stamps the configured source + chat columns for an agent write', () => {
    expect(
      agentSourceFields(
        { actor: 'agent', aiChatId: 'chat-1' },
        'createdSource',
        'aiChatId',
      ),
    ).toEqual({ createdSource: 'agent', aiChatId: 'chat-1' });
  });

  it('uses the per-table column names passed in (page update variant)', () => {
    expect(
      agentSourceFields(
        { actor: 'agent', aiChatId: null },
        'lastUpdatedSource',
        'lastUpdatedAiChatId',
      ),
    ).toEqual({ lastUpdatedSource: 'agent', lastUpdatedAiChatId: null });
  });

  it('returns {} for a user write so the column keeps its default', () => {
    expect(
      agentSourceFields(
        { actor: 'user', aiChatId: null },
        'createdSource',
        'aiChatId',
      ),
    ).toEqual({});
  });

  it('returns {} when provenance is undefined', () => {
    expect(agentSourceFields(undefined, 'createdSource', 'aiChatId')).toEqual(
      {},
    );
  });

  // #559 — when the optional api_key column is passed, it is stamped for an agent
  // write: the verified key id for an external-MCP write, or null otherwise so the
  // aiChatId / api_key_id pair stays mutually exclusive.
  it('stamps the api_key column with the key id for an external-MCP write', () => {
    expect(
      agentSourceFields(
        { actor: 'agent', aiChatId: null, apiKeyId: 'key-1' },
        'createdSource',
        'aiChatId',
        'createdApiKeyId',
      ),
    ).toEqual({
      createdSource: 'agent',
      aiChatId: null,
      createdApiKeyId: 'key-1',
    });
  });

  it('stamps a null api_key column for an internal-agent write (no key)', () => {
    expect(
      agentSourceFields(
        { actor: 'agent', aiChatId: 'chat-1' },
        'lastUpdatedSource',
        'lastUpdatedAiChatId',
        'lastUpdatedApiKeyId',
      ),
    ).toEqual({
      lastUpdatedSource: 'agent',
      lastUpdatedAiChatId: 'chat-1',
      lastUpdatedApiKeyId: null,
    });
  });
});
