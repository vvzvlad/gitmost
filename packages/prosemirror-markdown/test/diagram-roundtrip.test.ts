import { describe, expect, it } from 'vitest';
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  docsCanonicallyEqual,
} from 'docmost-client';

// Helper mirroring the convention in markdown-converter.test.ts: wrap atoms in
// a top-level doc node so convertProseMirrorToMarkdown (which requires
// content.content) walks them.
const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });

describe('diagram round-trip (docmost-schema diagramAttributes)', () => {
  // SPEC case 1: drawio carrying the full numeric-attr surface
  // (data-width/data-height/data-size/data-aspect-ratio) that it shares with
  // audio/video/pdf but which no fixture exercises on a diagram node.
  it('drawio round-trips numeric attrs, coercing number -> string via getAttribute', async () => {
    const input = doc({
      type: 'drawio',
      attrs: {
        src: '/d.drawio',
        attachmentId: 'att-1',
        width: 640,
        height: 480,
        size: 1234,
        aspectRatio: 1.777,
        align: 'center',
      },
    });

    const md1 = convertProseMirrorToMarkdown(input);
    const doc2 = await markdownToProseMirror(md1);
    const md2 = convertProseMirrorToMarkdown(doc2);

    // #293 canon #8 (image-form): src is the markdown target; every OTHER
    // non-default attr rides in the ALWAYS-emitted `drawio` discriminator comment
    // (numerics stringified, stable key order width/height/size/aspectRatio then
    // attachmentId). align="center" is the schema default, so it is OMITTED.
    expect(md1).toBe(
      '![](/d.drawio)<!--drawio {"width":"640","height":"480","size":"1234","aspectRatio":"1.777","attachmentId":"att-1"}-->',
    );

    // A second export reproduces the first byte-for-byte: align="center"
    // re-materializes as the schema default on import and is omitted again.
    expect(md2).toBe(md1);

    // Re-import coerces every numeric attr to a STRING because parseHTML reads
    // them via getAttribute(). This is the gap the reviewer flagged: the
    // number -> string coercion on a diagram node is otherwise untested.
    const attrs2 = doc2.content[0].attrs;
    expect(attrs2.width).toBe('640');
    expect(attrs2.height).toBe('480');
    expect(attrs2.size).toBe('1234');
    expect(attrs2.aspectRatio).toBe('1.777');
    expect(typeof attrs2.width).toBe('string');
    expect(typeof attrs2.aspectRatio).toBe('string');
    // String attrs pass through unchanged.
    expect(attrs2.align).toBe('center');
    expect(attrs2.attachmentId).toBe('att-1');

    // Canonically NOT equal: the numeric -> string coercion survives
    // canonicalization (only align='center' is normalized away via
    // KNOWN_DEFAULTS.drawio), so 640 !== '640' makes the docs differ.
    expect(docsCanonicallyEqual(input, doc2)).toBe(false);
  });

  // SPEC case 2: minimal excalidraw atom with ONLY string attrs (no align, no
  // numeric attrs). #293 canon #8 image-form: title/alt ride in the comment JSON
  // (JSON-encoded, NOT HTML-escaped) and align='center' is omitted as the
  // schema default — so the one-time divergence the OLD div-form had is GONE.
  it('excalidraw round-trips title/alt via the discriminator comment (byte-stable, align default omitted)', async () => {
    const input = doc({
      type: 'excalidraw',
      attrs: {
        src: '/e.excalidraw',
        title: 'My "Diagram"',
        alt: 'a&b',
      },
    });

    const md1 = convertProseMirrorToMarkdown(input);
    const doc2 = await markdownToProseMirror(md1);
    const md2 = convertProseMirrorToMarkdown(doc2);

    // #293 canon #8: src in the target; title/alt in the ALWAYS-emitted
    // `excalidraw` comment as compact JSON (the " in title is JSON-escaped as \",
    // the & in alt stays literal — JSON, not HTML). No align emitted (default).
    expect(md1).toBe(
      '![](/e.excalidraw)<!--excalidraw {"title":"My \\"Diagram\\"","alt":"a&b"}-->',
    );

    // Byte-stable: align='center' re-materializes as the schema default on import
    // and is omitted again on export #2, so md2 === md1 (no diagram quirk now).
    expect(md2).toBe(md1);

    // Re-import decodes the JSON payload back to the original characters.
    const attrs2 = doc2.content[0].attrs;
    expect(attrs2.title).toBe('My "Diagram"');
    expect(attrs2.alt).toBe('a&b');
    expect(attrs2.align).toBe('center');

    // Canonically EQUAL: align='center' is normalized away via
    // KNOWN_DEFAULTS.excalidraw, and title/alt are non-default strings that
    // survive on both sides, so the docs are semantically equal.
    expect(docsCanonicallyEqual(input, doc2)).toBe(true);
  });
});
