import { z } from 'zod';
import { AiChatToolsService } from './ai-chat-tools.service';
import * as loader from './docmost-client.loader';
import type { DocmostClientLike } from './docmost-client.loader';
// The real zod-agnostic registry, imported from source so the contract is checked
// against exactly what the @docmost/mcp package ships (no hand-stub).
import { SHARED_TOOL_SPECS } from '../../../../../../packages/mcp/src/tool-specs';

/**
 * CONTRACT: SHARED_TOOL_SPECS <-> in-app tool wiring parity.
 *
 * `packages/mcp/src/tool-specs.ts` is the single source of truth for the tools
 * that are intentionally IDENTICAL across the standalone MCP server (zod v3) and
 * the in-app AI-SDK service (zod v4). The in-app service builds each one via
 * `sharedTool(sharedToolSpecs.<key>, execute)`, keyed by the spec's `inAppKey`.
 *
 * This test fails the build if a spec is added to the registry but never wired
 * in-app, if an `inAppKey` is renamed without updating the service, if the
 * description drifts between the registry and the exposed tool, if the
 * snake_case `mcpName` <-> camelCase `inAppKey` convention is broken, or if the
 * exposed tool's input-schema keys diverge from the spec's `buildShape`.
 *
 * It does NOT need @docmost/mcp built: the registry is imported from TS source,
 * and the ESM loader is mocked so `forUser()` never dynamically imports the
 * package.
 */
describe('SHARED_TOOL_SPECS contract parity', () => {
  // Empty fake client: no tool is executed here — every assertion is on tool
  // presence / metadata / schema, so the client methods are never called.
  const fakeClient: Partial<DocmostClientLike> = {};
  const tokenServiceStub = {
    generateAccessToken: jest.fn().mockResolvedValue('access-token'),
    generateCollabToken: jest.fn().mockResolvedValue('collab-token'),
  };

  let tools: Record<string, unknown>;

  beforeAll(async () => {
    jest.spyOn(loader, 'loadDocmostMcp').mockResolvedValue({
      DocmostClient: function () {
        return fakeClient as DocmostClientLike;
      } as unknown as loader.DocmostClientCtor,
      // Feed the service the SAME registry this test asserts against.
      sharedToolSpecs: SHARED_TOOL_SPECS as unknown as Record<
        string,
        loader.SharedToolSpec
      >,
    });
    const service = new AiChatToolsService(
      tokenServiceStub as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { asSink: () => ({ put: jest.fn(), has: jest.fn(), evict: jest.fn() }) } as never,
    );
    tools = (await service.forUser(
      { id: 'user-1', email: 'u@example.com', workspaceId: 'ws-1' } as never,
      'session-1',
      'ws-1',
      'chat-1',
    )) as unknown as Record<string, unknown>;
  });

  afterAll(() => jest.restoreAllMocks());

  // camelCase -> snake_case, matching the registry's mcpName convention.
  const toSnake = (s: string) =>
    s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  // Type as the (optional-buildShape) SharedToolSpec; the `satisfies` literal
  // above otherwise narrows to a union where some members lack buildShape.
  const specEntries = Object.entries(SHARED_TOOL_SPECS) as Array<
    [string, loader.SharedToolSpec]
  >;

  // Sanity: the registry is non-empty, so the per-spec table below is not vacuous.
  it('registry is non-empty', () => {
    expect(specEntries.length).toBeGreaterThan(0);
  });

  describe.each(specEntries)('spec "%s"', (registryKey, spec) => {
    it('registry key equals its inAppKey', () => {
      // The service indexes the registry by property name; a key != inAppKey
      // would wire the wrong (or no) tool.
      expect(spec.inAppKey).toBe(registryKey);
    });

    it('mcpName is the snake_case form of inAppKey', () => {
      expect(spec.mcpName).toBe(toSnake(spec.inAppKey));
    });

    it('is exposed in-app under its inAppKey', () => {
      // Fails if a spec is added to the registry but never wired in forUser().
      expect(tools[spec.inAppKey]).toBeDefined();
    });

    it("exposed tool's description matches the registry description", () => {
      const tool = tools[spec.inAppKey] as { description: string };
      expect(tool.description).toBe(spec.description);
    });

    it("exposed tool's input-schema keys match buildShape (incl. required)", () => {
      const tool = tools[spec.inAppKey] as {
        inputSchema: { jsonSchema: { properties?: Record<string, unknown>; required?: string[] } };
      };
      const json = tool.inputSchema.jsonSchema;
      const actualKeys = Object.keys(json.properties ?? {}).sort();

      // Derive the spec's declared shape with THIS layer's zod (v4) — the same
      // call the service makes — then compare key sets and required-ness.
      const shape = spec.buildShape ? spec.buildShape(z) : {};
      const expectedKeys = Object.keys(shape).sort();
      expect(actualKeys).toEqual(expectedKeys);

      // A non-.optional() field must surface as required in the advertised schema.
      const expectedRequired = Object.entries(shape)
        .filter(([, field]) => !(field as z.ZodTypeAny).isOptional?.())
        .map(([k]) => k)
        .sort();
      expect((json.required ?? []).slice().sort()).toEqual(expectedRequired);
    });
  });
});
