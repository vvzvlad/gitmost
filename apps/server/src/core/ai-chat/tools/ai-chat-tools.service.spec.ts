import { AiChatToolsService } from './ai-chat-tools.service';
import * as loader from './docmost-client.loader';
import type { DocmostClientLike } from './docmost-client.loader';
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
  sharedToolSpecs: SHARED_TOOL_SPECS as Record<string, loader.SharedToolSpec>,
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
  const fakeClient: Partial<DocmostClientLike> = {
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

    // The Zod input schema only allows `pageId`; parsing strips/ignores extra
    // keys, so a permanent/force flag is never part of the validated input.
    const schema = (deletePage as unknown as { inputSchema: unknown })
      .inputSchema as {
      parse: (v: unknown) => Record<string, unknown>;
    };
    const parsed = schema.parse({
      pageId: 'page-789',
      permanentlyDelete: true,
      forceDelete: true,
    });

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
  const fakeClient: Partial<DocmostClientLike> = {};

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

    // The Zod input schema only allows pageId/transformJs/dryRun; parsing
    // strips unknown keys, so deleteComments can never reach the client.
    const schema = (transformPage as unknown as { inputSchema: unknown })
      .inputSchema as {
      parse: (v: unknown) => Record<string, unknown>;
    };
    const parsed = schema.parse({
      pageId: 'p',
      transformJs: '(d)=>d',
      dryRun: true,
      deleteComments: true,
    });

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

  const fakeClient: Partial<DocmostClientLike> = {
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

  it('patchNode parses a JSON-string node and forwards it as an object', async () => {
    const tools = await buildTools();
    await tools.patchNode.execute(
      { pageId: 'p1', nodeId: 'n1', node: JSON.stringify(NODE_OBJ) } as never,
      {} as never,
    );
    expect(patchNodeCalls).toHaveLength(1);
    expect(patchNodeCalls[0]).toEqual(['p1', 'n1', NODE_OBJ]);
  });

  it('patchNode passes an object node through unchanged', async () => {
    const tools = await buildTools();
    await tools.patchNode.execute(
      { pageId: 'p1', nodeId: 'n1', node: NODE_OBJ } as never,
      {} as never,
    );
    expect(patchNodeCalls[0]).toEqual(['p1', 'n1', NODE_OBJ]);
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

  it('insertNode parses a JSON-string node and forwards it as an object', async () => {
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
    const [pageId, node] = insertNodeCalls[0];
    expect(pageId).toBe('p1');
    expect(node).toEqual(NODE_OBJ);
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
});
