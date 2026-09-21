import { describe, expect, it } from 'vitest';
// Import DIRECTLY from src (matching the other converter unit tests), not the
// docmost-client barrel.
import { convertProseMirrorToMarkdown } from '../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../src/lib/markdown-to-prosemirror.js';

// ---------------------------------------------------------------------------
// #293 canon #4: images ALWAYS serialize as `![alt](src)`. Non-default attrs
// ride along in an attached `<!--img {…}-->` comment on the SAME line, which the
// importer materializes back onto the <img> before generateJSON drops it. An
// attr equal to the schema default is NOT emitted. The image align default is
// unified to "center" (matching editor-ext), so bare/center images stay clean
// and only a genuinely non-default alignment (left/right) emits a comment.
//
// In raw-HTML contexts (inside a column / spanned cell) the prior `<img …>` form
// is kept; comments are dropped by the DOM parse stage there.
// ---------------------------------------------------------------------------

const doc = (...nodes: any[]) => ({ type: 'doc', content: nodes });
const image = (attrs: any) => doc({ type: 'image', attrs: { src: '/i.png', ...attrs } });

// Find the first image node anywhere in a PM JSON doc.
function findImage(node: any): any | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'image') return node;
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      const hit = findImage(child);
      if (hit) return hit;
    }
  }
  return null;
}

// Export a doc, re-import it, and hand back the markdown + re-imported image.
async function roundTrip(source: any): Promise<{ md: string; img: any; back: any }> {
  const md = convertProseMirrorToMarkdown(source);
  const back = await markdownToProseMirror(md);
  return { md, img: findImage(back), back };
}

describe('#293 canon #4 — image serialization + attached img-comment', () => {
  it('a bare image (src only) emits `![]()` with NO comment and round-trips', async () => {
    const { md, img } = await roundTrip(image({}));
    expect(md).toBe('![](/i.png)');
    expect(md).not.toContain('<!--img');
    expect(img).toBeTruthy();
    expect(img.attrs.src).toBe('/i.png');
    // align falls back to the unified "center" default on import.
    expect(img.attrs.align).toBe('center');
  });

  it('src + alt emits `![alt](src)` with NO comment and round-trips', async () => {
    const { md, img } = await roundTrip(image({ alt: 'схема' }));
    expect(md).toBe('![схема](/i.png)');
    expect(md).not.toContain('<!--img');
    expect(img.attrs.alt).toBe('схема');
  });

  it('alt with markdown-ACTIVE punctuation is escaped and round-trips byte-stable (F1)', async () => {
    // The alt sits in the `![alt]` label, re-parsed as CommonMark inline on
    // import; without escaping, a bracket/emphasis in a realistic description
    // would make the image node VANISH or collapse emphasis. Assert the image
    // survives with the exact alt AND the markdown is byte-stable on re-export.
    for (const alt of [
      'a]b[c', 'Figure [1]', 'the *new* logo', 'x_y_z', 'see ![img', 'a & b',
      // Canon inline-extension triggers this same package introduces (F5): math
      // `$`, highlight `==`, footnote `^[` — an unescaped one turns the alt into
      // a math/highlight/footnote node on import.
      'x $A$ y', '5$ and 10$', 'use ==bold==', '^[fn]', 'cost $5 == price',
    ]) {
      const md1 = convertProseMirrorToMarkdown(image({ alt }));
      const back = await markdownToProseMirror(md1);
      const img = findImage(back);
      expect(img).toBeTruthy(); // image node did NOT vanish
      expect(img.attrs.alt).toBe(alt); // exact alt preserved
      expect(convertProseMirrorToMarkdown(back)).toBe(md1); // byte-stable
    }
  });

  it('align "center" (the default) emits a bare image, NO comment, round-trips to center', async () => {
    const { md, img } = await roundTrip(image({ align: 'center' }));
    expect(md).toBe('![](/i.png)');
    expect(md).not.toContain('<!--img');
    expect(img.attrs.align).toBe('center');
  });

  it('a null align emits a bare image and re-imports as the "center" default', async () => {
    const { md, img } = await roundTrip(image({ align: null }));
    expect(md).toBe('![](/i.png)');
    expect(img.attrs.align).toBe('center');
  });

  it('align "left" emits an img-comment and round-trips', async () => {
    const { md, img } = await roundTrip(image({ align: 'left' }));
    expect(md).toBe('![](/i.png) <!--img {"align":"left"}-->');
    expect(img.attrs.align).toBe('left');
  });

  it('align "right" emits an img-comment and round-trips', async () => {
    const { md, img } = await roundTrip(image({ align: 'right' }));
    expect(md).toBe('![](/i.png) <!--img {"align":"right"}-->');
    expect(img.attrs.align).toBe('right');
  });

  it('width alone emits a single-key comment and round-trips', async () => {
    const { md, img } = await roundTrip(image({ width: '420' }));
    expect(md).toBe('![](/i.png) <!--img {"width":"420"}-->');
    expect(img.attrs.width).toBe('420');
  });

  it('height alone emits a single-key comment and round-trips', async () => {
    const { md, img } = await roundTrip(image({ height: '300' }));
    expect(md).toBe('![](/i.png) <!--img {"height":"300"}-->');
    expect(img.attrs.height).toBe('300');
  });

  it('size alone emits a single-key comment and round-trips', async () => {
    const { md, img } = await roundTrip(image({ size: '48' }));
    expect(md).toBe('![](/i.png) <!--img {"size":"48"}-->');
    expect(img.attrs.size).toBe('48');
  });

  it('aspectRatio alone emits a single-key comment and round-trips', async () => {
    const { md, img } = await roundTrip(image({ aspectRatio: '1.777' }));
    expect(md).toBe('![](/i.png) <!--img {"aspectRatio":"1.777"}-->');
    expect(img.attrs.aspectRatio).toBe('1.777');
  });

  it('attachmentId (the file link — data-loss critical) rides in the comment and round-trips', async () => {
    const { md, img } = await roundTrip(image({ attachmentId: 'att-777' }));
    expect(md).toBe('![](/i.png) <!--img {"attachmentId":"att-777"}-->');
    expect(img.attrs.attachmentId).toBe('att-777');
  });

  it('caption rides in the comment and round-trips', async () => {
    const { md, img } = await roundTrip(image({ caption: 'Рис. 1' }));
    expect(md).toBe('![](/i.png) <!--img {"caption":"Рис. 1"}-->');
    expect(img.attrs.caption).toBe('Рис. 1');
  });

  it('title rides in the comment and round-trips', async () => {
    const { md, img } = await roundTrip(image({ title: 'a tooltip' }));
    expect(md).toBe('![](/i.png) <!--img {"title":"a tooltip"}-->');
    expect(img.attrs.title).toBe('a tooltip');
  });

  it('multiple attrs at once appear in the stable key order and round-trip', async () => {
    const { md, img } = await roundTrip(
      image({
        alt: 'схема',
        width: '420',
        height: '300',
        align: 'left',
        size: '48',
        aspectRatio: '1.5',
        attachmentId: 'att-1',
        caption: 'Рис. 1',
        title: 'tip',
      }),
    );
    // Stable order: width, height, align, size, aspectRatio, attachmentId, caption, title.
    expect(md).toBe(
      '![схема](/i.png) <!--img {"width":"420","height":"300","align":"left","size":"48","aspectRatio":"1.5","attachmentId":"att-1","caption":"Рис. 1","title":"tip"}-->',
    );
    expect(img.attrs.width).toBe('420');
    expect(img.attrs.height).toBe('300');
    expect(img.attrs.align).toBe('left');
    expect(img.attrs.size).toBe('48');
    expect(img.attrs.aspectRatio).toBe('1.5');
    expect(img.attrs.attachmentId).toBe('att-1');
    expect(img.attrs.caption).toBe('Рис. 1');
    expect(img.attrs.title).toBe('tip');
  });

  // MANDATORY (#293 canon #4): a caption containing the comment-closing `-->`
  // must be encoded so it can never break the HTML comment; JSON.parse restores
  // it byte-exact on import.
  it('a caption containing `-->` is escaped, does not break the comment, and round-trips byte-exact', async () => {
    const caption = 'see --> here';
    const { md, img } = await roundTrip(image({ caption }));
    // The `--` pair is defused as the JSON unicode escape, so the literal
    // caption text is NOT present verbatim and the comment cannot close early.
    expect(md).toContain('\\u002d\\u002d');
    expect(md).not.toContain('see --> here');
    // The comment still closes exactly once, at the very end.
    expect(md.endsWith('-->')).toBe(true);
    // Restored byte-exact on re-import.
    expect(img.attrs.caption).toBe('see --> here');
  });

  // A whole raw comment-closer as the caption is the adversarial edge.
  it('a caption that IS `-->` round-trips byte-exact', async () => {
    const { img } = await roundTrip(image({ caption: '-->' }));
    expect(img.attrs.caption).toBe('-->');
  });

  it('an image INSIDE a column keeps the raw <img> form (no img-comment) and round-trips', async () => {
    const source = doc({
      type: 'columns',
      attrs: { layout: 'two' },
      content: [
        {
          type: 'column',
          content: [
            {
              type: 'image',
              attrs: { src: '/i.png', alt: 'c', width: '320', align: 'left', attachmentId: 'att-9' },
            },
          ],
        },
        { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'r' }] }] },
      ],
    });
    const md = convertProseMirrorToMarkdown(source);
    expect(md).toContain('<img');
    expect(md).not.toContain('<!--img');
    const back = await markdownToProseMirror(md);
    const img = findImage(back);
    expect(img).toBeTruthy();
    expect(img.attrs.width).toBe('320');
    expect(img.attrs.align).toBe('left');
    expect(img.attrs.attachmentId).toBe('att-9');
  });

  // ---- Fail-open behavior ---------------------------------------------------

  it('malformed JSON in an img-comment is ignored; the image keeps default attrs (no crash)', async () => {
    const back = await markdownToProseMirror('![](/i.png) <!--img {bad-->');
    const img = findImage(back);
    expect(img).toBeTruthy();
    expect(img.attrs.width).toBeNull();
    expect(img.attrs.align).toBe('center'); // default
  });

  it('a STANDALONE img-comment (no adjacent <img>) is inert — no image materialized', async () => {
    const back = await markdownToProseMirror('<!--img {"width":10}-->');
    expect(findImage(back)).toBeNull();
  });

  it('unknown keys in a valid img-comment are ignored; the image is otherwise default', async () => {
    const back = await markdownToProseMirror('![](/i.png) <!--img {"zzz":1}-->');
    const img = findImage(back);
    expect(img).toBeTruthy();
    expect(img.attrs.width).toBeNull();
    expect(img.attrs.align).toBe('center');
    expect((img.attrs as any).zzz).toBeUndefined();
  });

  it('NUMERIC sizing attrs serialize as strings and round-trip byte-stably', () => {
    // The import side reads DOM attributes back as strings, so a numeric source
    // value must be stringified in the payload or the first round-trip churns
    // `420 -> "420"` (a spurious one-time git diff). Assert the emitted string
    // form AND that a second export is byte-identical to the first.
    const d = image({ width: 420, height: 200, size: 80, aspectRatio: 1.5 });
    const md1 = convertProseMirrorToMarkdown(d);
    expect(md1).toBe(
      '![](/i.png) <!--img {"width":"420","height":"200","size":"80","aspectRatio":"1.5"}-->',
    );
    return markdownToProseMirror(md1).then((back) => {
      const md2 = convertProseMirrorToMarkdown(back);
      expect(md2).toBe(md1); // byte-stable: no 420 -> "420" churn
    });
  });
});
