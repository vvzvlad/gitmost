import { McpServersService } from './mcp-servers.service';
import { AiMcpServer } from '@docmost/db/types/entity.types';

/**
 * Encrypted-header leak guard for the admin-facing view (§8.10): `toView` is
 * private, so we drive it through the public `list()` (which maps every row
 * with toView). The contract: a row with `headersEnc` set surfaces ONLY
 * `hasHeaders:true` and NEVER the `headersEnc` blob; a row without headers
 * surfaces `hasHeaders:false`. The blob must never reach an admin response.
 */
function row(overrides: Partial<AiMcpServer>): AiMcpServer {
  return {
    id: 'srv-1',
    name: 'Tavily',
    transport: 'http',
    url: 'https://example.com/mcp',
    enabled: true,
    toolAllowlist: null,
    headersEnc: null,
    ...overrides,
  } as unknown as AiMcpServer;
}

describe('McpServersService.toView (via list) — encrypted-header leak guard', () => {
  function buildService(rows: AiMcpServer[]): McpServersService {
    const repoStub = {
      listByWorkspace: jest.fn().mockResolvedValue(rows),
    };
    // secretBox + clients are unused by the list/toView path; pass stubs to
    // satisfy the constructor.
    return new McpServersService(
      repoStub as never,
      {} as never,
      {} as never,
    );
  }

  it('exposes hasHeaders:true and NO headersEnc when auth headers are set', async () => {
    const service = buildService([
      row({ headersEnc: 'ENCRYPTED-SECRET-BLOB' }),
    ]);

    const [view] = await service.list('ws-1');

    expect(view.hasHeaders).toBe(true);
    // The encrypted blob must NEVER appear in the view, under any key.
    expect('headersEnc' in view).toBe(false);
    expect(Object.values(view)).not.toContain('ENCRYPTED-SECRET-BLOB');
  });

  it('exposes hasHeaders:false when no auth headers are set', async () => {
    const service = buildService([row({ headersEnc: null })]);

    const [view] = await service.list('ws-1');

    expect(view.hasHeaders).toBe(false);
    expect('headersEnc' in view).toBe(false);
  });

  it('projects only the public fields', async () => {
    const service = buildService([
      row({
        id: 'srv-9',
        name: 'My MCP',
        transport: 'sse',
        url: 'https://mcp.example.com/',
        enabled: false,
        toolAllowlist: ['search'],
        headersEnc: 'BLOB',
      }),
    ]);

    const [view] = await service.list('ws-1');

    expect(view).toEqual({
      id: 'srv-9',
      name: 'My MCP',
      transport: 'sse',
      url: 'https://mcp.example.com/',
      enabled: false,
      toolAllowlist: ['search'],
      hasHeaders: true,
    });
  });
});
