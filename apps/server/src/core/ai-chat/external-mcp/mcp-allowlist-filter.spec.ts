import { type Tool } from 'ai';
import { McpClientsService } from './mcp-clients.service';

/**
 * Tool-allowlist filtering semantics on the merged external toolset (#476).
 *
 * COVERAGE CHOICE (documented per issue #476): the full corrupt-row chain
 * (DB value -> repo normalizeRow -> toolsFor filter) is covered on TWO levels
 * instead of one live-stub-MCP-server integration test:
 *   (a) apps/server/test/integration/ai-mcp-server-repo.int-spec.ts pins the
 *       repo read/write semantics against a real Postgres — `[]` round-trips
 *       as jsonb `[]`, a present-but-corrupt value fails CLOSED to `[]` with
 *       an error log;
 *   (b) THIS spec pins what the toolset builder does with the repo's output —
 *       null = unrestricted, `['alpha']` = only alpha, `[]` (including the
 *       corrupt-row fallback) = ZERO tools.
 * Together they prove the end-to-end property "corrupt/empty allowlist can
 * never widen to all tools" without a live stub HTTP MCP server.
 *
 * The drive path mirrors mcp-namespacing.spec.ts: stub the repo's listEnabled,
 * spy the private `connect` to return a fake client, inspect the merged keys.
 */

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

function server(
  over: Partial<FakeServer> & { id: string; name: string },
): FakeServer {
  return {
    transport: 'http',
    url: 'https://example.com/mcp',
    headersEnc: null,
    toolAllowlist: null,
    ...over,
  };
}

/**
 * Build a service whose repo returns `servers` and whose fake clients expose
 * `rawTools` from tools(). Returns the merged tool keys produced by toolsFor.
 */
async function mergedKeysFor(
  servers: FakeServer[],
  rawTools: Record<string, Tool>,
): Promise<string[]> {
  const repoStub = {
    listEnabledForAgent: jest.fn().mockResolvedValue(servers),
  };
  const service = new McpClientsService(repoStub as never, {} as never);

  jest
    .spyOn(
      service as unknown as { connect: (s: FakeServer) => unknown },
      'connect',
    )
    .mockImplementation(() =>
      Promise.resolve({
        tools: () => Promise.resolve(rawTools),
        close: () => Promise.resolve(),
      }),
    );

  const toolset = await service.toolsFor('ws-1', 'user-1');
  // Release the lease so the service does not hold the fake clients open.
  await Promise.all(toolset.clients.map((c) => c.close()));
  return Object.keys(toolset.tools);
}

describe('external MCP tool-allowlist filtering (via toolsFor, #476)', () => {
  afterEach(() => jest.restoreAllMocks());

  const RAW = () => ({
    alpha: fakeTool(),
    beta: fakeTool(),
    gamma: fakeTool(),
  });

  it("['alpha'] lets ONLY alpha through", async () => {
    const keys = await mergedKeysFor(
      [server({ id: 'id-1', name: 'srv', toolAllowlist: ['alpha'] })],
      RAW(),
    );
    expect(keys).toEqual(['srv_alpha']);
  });

  it('null (no restriction) lets every tool through', async () => {
    const keys = await mergedKeysFor(
      [server({ id: 'id-1', name: 'srv', toolAllowlist: null })],
      RAW(),
    );
    expect(keys.sort()).toEqual(['srv_alpha', 'srv_beta', 'srv_gamma']);
  });

  it('[] (deny-all) yields ZERO tools — an empty array is authoritative, not falsy (#476)', async () => {
    // This is the regression the #476 change guards: `[]` used to fall through
    // the old `allow.length > 0` check and expose ALL tools. It must expose NONE.
    const keys = await mergedKeysFor(
      [server({ id: 'id-1', name: 'srv', toolAllowlist: [] })],
      RAW(),
    );
    expect(keys).toEqual([]);
  });

  it('the corrupt-row fallback ([] from the repo) also yields ZERO tools (#476)', async () => {
    // The repo turns a present-but-corrupt tool_allowlist into `[]` (fail-closed,
    // see normalizeRow in ai-mcp-server.repo.ts + the int-spec); this pins that
    // the toolset builder honours that fallback as deny-all rather than allow-all.
    const corruptFallback: string[] = [];
    const keys = await mergedKeysFor(
      [server({ id: 'id-1', name: 'srv', toolAllowlist: corruptFallback })],
      RAW(),
    );
    expect(keys).toEqual([]);
  });

  it('allowlisted names not exposed by the server are ignored (no phantom tools)', async () => {
    const keys = await mergedKeysFor(
      [
        server({
          id: 'id-1',
          name: 'srv',
          toolAllowlist: ['alpha', 'does-not-exist'],
        }),
      ],
      RAW(),
    );
    expect(keys).toEqual(['srv_alpha']);
  });

  it('a deny-all server contributes no prompt instructions (0 tools merged)', async () => {
    const repoStub = {
      listEnabledForAgent: jest.fn().mockResolvedValue([
        {
          ...server({ id: 'id-1', name: 'srv', toolAllowlist: [] }),
          instructions: 'use the tools wisely',
        },
      ]),
    };
    const service = new McpClientsService(repoStub as never, {} as never);
    jest
      .spyOn(
        service as unknown as { connect: (s: FakeServer) => unknown },
        'connect',
      )
      .mockImplementation(() =>
        Promise.resolve({
          tools: () => Promise.resolve(RAW()),
          close: () => Promise.resolve(),
        }),
      );

    const toolset = await service.toolsFor('ws-1', 'user-1');
    await Promise.all(toolset.clients.map((c) => c.close()));
    expect(Object.keys(toolset.tools)).toEqual([]);
    // mergeNamespaced reported 0 contributed tools, so no guidance is attached.
    expect(toolset.instructions).toEqual([]);
  });
});
