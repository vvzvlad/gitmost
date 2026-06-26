import { type Tool } from 'ai';
import { McpClientsService } from './mcp-clients.service';

/**
 * Tool-name namespacing / collision tests.
 *
 * REACHABILITY NOTE: the helpers `namespace` / `sanitizeName` / `capName` /
 * `disambiguate` are module-private (not exported) and `mergeNamespaced` is a
 * PRIVATE method. The smallest reachable public path that exercises all of them
 * is `toolsFor()` -> getOrBuildEntry -> buildEntry -> connect/tools() ->
 * mergeNamespaced. We drive that path: stub the repo's `listEnabled` to return
 * fake servers and spy on the private `connect` to return fake MCP clients whose
 * `tools()` we control. We then inspect the merged tool KEYS on the returned
 * toolset — the observable result of namespacing.
 *
 * What we assert (all SECURITY/correctness-relevant):
 *  - two servers each exposing a tool `search` -> BOTH survive under distinct
 *    namespaced keys (no silent overwrite);
 *  - a tool name with spaces/unicode -> sanitized to ^[a-zA-Z0-9_-]+;
 *  - an over-long name -> capped to the provider limit (<= 64);
 *  - duplicate names WITHIN one server (collide after sanitize/truncate) ->
 *    disambiguated, so the second is not overwritten.
 */
const MAX_TOOL_NAME_LENGTH = 64;

function fakeTool(): Tool {
  return { description: 'x', inputSchema: undefined } as unknown as Tool;
}

interface FakeServer {
  id: string;
  name: string;
  transport: string;
  url: string;
  headersEnc: string | null;
  toolAllowlist: string[] | null;
}

function server(over: Partial<FakeServer> & { id: string; name: string }): FakeServer {
  return {
    transport: 'http',
    url: 'https://example.com/mcp',
    headersEnc: null,
    toolAllowlist: null,
    ...over,
  };
}

/**
 * Build a service whose repo returns `servers` and whose `connect` returns a
 * fake client exposing `toolsByServerId[server.id]` from tools(). Returns the
 * merged keys produced by toolsFor.
 */
async function mergedKeysFor(
  servers: FakeServer[],
  toolsByServerId: Record<string, Record<string, Tool>>,
): Promise<string[]> {
  const repoStub = {
    listEnabled: jest.fn().mockResolvedValue(servers),
  };
  const service = new McpClientsService(repoStub as never, {} as never);

  // Map each connect() call (by server identity) to a fake client. connect is
  // private; spy on it via a typed any-cast.
  jest
    .spyOn(service as unknown as { connect: (s: FakeServer) => unknown }, 'connect')
    .mockImplementation((s: FakeServer) =>
      Promise.resolve({
        tools: () => Promise.resolve(toolsByServerId[s.id] ?? {}),
        close: () => Promise.resolve(),
      }),
    );

  const toolset = await service.toolsFor('ws-1');
  // Release the lease so the service does not hold the fake clients open.
  await Promise.all(toolset.clients.map((c) => c.close()));
  return Object.keys(toolset.tools);
}

describe('external MCP tool-name namespacing (via toolsFor)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps tools from two servers that both expose `search` (no overwrite)', async () => {
    const keys = await mergedKeysFor(
      [
        server({ id: 'id-alpha', name: 'alpha' }),
        server({ id: 'id-beta', name: 'beta' }),
      ],
      {
        'id-alpha': { search: fakeTool() },
        'id-beta': { search: fakeTool() },
      },
    );

    // Two distinct keys survive -> no silent overwrite.
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    // The server name is prefixed onto each tool.
    expect(keys).toContain('alpha_search');
    expect(keys.some((k) => k !== 'alpha_search')).toBe(true);
  });

  it('sanitizes spaces/unicode in names to the allowed charset', async () => {
    const keys = await mergedKeysFor(
      [server({ id: 'id-1', name: 'My Server!' })],
      { 'id-1': { 'search the wiki ✨': fakeTool() } },
    );

    expect(keys).toHaveLength(1);
    // Only ^[a-zA-Z0-9_-]+ characters remain (no spaces, no unicode).
    expect(keys[0]).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('caps an over-long name to the provider length limit', async () => {
    const longName = 'a'.repeat(200);
    const keys = await mergedKeysFor(
      [server({ id: 'id-1', name: 'svr' })],
      { 'id-1': { [longName]: fakeTool() } },
    );

    expect(keys).toHaveLength(1);
    expect(keys[0].length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });

  it('disambiguates two names that collide after sanitize/truncate within one server', async () => {
    // Both names sanitize to the same value ("a_b") -> the second must be
    // suffix-disambiguated, not overwritten.
    const keys = await mergedKeysFor(
      [server({ id: 'id-1', name: 'svr' })],
      { 'id-1': { 'a b': fakeTool(), 'a@b': fakeTool() } },
    );

    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});
