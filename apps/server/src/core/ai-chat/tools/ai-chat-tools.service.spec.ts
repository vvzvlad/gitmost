import { AiChatToolsService } from './ai-chat-tools.service';
import * as loader from './docmost-client.loader';
import type { DocmostClientLike } from './docmost-client.loader';

// Test-double type for the loopback client. `DocmostClientLike` is now DERIVED
// from the real `DocmostClient` (issue #446), so its method RETURN types are the
// concrete client shapes. These stubs deliberately return minimal recording
// shapes (e.g. `{ ok: true }`), which no longer satisfy those concrete returns —
// so the doubles are typed with the same method NAMES but loose async returns.
// Each is still cast to `DocmostClientLike` at the (return-erased) mock site, so
// the positional-call type-safety on the PRODUCTION client is unaffected.
type FakeDocmostClient = Partial<
  Record<keyof DocmostClientLike, (...args: any[]) => Promise<any>>
>;
// The real zod-agnostic shared tool-spec registry. It has no runtime deps, so
// importing the TS source directly keeps these mocks honest: the service builds
// the shared tools from exactly the specs the package ships, not a hand-stub.
import { SHARED_TOOL_SPECS } from '../../../../../../packages/mcp/src/tool-specs';

// loadDocmostMcp now resolves to { DocmostClient, sharedToolSpecs }. Every mock
// below must supply sharedToolSpecs or the service throws while building the
// shared tools. Factor the resolved-value shape so the three mock sites stay in
// sync.
const mockLoaded = (DocmostClient: loader.DocmostClientCtor) => ({
  DocmostClient,
  sharedToolSpecs: SHARED_TOOL_SPECS as unknown as Record<string, loader.SharedToolSpec>,
  // Pure no-network draw.io helpers (#424). Type-correct stubs: these tests
  // never execute the drawioShapes / drawioGuide tool bodies.
  searchShapes: (() => []) as unknown as loader.SearchShapesFn,
  getGuideSection: (() => ({
    section: 'index',
    content: '',
    sections: [],
  })) as unknown as loader.GetGuideSectionFn,
});

/**
 * Guardrail test (§14 [H4]): the adapter's `deletePage` write tool must be a
 * SOFT delete only — it can NEVER cause a permanent/force delete. The Docmost
 * client's deletePage(pageId) hits POST /pages/delete with `{ pageId }` only
 * (the soft-delete/trash path), and the tool forwards nothing else. This test
 * asserts that the tool physically cannot pass a `permanentlyDelete`/
 * `forceDelete` flag: only `pageId` is ever forwarded to the client, and the
 * tool's input schema rejects those fields entirely (D3 reversible-only).
 */
describe('AiChatToolsService deletePage guardrail (H4)', () => {
  // Captures every argument passed to the fake client's deletePage so we can
  // assert no permanent/force flag is ever forwarded.
  const deletePageCalls: unknown[][] = [];

  // Minimal fake DocmostClient: only the write methods the tools touch need to
  // exist; deletePage records its args. No network, no ESM import.
  const fakeClient: FakeDocmostClient = {
    deletePage: (...args: unknown[]) => {
      deletePageCalls.push(args);
      return Promise.resolve({ success: true });
    },
  };

  // Stub TokenService: the guardrail does not exercise auth, only the tool's
  // payload, so any non-empty token works.
  const tokenServiceStub = {
    generateAccessToken: jest.fn().mockResolvedValue('access-token'),
    generateCollabToken: jest.fn().mockResolvedValue('collab-token'),
  };

  let service: AiChatToolsService;

  beforeEach(() => {
    deletePageCalls.length = 0;
    // Intercept the ESM loader so `new DocmostClient(config)` returns our fake.
    jest.spyOn(loader, 'loadDocmostMcp').mockResolvedValue(
      mockLoaded(function () {
        return fakeClient as DocmostClientLike;
      } as unknown as loader.DocmostClientCtor),
    );
    // The new semanticSearch deps (aiService + repos) are not exercised by the
    // deletePage guardrail tests; pass stubs to satisfy the constructor arity.
    service = new AiChatToolsService(
      tokenServiceStub as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      // sandboxStore: forUser() eagerly calls asSink() to wire the stash tool,
      // even though these tests never execute it — return a no-op sink so the
      // tool wiring in forUser() succeeds.
      {
        asSink: () => ({ put: jest.fn(), has: jest.fn(), evict: jest.fn() }),
      } as never,
      // #599: EmbeddingGenerationService (active-generation fingerprint for
      // the hybrid RAG read). Unused by this spec (the RAG path falls back).
      {} as never,
      // #629: EnvironmentService (DRAWIO_RASTER_ENABLED mirror). Flag OFF here
      // so viewImage's drawio no-raster path stays inert (resvg fallback).
      { isDrawioRasterEnabled: () => false } as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildTools() {
    return service.forUser(
      { id: 'user-1', email: 'u@example.com', workspaceId: 'ws-1' } as never,
      'session-1',
      'ws-1',
      'chat-1',
    );
  }

  it('forwards ONLY pageId to the client (no permanent/force flag)', async () => {
    const tools = await buildTools();
    const deletePage = tools.deletePage;

    await deletePage.execute(
      { pageId: 'page-123' } as never,
      {} as never,
    );

    expect(deletePageCalls).toHaveLength(1);
    // The client must be called with exactly one positional argument: pageId.
    expect(deletePageCalls[0]).toEqual(['page-123']);
  });

  it('ignores any permanentlyDelete/forceDelete passed in the input', async () => {
    const tools = await buildTools();
    const deletePage = tools.deletePage;

    // Even if a (compromised) model emitted these fields, the execute body only
    // destructures `pageId`, so they can never reach the client.
    await deletePage.execute(
      {
        pageId: 'page-456',
        permanentlyDelete: true,
        forceDelete: true,
      } as never,
      {} as never,
    );

    expect(deletePageCalls).toHaveLength(1);
    const [forwardedArgs] = deletePageCalls;
    // Only pageId is forwarded — no second arg, and the forwarded value is a
    // bare string id, never an object carrying a delete flag.
    expect(forwardedArgs).toEqual(['page-456']);
    expect(typeof forwardedArgs[0]).toBe('string');
  });

  it('does not declare permanentlyDelete/forceDelete in the tool input schema', async () => {
    const tools = await buildTools();
    const deletePage = tools.deletePage;

    // The wrapped input schema (modelFriendlyInput) only allows `pageId`;
    // validation strips/ignores extra keys, so a permanent/force flag is never
    // part of the validated input handed to execute.
    const schema = (deletePage as unknown as { inputSchema: unknown })
      .inputSchema as {
      validate: (
        v: unknown,
      ) =>
        | { success: boolean; value?: Record<string, unknown> }
        | Promise<{ success: boolean; value?: Record<string, unknown> }>;
    };
    const result = await schema.validate({
      pageId: 'page-789',
      permanentlyDelete: true,
      forceDelete: true,
    });

    expect(result.success).toBe(true);
    const parsed = result.value as Record<string, unknown>;
    expect(parsed).toHaveProperty('pageId', 'page-789');
    expect(parsed).not.toHaveProperty('permanentlyDelete');
    expect(parsed).not.toHaveProperty('forceDelete');
  });
});

/**
 * Toolset exposure guardrails: the expanded toolset must expose the new
 * read/write capabilities BUT must never expose the forbidden hard-delete of a
 * comment, and `transformPage` must not accept a `deleteComments` field (its
 * comment-deletion path stays unreachable from the agent).
 */
describe('AiChatToolsService expanded toolset guardrails', () => {
  // No client method is invoked here — every assertion is on tool presence /
  // input schema — so an empty fake client is sufficient.
  const fakeClient: FakeDocmostClient = {};

  const tokenServiceStub = {
    generateAccessToken: jest.fn().mockResolvedValue('access-token'),
    generateCollabToken: jest.fn().mockResolvedValue('collab-token'),
  };

  let service: AiChatToolsService;

  beforeEach(() => {
    jest.spyOn(loader, 'loadDocmostMcp').mockResolvedValue(
      mockLoaded(function () {
        return fakeClient as DocmostClientLike;
      } as unknown as loader.DocmostClientCtor),
    );
    service = new AiChatToolsService(
      tokenServiceStub as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      // sandboxStore: forUser() eagerly calls asSink() to wire the stash tool,
      // even though these tests never execute it — return a no-op sink so the
      // tool wiring in forUser() succeeds.
      {
        asSink: () => ({ put: jest.fn(), has: jest.fn(), evict: jest.fn() }),
      } as never,
      // #599: EmbeddingGenerationService (active-generation fingerprint for
      // the hybrid RAG read). Unused by this spec (the RAG path falls back).
      {} as never,
      // #629: EnvironmentService (DRAWIO_RASTER_ENABLED mirror). Flag OFF here
      // so viewImage's drawio no-raster path stays inert (resvg fallback).
      { isDrawioRasterEnabled: () => false } as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildTools() {
    return service.forUser(
      { id: 'user-1', email: 'u@example.com', workspaceId: 'ws-1' } as never,
      'session-1',
      'ws-1',
      'chat-1',
    );
  }

  it('never exposes a hard deleteComment tool', async () => {
    const tools = await buildTools();
    expect(tools).not.toHaveProperty('deleteComment');
  });

  it('never exposes an updateComment tool (comment edits are irreversible / not version-tracked)', async () => {
    const tools = await buildTools();
    expect(tools).not.toHaveProperty('updateComment');
  });

  it('exposes the new read/write/comment/transform tools', async () => {
    const tools = await buildTools();
    expect(tools).toHaveProperty('listComments');
    expect(tools).toHaveProperty('getComment');
    expect(tools).toHaveProperty('transformPage');
    expect(tools).toHaveProperty('getPageJson');
    expect(tools).toHaveProperty('patchNode');
  });

  it('transformPage input schema does not accept a deleteComments field', async () => {
    const tools = await buildTools();
    const transformPage = tools.transformPage;

    // The wrapped input schema only allows pageId/transformJs/dryRun;
    // validation strips unknown keys, so deleteComments can never reach the
    // client.
    const schema = (transformPage as unknown as { inputSchema: unknown })
      .inputSchema as {
      validate: (
        v: unknown,
      ) =>
        | { success: boolean; value?: Record<string, unknown> }
        | Promise<{ success: boolean; value?: Record<string, unknown> }>;
    };
    const result = await schema.validate({
      pageId: 'p',
      transformJs: '(d)=>d',
      dryRun: true,
      deleteComments: true,
    });

    expect(result.success).toBe(true);
    const parsed = result.value as Record<string, unknown>;
    expect(parsed).toHaveProperty('pageId', 'p');
    expect(parsed).not.toHaveProperty('deleteComments');
  });
});

/**
 * JSON-string coercion for node arguments (fix 59b99dba): under OpenAI tool
 * calls the model sometimes serializes `node`/`content` as a JSON STRING. The
 * tools parse a string into an object before forwarding it to the client (which
 * type-checks for an object), throw a documented message on invalid JSON, and
 * `updatePageJson` distinguishes undefined (title-only) from object/string.
 */
describe('AiChatToolsService node-arg JSON-string coercion', () => {
  // Records the positional args forwarded to each write method so we can assert
  // the coerced (parsed) value reaches the client.
  const patchNodeCalls: unknown[][] = [];
  const insertNodeCalls: unknown[][] = [];
  const updatePageJsonCalls: unknown[][] = [];
  const updatePageCalls: unknown[][] = [];

  const fakeClient: FakeDocmostClient = {
    patchNode: (...args: unknown[]) => {
      patchNodeCalls.push(args);
      return Promise.resolve({ ok: true });
    },
    insertNode: (...args: unknown[]) => {
      insertNodeCalls.push(args);
      return Promise.resolve({ ok: true });
    },
    updatePageJson: (...args: unknown[]) => {
      updatePageJsonCalls.push(args);
      return Promise.resolve({ ok: true });
    },
    // Backs the plain-Markdown full-body-replace tool updatePageMarkdown (#411).
    updatePage: (...args: unknown[]) => {
      updatePageCalls.push(args);
      return Promise.resolve({ success: true });
    },
  };

  const tokenServiceStub = {
    generateAccessToken: jest.fn().mockResolvedValue('access-token'),
    generateCollabToken: jest.fn().mockResolvedValue('collab-token'),
  };

  let service: AiChatToolsService;

  beforeEach(() => {
    patchNodeCalls.length = 0;
    insertNodeCalls.length = 0;
    updatePageJsonCalls.length = 0;
    updatePageCalls.length = 0;
    jest.spyOn(loader, 'loadDocmostMcp').mockResolvedValue(
      mockLoaded(function () {
        return fakeClient as DocmostClientLike;
      } as unknown as loader.DocmostClientCtor),
    );
    service = new AiChatToolsService(
      tokenServiceStub as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      // sandboxStore: forUser() eagerly calls asSink() to wire the stash tool,
      // even though these tests never execute it — return a no-op sink so the
      // tool wiring in forUser() succeeds.
      {
        asSink: () => ({ put: jest.fn(), has: jest.fn(), evict: jest.fn() }),
      } as never,
      // #599: EmbeddingGenerationService (active-generation fingerprint for
      // the hybrid RAG read). Unused by this spec (the RAG path falls back).
      {} as never,
      // #629: EnvironmentService (DRAWIO_RASTER_ENABLED mirror). Flag OFF here
      // so viewImage's drawio no-raster path stays inert (resvg fallback).
      { isDrawioRasterEnabled: () => false } as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildTools() {
    return service.forUser(
      { id: 'user-1', email: 'u@example.com', workspaceId: 'ws-1' } as never,
      'session-1',
      'ws-1',
      'chat-1',
    );
  }

  const NODE_OBJ = {
    type: 'paragraph',
    content: [{ type: 'text', text: 'Hello' }],
  };

  it('patchNode parses a JSON-string node and forwards it as { node } (object)', async () => {
    const tools = await buildTools();
    await tools.patchNode.execute(
      { pageId: 'p1', nodeId: 'n1', node: JSON.stringify(NODE_OBJ) } as never,
      {} as never,
    );
    expect(patchNodeCalls).toHaveLength(1);
    // #413: the 3rd arg is now the XOR input { markdown?, node? }.
    expect(patchNodeCalls[0]).toEqual([
      'p1',
      'n1',
      { markdown: undefined, node: NODE_OBJ },
    ]);
  });

  it('patchNode passes an object node through unchanged inside { node }', async () => {
    const tools = await buildTools();
    await tools.patchNode.execute(
      { pageId: 'p1', nodeId: 'n1', node: NODE_OBJ } as never,
      {} as never,
    );
    expect(patchNodeCalls[0]).toEqual([
      'p1',
      'n1',
      { markdown: undefined, node: NODE_OBJ },
    ]);
  });

  it('patchNode throws the documented message on invalid JSON string', async () => {
    const tools = await buildTools();
    await expect(
      tools.patchNode.execute(
        { pageId: 'p1', nodeId: 'n1', node: '{not json' } as never,
        {} as never,
      ),
    ).rejects.toThrow('node was a string but not valid JSON');
    expect(patchNodeCalls).toHaveLength(0);
  });

  it('insertNode parses a JSON-string node and forwards it inside { node }', async () => {
    const tools = await buildTools();
    await tools.insertNode.execute(
      {
        pageId: 'p1',
        node: JSON.stringify(NODE_OBJ),
        position: 'append',
      } as never,
      {} as never,
    );
    expect(insertNodeCalls).toHaveLength(1);
    // #413: the 2nd arg is the XOR input { markdown?, node? }, the 3rd is opts.
    const [pageId, input, opts] = insertNodeCalls[0] as [
      string,
      { markdown?: unknown; node?: unknown },
      { position?: string },
    ];
    expect(pageId).toBe('p1');
    expect(input).toEqual({ markdown: undefined, node: NODE_OBJ });
    expect(opts.position).toBe('append');
  });

  it('insertNode throws the documented message on invalid JSON string', async () => {
    const tools = await buildTools();
    await expect(
      tools.insertNode.execute(
        { pageId: 'p1', node: 'nope', position: 'append' } as never,
        {} as never,
      ),
    ).rejects.toThrow('node was a string but not valid JSON');
    expect(insertNodeCalls).toHaveLength(0);
  });

  it('updatePageJson forwards doc=undefined for a title-only update (content undefined)', async () => {
    const tools = await buildTools();
    await tools.updatePageJson.execute(
      { pageId: 'p1', title: 'New title' } as never,
      {} as never,
    );
    expect(updatePageJsonCalls).toHaveLength(1);
    expect(updatePageJsonCalls[0]).toEqual(['p1', undefined, 'New title']);
  });

  it('updatePageJson passes an object content through unchanged', async () => {
    const tools = await buildTools();
    const doc = { type: 'doc', content: [] };
    await tools.updatePageJson.execute(
      { pageId: 'p1', content: doc } as never,
      {} as never,
    );
    expect(updatePageJsonCalls[0]).toEqual(['p1', doc, undefined]);
  });

  it('updatePageJson parses a JSON-string content', async () => {
    const tools = await buildTools();
    const doc = { type: 'doc', content: [] };
    await tools.updatePageJson.execute(
      { pageId: 'p1', content: JSON.stringify(doc) } as never,
      {} as never,
    );
    expect(updatePageJsonCalls[0]).toEqual(['p1', doc, undefined]);
  });

  it('updatePageJson throws the documented message on invalid JSON string content', async () => {
    const tools = await buildTools();
    await expect(
      tools.updatePageJson.execute(
        { pageId: 'p1', content: '{bad' } as never,
        {} as never,
      ),
    ).rejects.toThrow('content was a string but not valid JSON');
    expect(updatePageJsonCalls).toHaveLength(0);
  });

  // #411: the plain-Markdown full-body-replace tool is now the shared
  // `updatePageMarkdown` (was inline `updatePageContent`). It forwards to
  // client.updatePage(pageId, content, title) -> updatePageContentRealtime ->
  // markdownToProseMirrorCanonical, so `^[...]` footnotes materialize.
  it('updatePageMarkdown forwards { pageId, content, title } to client.updatePage', async () => {
    const tools = await buildTools();
    await tools.updatePageMarkdown.execute(
      { pageId: 'p1', content: 'Body^[a note]', title: 'New title' } as never,
      {} as never,
    );
    expect(updatePageCalls).toHaveLength(1);
    expect(updatePageCalls[0]).toEqual(['p1', 'Body^[a note]', 'New title']);
  });

  it('updatePageMarkdown returns the RAW client result in-app (deliberate #411 shape change, documented on the spec)', async () => {
    const tools = await buildTools();
    // Registry canonical execute returns client.updatePage's result verbatim.
    // The old inline tool projected to { pageId, updated }; the rename now
    // surfaces the raw result (nothing reads the removed `.updated`; the raw
    // shape carries footnote/verify warnings and matches the on-both-hosts
    // registry convention). fakeClient.updatePage resolves { success: true }.
    const result = await tools.updatePageMarkdown.execute(
      { pageId: 'p1', content: '# Hi' } as never,
      {} as never,
    );
    expect(result).toEqual({ success: true });
  });

  it('updatePageMarkdown forwards title=undefined when omitted', async () => {
    const tools = await buildTools();
    await tools.updatePageMarkdown.execute(
      { pageId: 'p1', content: '# Hi' } as never,
      {} as never,
    );
    expect(updatePageCalls[0]).toEqual(['p1', '# Hi', undefined]);
  });

  // #411 surface split: the plain-Markdown replace tool exists in-app under the
  // new key; the OLD inline updatePageContent key is gone; importPageMarkdown is
  // still present IN-APP (only the external MCP surface drops it — asserted in
  // packages/mcp/test/unit/tool-inventory.test.mjs).
  it('exposes updatePageMarkdown in-app, no legacy updatePageContent, keeps importPageMarkdown', async () => {
    const tools = await buildTools();
    expect(tools.updatePageMarkdown).toBeDefined();
    expect((tools as Record<string, unknown>).updatePageContent).toBeUndefined();
    expect(tools.importPageMarkdown).toBeDefined();
  });
});

/**
 * Model-friendly tool-call validation (#190): when the model drops a required
 * `pageId` in a parallel/batch tool call, the built-in input schema must return
 * a CLEAR, actionable message (naming the parameter, reminding it not to drop
 * ids in batches) instead of zod's raw "expected string, received undefined" —
 * while a valid call still validates. This is wired centrally via
 * modelFriendlyInput, so it applies to every in-app tool; createComment (the
 * tool from the bug report) and a sharedTool-built tool (getPage's sibling
 * getOutline) are exercised here end-to-end through forUser().
 */
describe('AiChatToolsService model-friendly input validation (#190)', () => {
  const fakeClient: FakeDocmostClient = {};
  const tokenServiceStub = {
    generateAccessToken: jest.fn().mockResolvedValue('access-token'),
    generateCollabToken: jest.fn().mockResolvedValue('collab-token'),
  };
  let service: AiChatToolsService;

  beforeEach(() => {
    jest.spyOn(loader, 'loadDocmostMcp').mockResolvedValue(
      mockLoaded(function () {
        return fakeClient as DocmostClientLike;
      } as unknown as loader.DocmostClientCtor),
    );
    service = new AiChatToolsService(
      tokenServiceStub as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      // sandboxStore: forUser() eagerly calls asSink() to wire the stash tool,
      // even though these tests never execute it — return a no-op sink so the
      // tool wiring in forUser() succeeds.
      {
        asSink: () => ({ put: jest.fn(), has: jest.fn(), evict: jest.fn() }),
      } as never,
      // #599: EmbeddingGenerationService (active-generation fingerprint for
      // the hybrid RAG read). Unused by this spec (the RAG path falls back).
      {} as never,
      // #629: EnvironmentService (DRAWIO_RASTER_ENABLED mirror). Flag OFF here
      // so viewImage's drawio no-raster path stays inert (resvg fallback).
      { isDrawioRasterEnabled: () => false } as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  function buildTools() {
    return service.forUser(
      { id: 'user-1', email: 'u@example.com', workspaceId: 'ws-1' } as never,
      'session-1',
      'ws-1',
      'chat-1',
    );
  }

  // The AI SDK Schema produced by modelFriendlyInput exposes `validate`.
  type ValidatableSchema = {
    validate: (
      v: unknown,
    ) =>
      | { success: boolean; value?: unknown; error?: Error }
      | Promise<{ success: boolean; value?: unknown; error?: Error }>;
  };
  const inputSchemaOf = (t: unknown) =>
    (t as { inputSchema: unknown }).inputSchema as ValidatableSchema;

  it('createComment: a dropped pageId yields a clear, model-actionable message', async () => {
    const tools = await buildTools();
    // The exact failing shape from the bug report's second parallel batch:
    // content + selection, but pageId silently dropped.
    const result = await inputSchemaOf(tools.createComment).validate({
      content: 'A remark',
      selection: 'титановый проводник',
    });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('parameter "pageId": missing (required)');
    expect(result.error?.message).toContain('parallel/batch tool calls');
    // Not the raw zod text the model previously received.
    expect(result.error?.message).not.toContain('received undefined');
  });

  it('createComment: a valid call with pageId validates successfully', async () => {
    const tools = await buildTools();
    const result = await inputSchemaOf(tools.createComment).validate({
      pageId: '019efe44-0000-0000-0000-000000000000',
      content: 'A remark',
      selection: 'титановый проводник',
    });
    expect(result.success).toBe(true);
    expect(result.value).toMatchObject({
      pageId: '019efe44-0000-0000-0000-000000000000',
      content: 'A remark',
    });
  });

  it('createComment: accepts an optional suggestedText alongside a selection', async () => {
    const tools = await buildTools();
    const result = await inputSchemaOf(tools.createComment).validate({
      pageId: '019efe44-0000-0000-0000-000000000000',
      content: 'A remark',
      selection: 'титановый проводник',
      suggestedText: 'медный проводник',
    });
    expect(result.success).toBe(true);
    expect(result.value).toMatchObject({
      suggestedText: 'медный проводник',
    });
  });

  it('sharedTool-built tools (getOutline) also get the friendly message on a dropped pageId', async () => {
    const tools = await buildTools();
    const result = await inputSchemaOf(tools.getOutline).validate({});
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('parameter "pageId": missing (required)');
  });
});

/**
 * #294 F1 — the contract-parity test introspects only the ADVERTISED schema keys
 * (buildShape), not the execute bodies. Most execs are unchanged pass-throughs,
 * but two wirings actually CHANGED in the migration and are otherwise untested:
 *   - movePage now forwards the newly-added optional `position` field to the
 *     client (client.movePage(pageId, parentPageId, position));
 *   - the table trio unified its `tableRef` param to `table` and must forward it
 *     positionally. A field destructured under the wrong name would silently pass
 *     `undefined` to the client (execute is `any`-cast, so tsc won't catch it).
 */
describe('AiChatToolsService #294 changed execute wirings', () => {
  const calls: Record<string, unknown[][]> = {
    movePage: [],
    tableInsertRow: [],
    tableDeleteRow: [],
    tableUpdateCell: [],
  };
  const fakeClient: FakeDocmostClient = {
    movePage: (...args: unknown[]) => {
      calls.movePage.push(args);
      return Promise.resolve({ success: true });
    },
    tableInsertRow: (...args: unknown[]) => {
      calls.tableInsertRow.push(args);
      return Promise.resolve({ ok: true });
    },
    tableDeleteRow: (...args: unknown[]) => {
      calls.tableDeleteRow.push(args);
      return Promise.resolve({ ok: true });
    },
    tableUpdateCell: (...args: unknown[]) => {
      calls.tableUpdateCell.push(args);
      return Promise.resolve({ ok: true });
    },
  };
  const tokenServiceStub = {
    generateAccessToken: jest.fn().mockResolvedValue('access-token'),
    generateCollabToken: jest.fn().mockResolvedValue('collab-token'),
  };
  let service: AiChatToolsService;

  beforeEach(() => {
    for (const k of Object.keys(calls)) calls[k].length = 0;
    jest.spyOn(loader, 'loadDocmostMcp').mockResolvedValue(
      mockLoaded(function () {
        return fakeClient as DocmostClientLike;
      } as unknown as loader.DocmostClientCtor),
    );
    service = new AiChatToolsService(
      tokenServiceStub as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        asSink: () => ({ put: jest.fn(), has: jest.fn(), evict: jest.fn() }),
      } as never,
      // #599: EmbeddingGenerationService (active-generation fingerprint for
      // the hybrid RAG read). Unused by this spec (the RAG path falls back).
      {} as never,
      // #629: EnvironmentService (DRAWIO_RASTER_ENABLED mirror). Flag OFF here
      // so viewImage's drawio no-raster path stays inert (resvg fallback).
      { isDrawioRasterEnabled: () => false } as never,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  const buildTools = () =>
    service.forUser(
      { id: 'user-1', email: 'u@example.com', workspaceId: 'ws-1' } as never,
      'session-1',
      'ws-1',
      'chat-1',
    );

  it('movePage forwards the optional position to the client', async () => {
    const tools = await buildTools();
    await tools.movePage.execute(
      { pageId: 'p1', parentPageId: 'parent1', position: 'a5' } as never,
      {} as never,
    );
    expect(calls.movePage).toEqual([['p1', 'parent1', 'a5']]);
  });

  it('movePage passes undefined position and null parent when omitted (unchanged behavior)', async () => {
    const tools = await buildTools();
    await tools.movePage.execute({ pageId: 'p2' } as never, {} as never);
    expect(calls.movePage).toEqual([['p2', null, undefined]]);
  });

  it('tableInsertRow forwards the unified `table` param positionally', async () => {
    const tools = await buildTools();
    await tools.tableInsertRow.execute(
      { pageId: 'p1', table: '#0', cells: ['a', 'b'], index: 2 } as never,
      {} as never,
    );
    expect(calls.tableInsertRow).toEqual([['p1', '#0', ['a', 'b'], 2]]);
  });

  it('tableDeleteRow forwards `table` positionally', async () => {
    const tools = await buildTools();
    await tools.tableDeleteRow.execute(
      { pageId: 'p1', table: '#0', index: 1 } as never,
      {} as never,
    );
    expect(calls.tableDeleteRow).toEqual([['p1', '#0', 1]]);
  });

  it('tableUpdateCell forwards `table` positionally', async () => {
    const tools = await buildTools();
    await tools.tableUpdateCell.execute(
      { pageId: 'p1', table: '#0', row: 1, col: 2, text: 'x' } as never,
      {} as never,
    );
    expect(calls.tableUpdateCell).toEqual([['p1', '#0', 1, 2, 'x']]);
  });
});

/**
 * #410 — the footnote + image tools were promoted from MCP-only into the shared
 * registry and are now wired in-app. Assert they are REGISTERED in the in-app
 * toolset and forward their args to the client with the correct arg->method
 * mapping (the schema fields `imageUrl`/`attachmentId` map onto the client's
 * positional `url`/`oldAttachmentId`). A field destructured under the wrong name
 * would silently pass `undefined` (execute is `any`-cast, so tsc won't catch it).
 */
describe('AiChatToolsService #410 footnote + image tools', () => {
  const calls: Record<string, unknown[][]> = {
    insertFootnote: [],
    insertImage: [],
    replaceImage: [],
  };
  const fakeClient: FakeDocmostClient = {
    insertFootnote: (...args: unknown[]) => {
      calls.insertFootnote.push(args);
      return Promise.resolve({ success: true, footnoteId: 'fn1', reused: false });
    },
    insertImage: (...args: unknown[]) => {
      calls.insertImage.push(args);
      return Promise.resolve({ success: true, attachmentId: 'att1' });
    },
    replaceImage: (...args: unknown[]) => {
      calls.replaceImage.push(args);
      return Promise.resolve({ success: true, replaced: 1 });
    },
  };
  const tokenServiceStub = {
    generateAccessToken: jest.fn().mockResolvedValue('access-token'),
    generateCollabToken: jest.fn().mockResolvedValue('collab-token'),
  };
  let service: AiChatToolsService;

  beforeEach(() => {
    for (const k of Object.keys(calls)) calls[k].length = 0;
    jest.spyOn(loader, 'loadDocmostMcp').mockResolvedValue(
      mockLoaded(function () {
        return fakeClient as DocmostClientLike;
      } as unknown as loader.DocmostClientCtor),
    );
    service = new AiChatToolsService(
      tokenServiceStub as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        asSink: () => ({ put: jest.fn(), has: jest.fn(), evict: jest.fn() }),
      } as never,
      // #599: EmbeddingGenerationService (active-generation fingerprint for
      // the hybrid RAG read). Unused by this spec (the RAG path falls back).
      {} as never,
      // #629: EnvironmentService (DRAWIO_RASTER_ENABLED mirror). Flag OFF here
      // so viewImage's drawio no-raster path stays inert (resvg fallback).
      { isDrawioRasterEnabled: () => false } as never,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  const buildTools = () =>
    service.forUser(
      { id: 'user-1', email: 'u@example.com', workspaceId: 'ws-1' } as never,
      'session-1',
      'ws-1',
      'chat-1',
    );

  it('registers all three tools in the in-app toolset', async () => {
    const tools = await buildTools();
    expect(tools.insertFootnote).toBeDefined();
    expect(tools.insertImage).toBeDefined();
    expect(tools.replaceImage).toBeDefined();
  });

  it('insertFootnote forwards (pageId, anchorText, text) positionally', async () => {
    const tools = await buildTools();
    const r = await tools.insertFootnote.execute(
      { pageId: 'p1', anchorText: 'the claim', text: 'See source.' } as never,
      {} as never,
    );
    expect(calls.insertFootnote).toEqual([['p1', 'the claim', 'See source.']]);
    expect(r).toMatchObject({ footnoteId: 'fn1' });
  });

  it('insertImage maps imageUrl->url and packs the option fields', async () => {
    const tools = await buildTools();
    await tools.insertImage.execute(
      {
        pageId: 'p1',
        imageUrl: 'https://x/img.png',
        align: 'center',
        alt: 'A',
        replaceText: '[img]',
        afterText: undefined,
      } as never,
      {} as never,
    );
    expect(calls.insertImage).toEqual([
      [
        'p1',
        'https://x/img.png',
        { align: 'center', alt: 'A', replaceText: '[img]', afterText: undefined },
      ],
    ]);
  });

  it('replaceImage maps attachmentId->oldAttachmentId and imageUrl->url', async () => {
    const tools = await buildTools();
    await tools.replaceImage.execute(
      {
        pageId: 'p1',
        attachmentId: 'att-old',
        imageUrl: 'https://x/new.png',
        align: 'right',
        alt: 'B',
      } as never,
      {} as never,
    );
    expect(calls.replaceImage).toEqual([
      ['p1', 'att-old', 'https://x/new.png', { align: 'right', alt: 'B' }],
    ]);
  });
});

/**
 * getCurrentPage selection contract (#388): the tool surfaces the selection that
 * was sanitized + nested onto the resolved open-page context (last forUser arg).
 * No page => selection is null. The tool never fetches or verifies anything — it
 * just projects the resolved context.
 */
describe('AiChatToolsService getCurrentPage selection (#388)', () => {
  const tokenServiceStub = {
    generateAccessToken: jest.fn().mockResolvedValue('access-token'),
    generateCollabToken: jest.fn().mockResolvedValue('collab-token'),
  };

  let service: AiChatToolsService;

  beforeEach(() => {
    jest.spyOn(loader, 'loadDocmostMcp').mockResolvedValue(
      mockLoaded(function () {
        return {} as DocmostClientLike;
      } as unknown as loader.DocmostClientCtor),
    );
    service = new AiChatToolsService(
      tokenServiceStub as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        asSink: () => ({ put: jest.fn(), has: jest.fn(), evict: jest.fn() }),
      } as never,
      // #599: EmbeddingGenerationService (active-generation fingerprint for
      // the hybrid RAG read). Unused by this spec (the RAG path falls back).
      {} as never,
      // #629: EnvironmentService (DRAWIO_RASTER_ENABLED mirror). Flag OFF here
      // so viewImage's drawio no-raster path stays inert (resvg fallback).
      { isDrawioRasterEnabled: () => false } as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const buildTools = (openedPage: unknown) =>
    service.forUser(
      { id: 'user-1', email: 'u@example.com', workspaceId: 'ws-1' } as never,
      'session-1',
      'ws-1',
      'chat-1',
      openedPage as never,
    );

  it('returns the nested selection from the resolved context', async () => {
    const selection = { text: 'fix this', blockIds: ['b1'], before: 'a ' };
    const tools = await buildTools({ id: 'p1', title: 'Doc', selection });
    expect(await tools.getCurrentPage.execute({} as never, {} as never)).toEqual(
      { page: { id: 'p1', title: 'Doc' }, selection },
    );
  });

  it('returns selection: null when the context has no selection', async () => {
    const tools = await buildTools({ id: 'p1', title: 'Doc' });
    expect(await tools.getCurrentPage.execute({} as never, {} as never)).toEqual(
      { page: { id: 'p1', title: 'Doc' }, selection: null },
    );
  });

  it('returns { page: null, selection: null } when no page is open', async () => {
    const tools = await buildTools(null);
    expect(await tools.getCurrentPage.execute({} as never, {} as never)).toEqual(
      { page: null, selection: null },
    );
  });
});

/**
 * #440 review: the in-app drawioCreate / drawioUpdate handlers must forward
 * the optional `layout:"elk"` param to the client (5th positional arg), exactly
 * like the MCP host. It was silently dropped, so ELK auto-layout worked only via
 * the standalone MCP server, not in-app. These tests pin per-host parity.
 */
describe('AiChatToolsService drawio layout passthrough (#440)', () => {
  const createCalls: unknown[][] = [];
  const updateCalls: unknown[][] = [];

  // FakeDocmostClient (not Partial<DocmostClientLike>): since #446 derived
  // DocmostClientLike from the real client, its drawioCreate/drawioUpdate return
  // the concrete result shape, so a minimal stub object would not be assignable.
  // FakeDocmostClient types every method as (...args) => Promise<any>, which is
  // exactly what these arg-capturing doubles need.
  const fakeClient: FakeDocmostClient = {
    drawioCreate: (...args: unknown[]) => {
      createCalls.push(args);
      return Promise.resolve({ success: true, nodeId: '#0' });
    },
    drawioUpdate: (...args: unknown[]) => {
      updateCalls.push(args);
      return Promise.resolve({ success: true, nodeId: '#0' });
    },
  };

  const tokenServiceStub = {
    generateAccessToken: jest.fn().mockResolvedValue('access-token'),
    generateCollabToken: jest.fn().mockResolvedValue('collab-token'),
  };

  let service: AiChatToolsService;

  beforeEach(() => {
    createCalls.length = 0;
    updateCalls.length = 0;
    jest.spyOn(loader, 'loadDocmostMcp').mockResolvedValue(
      mockLoaded(function () {
        return fakeClient as DocmostClientLike;
      } as unknown as loader.DocmostClientCtor),
    );
    service = new AiChatToolsService(
      tokenServiceStub as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        asSink: () => ({ put: jest.fn(), has: jest.fn(), evict: jest.fn() }),
      } as never,
      // #599: EmbeddingGenerationService (active-generation fingerprint for
      // the hybrid RAG read). Unused by this spec (the RAG path falls back).
      {} as never,
      // #629: EnvironmentService (DRAWIO_RASTER_ENABLED mirror). Flag OFF here
      // so viewImage's drawio no-raster path stays inert (resvg fallback).
      { isDrawioRasterEnabled: () => false } as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const buildTools = () =>
    service.forUser(
      { id: 'user-1', email: 'u@example.com', workspaceId: 'ws-1' } as never,
      'session-1',
      'ws-1',
      'chat-1',
    );

  it('forwards layout:"elk" to client.drawioCreate as the 5th positional arg', async () => {
    const tools = await buildTools();
    await tools.drawioCreate.execute(
      {
        pageId: 'p-1',
        xml: '<mxGraphModel/>',
        position: 'append',
        layout: 'elk',
      } as never,
      {} as never,
    );
    expect(createCalls).toHaveLength(1);
    // drawioCreate(pageId, where, xml, title, layout) — layout is args[4].
    expect(createCalls[0][4]).toBe('elk');
  });

  it('forwards layout:"elk" to client.drawioUpdate as the 5th positional arg', async () => {
    const tools = await buildTools();
    await tools.drawioUpdate.execute(
      {
        pageId: 'p-1',
        node: '#0',
        xml: '<mxGraphModel/>',
        baseHash: 'h',
        layout: 'elk',
      } as never,
      {} as never,
    );
    expect(updateCalls).toHaveLength(1);
    // drawioUpdate(pageId, node, xml, baseHash, layout) — layout is args[4].
    expect(updateCalls[0][4]).toBe('elk');
  });

  it('omits layout (undefined 5th arg) when not requested', async () => {
    const tools = await buildTools();
    await tools.drawioCreate.execute(
      { pageId: 'p-1', xml: '<mxGraphModel/>', position: 'append' } as never,
      {} as never,
    );
    expect(createCalls[0][4]).toBeUndefined();
  });
});
