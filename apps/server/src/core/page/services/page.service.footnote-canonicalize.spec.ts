// Binding test for issue #228 must-fix #1 / test-coverage #12: footnote
// canonicalization moved OUT of parseProsemirrorContent and is now applied only
// on FULL-document writes (createPage, and updatePageContent with operation
// 'replace'), NEVER on an append/prepend FRAGMENT.
//
// The Yjs encode / plain-text extract are stubbed (partial module mock keeps the
// REAL canonicalizeFootnotes) and parseProsemirrorContent is spied to return the
// raw fixture, so the test isolates the canonicalize BINDING from schema/Yjs.
jest.mock('@docmost/editor-ext', () => {
  const actual = jest.requireActual('@docmost/editor-ext');
  return {
    ...actual,
    createYdocFromJson: jest.fn(() => Buffer.from([])),
    jsonToText: jest.fn(() => ''),
  };
});

import { PageService } from './page.service';

const refNode = (id: string) => ({ type: 'footnoteReference', attrs: { id } });
const defNode = (id: string, text: string) => ({
  type: 'footnoteDefinition',
  attrs: { id },
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const doc = (...content: any[]) => ({ type: 'doc', content });

/** A full doc whose footnote definitions are OUT of reference order (b,a refs;
 *  a,b defs) — canonicalization must reorder the definitions to [b, a]. */
const outOfOrderFull = () =>
  doc(
    { type: 'paragraph', content: [{ type: 'text', text: 'x' }, refNode('b'), refNode('a')] },
    { type: 'footnotesList', content: [defNode('a', 'A'), defNode('b', 'B')] },
  );

/** A definition-ONLY fragment (no references): canonicalizing it would drop the
 *  whole footnotesList (referenceIds is empty) — i.e. LOSE the footnote. */
const defOnlyFragment = () =>
  doc({ type: 'footnotesList', content: [defNode('a', 'appended note')] });

/** A reference-only fragment that REUSES an id defined elsewhere in the live
 *  doc: canonicalizing it would synthesize a bogus empty footnotesList/def. */
const refReuseFragment = () =>
  doc({ type: 'paragraph', content: [{ type: 'text', text: 'more' }, refNode('a')] });

function listDefIds(content: any): string[] {
  const list = (content.content ?? []).find((n: any) => n.type === 'footnotesList');
  return (list?.content ?? [])
    .filter((n: any) => n.type === 'footnoteDefinition')
    .map((n: any) => n.attrs?.id);
}
function hasFootnotesList(content: any): boolean {
  return (content.content ?? []).some((n: any) => n.type === 'footnotesList');
}

describe('PageService footnote canonicalization binding (#228)', () => {
  function makeService() {
    let insertedContent: any = null;
    let yjsPayload: any = null;

    const pageRepo = {
      insertPage: jest.fn(async (values: any) => {
        insertedContent = values.content;
        return { id: 'page-id', slugId: 'slug-id' };
      }),
    };
    const generalQueue = { add: jest.fn().mockReturnValue({ catch: jest.fn() }) };
    const collaborationGateway = {
      handleYjsEvent: jest.fn(async (_evt: string, _name: string, payload: any) => {
        yjsPayload = payload;
      }),
    };

    const service = new PageService(
      pageRepo as any,
      {} as any, // pagePermissionRepo
      {} as any, // attachmentRepo
      {} as any, // db
      {} as any, // storageService
      {} as any, // attachmentQueue
      {} as any, // aiQueue
      generalQueue as any,
      {} as any, // eventEmitter
      collaborationGateway as any,
      {} as any, // watcherService
      {} as any, // transclusionService
    );
    // Isolate the canonicalize BINDING: return the raw fixture (a deep clone so
    // canonicalize never mutates the caller's object) instead of running the
    // real markdown/HTML/JSON parse + schema validation.
    jest
      .spyOn(service as any, 'parseProsemirrorContent')
      .mockImplementation(async (content: any) => structuredClone(content));
    jest.spyOn(service as any, 'nextPagePosition').mockResolvedValue('a0');

    return { service, getInsertedContent: () => insertedContent, getYjsPayload: () => yjsPayload };
  }

  it('createPage (full write) canonicalizes footnotes into reference order', async () => {
    const { service, getInsertedContent } = makeService();
    await service.create('user-id', 'workspace-id', {
      spaceId: 'space-id',
      content: outOfOrderFull(),
      format: 'json',
    } as any);
    // Definitions reordered to reference order [b, a].
    expect(listDefIds(getInsertedContent())).toEqual(['b', 'a']);
  });

  it("updatePageContent operation 'replace' canonicalizes footnotes", async () => {
    const { service, getYjsPayload } = makeService();
    await service.updatePageContent(
      'page-id',
      outOfOrderFull(),
      'replace' as any,
      'json' as any,
      { id: 'user-id' } as any,
    );
    expect(getYjsPayload().operation).toBe('replace');
    expect(listDefIds(getYjsPayload().prosemirrorJson)).toEqual(['b', 'a']);
  });

  it("append of a definition-only fragment is NOT canonicalized (footnote preserved, not dropped)", async () => {
    const { service, getYjsPayload } = makeService();
    await service.updatePageContent(
      'page-id',
      defOnlyFragment(),
      'append' as any,
      'json' as any,
      { id: 'user-id' } as any,
    );
    // Canonicalizing a reference-less fragment would DROP the whole list; the
    // fragment must pass through untouched so the merge keeps the definition.
    expect(getYjsPayload().operation).toBe('append');
    expect(hasFootnotesList(getYjsPayload().prosemirrorJson)).toBe(true);
    expect(listDefIds(getYjsPayload().prosemirrorJson)).toEqual(['a']);
  });

  it('prepend of a reference-reuse fragment is NOT canonicalized (no synthesized garbage list)', async () => {
    const { service, getYjsPayload } = makeService();
    await service.updatePageContent(
      'page-id',
      refReuseFragment(),
      'prepend' as any,
      'json' as any,
      { id: 'user-id' } as any,
    );
    // Canonicalizing would synthesize a bogus empty footnotesList for the reused
    // reference; the fragment must pass through with no list at all.
    expect(getYjsPayload().operation).toBe('prepend');
    expect(hasFootnotesList(getYjsPayload().prosemirrorJson)).toBe(false);
  });
});
