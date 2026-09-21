import { describe, expect, it } from 'vitest';
import { findInvalidNode } from '../src/lib/node-ops.js';

// findInvalidNode (#409): a depth-first SHAPE gate that turns the encoder's
// opaque `Unknown node type: undefined` into a path-anchored, pre-write
// diagnostic. It flags the FIRST node whose `type` is absent/non-string or not
// a known Docmost schema node, or that carries an unknown mark; returns null for
// a well-formed doc.

const doc = (...content: any[]) => ({ type: 'doc', content });
const para = (...content: any[]) => ({
  type: 'paragraph',
  attrs: { id: 'p1' },
  content,
});
const text = (value: string, marks?: any[]) => {
  const node: any = { type: 'text', text: value };
  if (marks) node.marks = marks;
  return node;
};

describe('findInvalidNode', () => {
  it('returns null for a fully valid document', () => {
    const good = doc(
      para(text('hello ', [{ type: 'bold' }]), text('world')),
      {
        type: 'heading',
        attrs: { id: 'h1', level: 2 },
        content: [text('Title')],
      },
    );
    expect(findInvalidNode(good)).toBeNull();
  });

  it('flags a NESTED typeless text leaf with a path-precise summary', () => {
    // A text leaf written as {"text":"foo"} with no "type":"text" — the dominant
    // `Unknown node type: undefined` cause.
    const bad = doc(
      para(text('ok')),
      para({ text: 'foo', marks: [] } as any),
    );
    const hit = findInvalidNode(bad);
    expect(hit).not.toBeNull();
    // Second paragraph (index 1), first child (index 0).
    expect(hit!.path).toBe('node.content[1].content[0]');
    expect(hit!.summary).toContain('node.content[1].content[0]');
    expect(hit!.summary).toContain('missing "type"');
    expect(hit!.summary).toContain('keys: text, marks');
    expect(hit!.summary).toContain('did you mean {"type": "text", ...}');
  });

  it('flags a non-string type (e.g. numeric)', () => {
    const bad = doc(para({ type: 123, content: [] } as any));
    const hit = findInvalidNode(bad);
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe('node.content[0].content[0]');
    expect(hit!.summary).toContain('missing "type"');
  });

  it('flags an UNKNOWN node type name that is not in the Docmost schema', () => {
    const bad = doc({
      type: 'paragraf', // typo — not a real node
      attrs: { id: 'x' },
      content: [text('hi')],
    });
    const hit = findInvalidNode(bad);
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe('node.content[0]');
    expect(hit!.summary).toContain('unknown node type "paragraf"');
    expect(hit!.summary).toContain('not in the Docmost schema');
  });

  it('flags an UNKNOWN mark type on an otherwise-valid node', () => {
    const bad = doc(para(text('hi', [{ type: 'blink' }])));
    const hit = findInvalidNode(bad);
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe('node.content[0].content[0].marks[0]');
    expect(hit!.summary).toContain('unknown mark type "blink"');
  });

  it('accepts every real Docmost node/mark type it is asked about', () => {
    // Known node (callout) and known marks (italic, code) must NOT be flagged.
    const good = doc({
      type: 'callout',
      attrs: { id: 'c1', type: 'info' },
      content: [para(text('x', [{ type: 'italic' }, { type: 'code' }]))],
    });
    expect(findInvalidNode(good)).toBeNull();
  });

  it('reports the root itself when the root is typeless', () => {
    const hit = findInvalidNode({ content: [] } as any);
    expect(hit).not.toBeNull();
    expect(hit!.path).toBe('node');
  });

  it('is null-safe for non-object input', () => {
    expect(findInvalidNode(null)).toBeNull();
    expect(findInvalidNode(undefined)).toBeNull();
    expect(findInvalidNode('nope' as any)).toBeNull();
  });
});
