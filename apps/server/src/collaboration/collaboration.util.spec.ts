import * as Y from 'yjs';
import {
  getPageId,
  isEmptyParagraphDoc,
  jsonToNode,
  prosemirrorNodeToYElement,
} from './collaboration.util';
import { Node } from '@tiptap/pm/model';

// Collect every node type name in a ProseMirror Node, in document order.
const collectTypes = (node: Node): string[] => {
  const types: string[] = [];
  node.descendants((n) => {
    types.push(n.type.name);
  });
  return types;
};

// Yjs types throw "Invalid access" until attached to a document, so every
// produced Y element must be inserted into a fragment before it is inspected.
const attach = (json: any): any => {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('default');
  const element = prosemirrorNodeToYElement(json);
  fragment.insert(0, [element as any]);
  return element;
};

describe('getPageId', () => {
  it('extracts the uuid from a "page.<uuid>" document name', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(getPageId(`page.${uuid}`)).toBe(uuid);
  });

  it('returns undefined when the name has no separator', () => {
    // Auth keying depends on this: a malformed name must not yield a stray id.
    expect(getPageId('justaname')).toBeUndefined();
  });

  it('returns the second segment only, ignoring extra dotted parts', () => {
    expect(getPageId('page.abc.def')).toBe('abc');
  });

  it('returns an empty string for a trailing dot', () => {
    expect(getPageId('page.')).toBe('');
  });
});

describe('isEmptyParagraphDoc', () => {
  it('returns true for a doc with a single empty paragraph', () => {
    expect(
      isEmptyParagraphDoc({ type: 'doc', content: [{ type: 'paragraph' }] }),
    ).toBe(true);
  });

  it('returns true for a single paragraph with an empty content array', () => {
    expect(
      isEmptyParagraphDoc({
        type: 'doc',
        content: [{ type: 'paragraph', content: [] }],
      }),
    ).toBe(true);
  });

  it('returns false for a paragraph containing text', () => {
    expect(
      isEmptyParagraphDoc({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'hi' }] },
        ],
      }),
    ).toBe(false);
  });

  it('returns false for a doc with more than one child', () => {
    expect(
      isEmptyParagraphDoc({
        type: 'doc',
        content: [{ type: 'paragraph' }, { type: 'paragraph' }],
      }),
    ).toBe(false);
  });

  it('returns false when the single child is not a paragraph', () => {
    expect(
      isEmptyParagraphDoc({
        type: 'doc',
        content: [{ type: 'heading', attrs: { level: 1 } }],
      }),
    ).toBe(false);
  });

  it('returns false when the root is not a "doc"', () => {
    expect(
      isEmptyParagraphDoc({ type: 'paragraph', content: [] } as any),
    ).toBe(false);
  });

  it('returns false for null / undefined input', () => {
    expect(isEmptyParagraphDoc(null as any)).toBe(false);
    expect(isEmptyParagraphDoc(undefined as any)).toBe(false);
  });
});

describe('stripUnknownNodes (via jsonToNode fallback)', () => {
  it('drops an unknown leaf node while keeping known siblings', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'keep' }] },
        { type: 'totallyUnknownLeaf', attrs: {} },
      ],
    };
    const node = jsonToNode(json);
    // Only the paragraph + its text remain; the unknown leaf is gone.
    expect(collectTypes(node)).toEqual(['paragraph', 'text']);
    expect(node.textContent).toBe('keep');
  });

  it('unwraps an unknown WRAPPER, flattening its children (no content loss)', () => {
    const json = {
      type: 'doc',
      content: [
        {
          type: 'unknownWrapper',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'inside' }] },
          ],
        },
      ],
    };
    const node = jsonToNode(json);
    // The wrapper disappears but its paragraph child is lifted up, not deleted.
    expect(collectTypes(node)).toEqual(['paragraph', 'text']);
    expect(node.textContent).toBe('inside');
  });

  it('leaves an entirely known document untouched', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'b' }],
        },
      ],
    };
    const node = jsonToNode(json);
    expect(collectTypes(node)).toEqual([
      'paragraph',
      'text',
      'heading',
      'text',
    ]);
    expect(node.textContent).toBe('ab');
  });

  it('drops an unknown inline nested inside a known node', () => {
    const json = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'weirdInline' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    };
    const node = jsonToNode(json);
    // The unknown inline is silently removed; surrounding text survives.
    expect(node.textContent).toBe('ab');
    expect(collectTypes(node)).toEqual(['paragraph', 'text', 'text']);
  });
});

describe('prosemirrorNodeToYElement', () => {
  it('produces a Y.XmlText carrying mark attrs as format on a marked text node', () => {
    const ytext = attach({
      type: 'text',
      text: 'hi',
      marks: [{ type: 'bold', attrs: { level: 2 } }, { type: 'italic' }],
    });
    const delta = ytext.toDelta();
    expect(delta).toHaveLength(1);
    expect(delta[0].insert).toBe('hi');
    // mark.attrs is used when present, otherwise `true` (the `|| true` path).
    expect(delta[0].attributes).toEqual({
      bold: { level: 2 },
      italic: true,
    });
    expect(ytext.length).toBe(2);
  });

  it('produces a plain Y.XmlText with no format for an unmarked text node', () => {
    const ytext = attach({ type: 'text', text: 'plain' });
    const delta = ytext.toDelta();
    expect(delta).toEqual([{ insert: 'plain' }]);
    expect(ytext.length).toBe(5);
  });

  it('sets element attributes, skipping null and undefined values', () => {
    const element = attach({
      type: 'paragraph',
      attrs: { textAlign: 'left', indent: 0, anchorId: null, ghost: undefined },
      content: [{ type: 'text', text: 'abc' }],
    });
    expect(element.nodeName).toBe('paragraph');
    expect(element.getAttribute('textAlign')).toBe('left');
    // indent is 0 (falsy but defined) -> must still be set.
    expect(element.getAttribute('indent')).toBe(0);
    // null / undefined attrs are skipped, never set.
    expect(element.getAttribute('anchorId')).toBeUndefined();
    expect(element.getAttribute('ghost')).toBeUndefined();
    expect(element.getAttributes()).toEqual({ textAlign: 'left', indent: 0 });
  });

  it('creates an element with no attributes when attrs is absent', () => {
    const element = attach({ type: 'horizontalRule' });
    expect(element.nodeName).toBe('horizontalRule');
    expect(element.getAttributes()).toEqual({});
    expect(element.length).toBe(0);
  });

  it('recurses into nested content preserving order', () => {
    const element = attach({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
      ],
    });
    // Two child paragraphs, in original order.
    expect(element.length).toBe(2);
    expect(element.get(0).get(0).toString()).toBe('one');
    expect(element.get(1).get(0).toString()).toBe('two');
  });
});
