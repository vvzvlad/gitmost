import { type Tool } from 'ai';
import { McpClientsService } from './mcp-clients.service';

/**
 * Tests for the per-server prompt guidance (#180) assembled by buildEntry and
 * surfaced via toolsFor().instructions.
 *
 * REACHABILITY NOTE: buildEntry is a PRIVATE method; the smallest reachable
 * public path is toolsFor() -> getOrBuildEntry -> buildEntry -> connect/tools()
 * -> mergeNamespaced. We drive that path: stub the repo's `listEnabled` and spy
 * on the private `connect` to return fake MCP clients whose `tools()` we control.
 *
 * Contract (all checked here): a server's guidance is included ONLY when the
 * server actually connected AND contributed ≥1 callable tool (after the
 * allowlist filter) AND its instructions are non-blank. The header carries the
 * tool namespace prefix (the sanitized server name).
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
  instructions: string | null;
}

function server(
  over: Partial<FakeServer> & { id: string; name: string },
): FakeServer {
  return {
    transport: 'http',
    url: 'https://example.com/mcp',
    headersEnc: null,
    toolAllowlist: null,
    instructions: null,
    ...over,
  };
}

async function instructionsFor(
  servers: FakeServer[],
  toolsByServerId: Record<string, Record<string, Tool>>,
  // Server ids whose connect should THROW (simulating an unavailable server).
  failingIds: Set<string> = new Set(),
): Promise<
  {
    serverName: string;
    toolPrefix: string;
    instructions: string;
  }[]
> {
  const repoStub = {
    listEnabled: jest.fn().mockResolvedValue(servers),
  };
  const service = new McpClientsService(repoStub as never, {} as never);

  jest
    .spyOn(
      service as unknown as { connect: (s: FakeServer) => unknown },
      'connect',
    )
    .mockImplementation((s: FakeServer) => {
      if (failingIds.has(s.id)) {
        return Promise.reject(new Error('connection failed'));
      }
      return Promise.resolve({
        tools: () => Promise.resolve(toolsByServerId[s.id] ?? {}),
        close: () => Promise.resolve(),
      });
    });

  const toolset = await service.toolsFor('ws-1');
  await Promise.all(toolset.clients.map((c) => c.close()));
  return toolset.instructions;
}

describe('external MCP per-server prompt guidance (via toolsFor)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('includes guidance for a connected server with non-empty text and ≥1 tool', async () => {
    const instructions = await instructionsFor(
      [
        server({
          id: 'id-tavily',
          name: 'Tavily',
          instructions: 'Use tavily_search for fresh facts.',
        }),
      ],
      { 'id-tavily': { search: fakeTool() } },
    );

    // sanitizeName preserves case (charset [a-zA-Z0-9_-]), so the prefix is the
    // server name as-is for an already-clean name.
    expect(instructions).toEqual([
      {
        serverName: 'Tavily',
        toolPrefix: 'Tavily',
        instructions: 'Use tavily_search for fresh facts.',
      },
    ]);
  });

  it('omits guidance when the server has no instructions', async () => {
    const instructions = await instructionsFor(
      [server({ id: 'id-1', name: 'Tavily', instructions: null })],
      { 'id-1': { search: fakeTool() } },
    );
    expect(instructions).toEqual([]);
  });

  it('omits guidance when the instructions are only whitespace', async () => {
    const instructions = await instructionsFor(
      [server({ id: 'id-1', name: 'Tavily', instructions: '   ' })],
      { 'id-1': { search: fakeTool() } },
    );
    expect(instructions).toEqual([]);
  });

  it('omits guidance for a server that contributed ZERO tools (allowlist filtered all out)', async () => {
    const instructions = await instructionsFor(
      [
        server({
          id: 'id-1',
          name: 'Tavily',
          instructions: 'guide',
          // Allowlist names a tool the server does not expose -> 0 picked.
          toolAllowlist: ['nonexistent'],
        }),
      ],
      { 'id-1': { search: fakeTool() } },
    );
    expect(instructions).toEqual([]);
  });

  it('omits guidance for an unavailable (failed-connect) server', async () => {
    const instructions = await instructionsFor(
      [server({ id: 'id-1', name: 'Tavily', instructions: 'guide' })],
      { 'id-1': { search: fakeTool() } },
      new Set(['id-1']),
    );
    expect(instructions).toEqual([]);
  });

  it('includes only the qualifying servers among several', async () => {
    const instructions = await instructionsFor(
      [
        server({ id: 'ok', name: 'Tavily', instructions: 'web guide' }),
        server({ id: 'blank', name: 'Crawl', instructions: '' }),
        server({ id: 'down', name: 'Down', instructions: 'never shown' }),
      ],
      {
        ok: { search: fakeTool() },
        blank: { crawl: fakeTool() },
        down: { x: fakeTool() },
      },
      new Set(['down']),
    );

    expect(instructions).toEqual([
      { serverName: 'Tavily', toolPrefix: 'Tavily', instructions: 'web guide' },
    ]);
  });
});
