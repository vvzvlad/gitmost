import { describe, expect, it } from 'vitest';
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
} from 'docmost-client';

// ---------------------------------------------------------------------------
// #293 canon #8 — media family -> md-form + discriminator comment.
//
// Ten node types move their TOP-LEVEL form from raw schema HTML to a readable
// markdown target plus a discriminator `<!--name {…}-->` comment whose NAME
// selects the node type:
//
//   IMAGE-FORM  `![](src)<!--name …-->`   youtube, video, audio, drawio, excalidraw
//   LINK-FORM   `[text](src)<!--name …-->` pdf, attachment, embed
//   STANDALONE  `<!--name …-->`            pageEmbed (pageembed), transclusionReference (transclusion)
//
// For EACH type this suite pins (1) a representative node -> exact md + a
// byte-stable, lossless round-trip; (2) a MINIMAL node -> the discriminator is
// STILL emitted and re-imports as the right TYPE (never an image/link); (3) the
// same node INSIDE a column -> the schema-HTML form (no comment). Plus the
// discriminator-integrity contract (a bare image / bare link with NO comment)
// and fail-open behavior. The columns/raw-HTML form is the git-sync data path's
// SAFETY net: a comment node is dropped inside a raw-HTML block, so these MUST
// stay schema HTML there or the node vanishes.
// ---------------------------------------------------------------------------

const mkDoc = (content: any[]) => ({ type: 'doc', content });

/** export -> import -> export, returning both markdowns and the re-parsed doc. */
async function roundTrip(doc: any) {
  const md1 = convertProseMirrorToMarkdown(doc);
  const doc2 = await markdownToProseMirror(md1);
  const md2 = convertProseMirrorToMarkdown(doc2);
  return { md1, md2, doc2 };
}

/** Find the first node of a given type anywhere in a PM doc tree. */
const findFirst = (node: any, type: string): any => {
  if (node && node.type === type) return node;
  for (const child of node?.content || []) {
    const hit = findFirst(child, type);
    if (hit) return hit;
  }
  return null;
};

/** True when any text run in the tree carries a `link` MARK (links are marks). */
const hasLinkMark = (node: any): boolean => {
  if (Array.isArray(node?.marks) && node.marks.some((m: any) => m?.type === 'link'))
    return true;
  return (node?.content || []).some((c: any) => hasLinkMark(c));
};

/** Wrap a single node in a two-column layout (the raw-HTML container path). */
const inColumn = (node: any) =>
  mkDoc([
    {
      type: 'columns',
      attrs: { layout: 'two_equal' },
      content: [
        { type: 'column', content: [node] },
        { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
      ],
    },
  ]);

// ---------------------------------------------------------------------------
// Per-type: exact md, lossless byte-stable round-trip, minimal-node
// discriminator, and the in-column schema-HTML form.
// ---------------------------------------------------------------------------

describe('#293 #8 IMAGE-FORM: youtube', () => {
  it('representative node -> exact md + lossless byte-stable round-trip', async () => {
    const doc = mkDoc([
      { type: 'youtube', attrs: { src: 'https://youtu.be/abc', width: 560, height: 315, align: 'right' } },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);
    expect(md1).toBe(
      '![](https://youtu.be/abc)<!--youtube {"width":"560","height":"315","align":"right"}-->',
    );
    expect(md2).toBe(md1);
    const yt = findFirst(doc2, 'youtube');
    expect(yt).not.toBeNull();
    expect(yt.attrs.src).toBe('https://youtu.be/abc');
    expect(yt.attrs.width).toBe('560');
    expect(yt.attrs.height).toBe('315');
    expect(yt.attrs.align).toBe('right');
  });

  it('minimal node -> discriminator STILL emitted; round-trips to youtube (NOT image)', async () => {
    const { md1, doc2 } = await roundTrip(mkDoc([{ type: 'youtube', attrs: { src: '/y' } }]));
    expect(md1).toBe('![](/y)<!--youtube-->');
    expect(findFirst(doc2, 'youtube')).not.toBeNull();
    expect(findFirst(doc2, 'image')).toBeNull();
  });

  it('inside a column -> schema-HTML form (data-type="youtube", NO comment)', async () => {
    const { md1, doc2 } = await roundTrip(
      inColumn({ type: 'youtube', attrs: { src: '/y', width: 560 } }),
    );
    expect(md1).toContain('data-type="youtube"');
    expect(md1).toContain('data-src="/y"');
    expect(md1).not.toContain('<!--youtube');
    expect(findFirst(doc2, 'youtube')).not.toBeNull();
  });
});

describe('#293 #8 IMAGE-FORM: video', () => {
  it('representative node -> exact md + lossless byte-stable round-trip (attachmentId preserved)', async () => {
    const doc = mkDoc([
      {
        type: 'video',
        attrs: { src: '/v.mp4', alt: 'clip', attachmentId: 'ATT_V', width: 640, height: 480, size: 1234, aspectRatio: 1.777 },
      },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);
    expect(md1).toBe(
      '![](/v.mp4)<!--video {"alt":"clip","attachmentId":"ATT_V","width":"640","height":"480","size":"1234","aspectRatio":"1.777"}-->',
    );
    expect(md2).toBe(md1);
    const v = findFirst(doc2, 'video');
    expect(v.attrs.src).toBe('/v.mp4');
    expect(v.attrs.alt).toBe('clip');
    // Data-loss-critical id link survives.
    expect(v.attrs.attachmentId).toBe('ATT_V');
    expect(v.attrs.aspectRatio).toBe('1.777');
  });

  it('minimal node -> discriminator STILL emitted; round-trips to video (NOT image)', async () => {
    const { md1, doc2 } = await roundTrip(mkDoc([{ type: 'video', attrs: { src: '/v.mp4' } }]));
    expect(md1).toBe('![](/v.mp4)<!--video-->');
    expect(findFirst(doc2, 'video')).not.toBeNull();
    expect(findFirst(doc2, 'image')).toBeNull();
  });

  it('inside a column -> schema-HTML <video> form (NO comment)', async () => {
    const { md1, doc2 } = await roundTrip(
      inColumn({ type: 'video', attrs: { src: '/v.mp4', attachmentId: 'ATT_V' } }),
    );
    expect(md1).toContain('<video ');
    expect(md1).toContain('data-attachment-id="ATT_V"');
    expect(md1).not.toContain('<!--video');
    expect(findFirst(doc2, 'video').attrs.attachmentId).toBe('ATT_V');
  });
});

describe('#293 #8 IMAGE-FORM: audio', () => {
  it('representative node -> exact md + lossless byte-stable round-trip', async () => {
    const { md1, md2, doc2 } = await roundTrip(
      mkDoc([{ type: 'audio', attrs: { src: '/a.mp3', attachmentId: 'ATT_A', size: 9001 } }]),
    );
    expect(md1).toBe('![](/a.mp3)<!--audio {"attachmentId":"ATT_A","size":"9001"}-->');
    expect(md2).toBe(md1);
    const a = findFirst(doc2, 'audio');
    expect(a.attrs.src).toBe('/a.mp3');
    expect(a.attrs.attachmentId).toBe('ATT_A');
    expect(a.attrs.size).toBe('9001');
  });

  it('minimal node -> discriminator STILL emitted; round-trips to audio (NOT image)', async () => {
    const { md1, doc2 } = await roundTrip(mkDoc([{ type: 'audio', attrs: { src: '/a.mp3' } }]));
    expect(md1).toBe('![](/a.mp3)<!--audio-->');
    expect(findFirst(doc2, 'audio')).not.toBeNull();
    expect(findFirst(doc2, 'image')).toBeNull();
  });

  it('inside a column -> schema-HTML <audio> form (NO comment)', async () => {
    const { md1, doc2 } = await roundTrip(inColumn({ type: 'audio', attrs: { src: '/a.mp3' } }));
    expect(md1).toContain('<audio ');
    expect(md1).not.toContain('<!--audio');
    expect(findFirst(doc2, 'audio')).not.toBeNull();
  });
});

describe('#293 #8 IMAGE-FORM: drawio / excalidraw (NAME discriminates the two)', () => {
  for (const type of ['drawio', 'excalidraw'] as const) {
    it(`${type}: representative node -> exact md + lossless byte-stable round-trip`, async () => {
      const { md1, md2, doc2 } = await roundTrip(
        mkDoc([{ type, attrs: { src: `/d.${type}`, title: 'T', width: 640, attachmentId: 'ATT_D' } }]),
      );
      expect(md1).toBe(`![](/d.${type})<!--${type} {"title":"T","width":"640","attachmentId":"ATT_D"}-->`);
      expect(md2).toBe(md1);
      const d = findFirst(doc2, type);
      expect(d).not.toBeNull();
      expect(d.attrs.src).toBe(`/d.${type}`);
      expect(d.attrs.title).toBe('T');
      expect(d.attrs.attachmentId).toBe('ATT_D');
      // The OTHER diagram type must NOT appear (NAME is the discriminator).
      expect(findFirst(doc2, type === 'drawio' ? 'excalidraw' : 'drawio')).toBeNull();
    });

    it(`${type}: minimal node -> discriminator STILL emitted; round-trips to ${type} (NOT image)`, async () => {
      const { md1, doc2 } = await roundTrip(mkDoc([{ type, attrs: { src: `/d.${type}` } }]));
      expect(md1).toBe(`![](/d.${type})<!--${type}-->`);
      expect(findFirst(doc2, type)).not.toBeNull();
      expect(findFirst(doc2, 'image')).toBeNull();
    });

    it(`${type}: inside a column -> schema-HTML data-type="${type}" form (NO comment)`, async () => {
      const { md1, doc2 } = await roundTrip(
        inColumn({ type, attrs: { src: `/d.${type}`, attachmentId: 'ATT_D' } }),
      );
      expect(md1).toContain(`data-type="${type}"`);
      expect(md1).not.toContain(`<!--${type}`);
      expect(findFirst(doc2, type).attrs.attachmentId).toBe('ATT_D');
    });
  }
});

describe('#293 #8 LINK-FORM: pdf', () => {
  it('representative node -> exact md + lossless byte-stable round-trip', async () => {
    const { md1, md2, doc2 } = await roundTrip(
      mkDoc([{ type: 'pdf', attrs: { src: '/d.pdf', name: 'd.pdf', attachmentId: 'ATT_P', size: 2048 } }]),
    );
    expect(md1).toBe('[d.pdf](/d.pdf)<!--pdf {"attachmentId":"ATT_P","size":"2048"}-->');
    expect(md2).toBe(md1);
    const p = findFirst(doc2, 'pdf');
    expect(p.attrs.src).toBe('/d.pdf');
    expect(p.attrs.name).toBe('d.pdf');
    expect(p.attrs.attachmentId).toBe('ATT_P');
    expect(p.attrs.size).toBe('2048');
  });

  it('minimal node -> discriminator STILL emitted; round-trips to pdf (NOT a plain link)', async () => {
    const { md1, doc2 } = await roundTrip(mkDoc([{ type: 'pdf', attrs: { src: '/d.pdf', name: 'd.pdf' } }]));
    expect(md1).toBe('[d.pdf](/d.pdf)<!--pdf-->');
    expect(findFirst(doc2, 'pdf')).not.toBeNull();
    expect(hasLinkMark(doc2)).toBe(false);
  });

  it('a filename with []\\ is escaped in the link text and round-trips losslessly', async () => {
    const { md1, doc2 } = await roundTrip(mkDoc([{ type: 'pdf', attrs: { src: '/x', name: 'a]b[c.pdf' } }]));
    expect(md1).toBe('[a\\]b\\[c.pdf](/x)<!--pdf-->');
    expect(findFirst(doc2, 'pdf').attrs.name).toBe('a]b[c.pdf');
  });

  it('a filename with markdown-ACTIVE punctuation round-trips byte- AND value-stable', async () => {
    // The link label is parsed as inline content, so emphasis/code/strike/
    // autolink/entity/image markers would be consumed and lost via a.textContent
    // if not escaped. Each of these names would corrupt without the full escape
    // (e.g. `report *v2*.pdf` -> `report v2.pdf`). Assert both value AND byte
    // stability (md2 === md1) so a real filename cannot silently churn a vault.
    for (const name of [
      'report *v2*.pdf',
      'draft _final_.pdf',
      'use `code`.pdf',
      'a~~b~~.pdf',
      'tag <x> & y.pdf',
      'amp &amp; here.pdf',
      '![shot](x).pdf',
      // Canon inline-extension triggers (F5): math `$`, highlight `==`, footnote
      // `^[` — a filename carrying these must not become a math/highlight/footnote
      // node on import.
      'data $A$.csv',
      'q3 ==final==.pdf',
      '5$ and 10$.pdf',
      'note ^[x].pdf',
    ]) {
      const { md1, md2, doc2 } = await roundTrip(mkDoc([{ type: 'pdf', attrs: { src: '/x', name } }]));
      expect(md2).toBe(md1); // byte-stable, no churn
      expect(findFirst(doc2, 'pdf').attrs.name).toBe(name); // exact value preserved
    }
  });

  it('inside a column -> schema-HTML data-type="pdf" form (NO comment)', async () => {
    const { md1, doc2 } = await roundTrip(
      inColumn({ type: 'pdf', attrs: { src: '/d.pdf', name: 'd.pdf', attachmentId: 'ATT_P' } }),
    );
    expect(md1).toContain('data-type="pdf"');
    expect(md1).toContain('data-name="d.pdf"');
    expect(md1).not.toContain('<!--pdf');
    expect(findFirst(doc2, 'pdf').attrs.attachmentId).toBe('ATT_P');
  });
});

describe('#293 #8 LINK-FORM: attachment', () => {
  it('representative node -> exact md + lossless byte-stable round-trip', async () => {
    const { md1, md2, doc2 } = await roundTrip(
      mkDoc([{ type: 'attachment', attrs: { url: '/f.zip', name: 'f.zip', mime: 'application/zip', size: 512, attachmentId: 'ATT_Z' } }]),
    );
    expect(md1).toBe(
      '[f.zip](/f.zip)<!--attachment {"mime":"application/zip","size":"512","attachmentId":"ATT_Z"}-->',
    );
    expect(md2).toBe(md1);
    const a = findFirst(doc2, 'attachment');
    expect(a.attrs.url).toBe('/f.zip');
    expect(a.attrs.name).toBe('f.zip');
    expect(a.attrs.mime).toBe('application/zip');
    expect(a.attrs.attachmentId).toBe('ATT_Z');
  });

  it('minimal node (url only) -> empty text + discriminator; round-trips to attachment (NOT a link)', async () => {
    const { md1, doc2 } = await roundTrip(mkDoc([{ type: 'attachment', attrs: { url: '/f.zip' } }]));
    expect(md1).toBe('[](/f.zip)<!--attachment-->');
    const a = findFirst(doc2, 'attachment');
    expect(a).not.toBeNull();
    expect(a.attrs.url).toBe('/f.zip');
    expect(hasLinkMark(doc2)).toBe(false);
  });

  it('inside a column -> schema-HTML data-type="attachment" form (NO comment)', async () => {
    const { md1, doc2 } = await roundTrip(
      inColumn({ type: 'attachment', attrs: { url: '/f.zip', name: 'f.zip', attachmentId: 'ATT_Z' } }),
    );
    expect(md1).toContain('data-type="attachment"');
    expect(md1).toContain('data-attachment-url="/f.zip"');
    expect(md1).not.toContain('<!--attachment');
    expect(findFirst(doc2, 'attachment').attrs.attachmentId).toBe('ATT_Z');
  });
});

describe('#293 #8 LINK-FORM: embed', () => {
  it('representative node -> exact md + lossless byte-stable round-trip', async () => {
    const { md1, md2, doc2 } = await roundTrip(
      mkDoc([{ type: 'embed', attrs: { src: 'https://x.com/e', provider: 'iframe', align: 'left', width: 600, height: 400 } }]),
    );
    expect(md1).toBe('[iframe](https://x.com/e)<!--embed {"align":"left","width":"600","height":"400"}-->');
    expect(md2).toBe(md1);
    const e = findFirst(doc2, 'embed');
    expect(e.attrs.src).toBe('https://x.com/e');
    expect(e.attrs.provider).toBe('iframe');
    expect(e.attrs.align).toBe('left');
  });

  it('minimal node -> discriminator STILL emitted; round-trips to embed (NOT a link)', async () => {
    const { md1, doc2 } = await roundTrip(
      mkDoc([{ type: 'embed', attrs: { src: 'https://x.com/e', provider: 'iframe' } }]),
    );
    expect(md1).toBe('[iframe](https://x.com/e)<!--embed-->');
    const e = findFirst(doc2, 'embed');
    expect(e).not.toBeNull();
    expect(e.attrs.provider).toBe('iframe');
    expect(hasLinkMark(doc2)).toBe(false);
  });

  it('inside a column -> schema-HTML data-type="embed" form (NO comment)', async () => {
    const { md1, doc2 } = await roundTrip(
      inColumn({ type: 'embed', attrs: { src: 'https://x.com/e', provider: 'iframe' } }),
    );
    expect(md1).toContain('data-type="embed"');
    expect(md1).toContain('data-provider="iframe"');
    expect(md1).not.toContain('<!--embed');
    expect(findFirst(doc2, 'embed').attrs.provider).toBe('iframe');
  });
});

describe('#293 #8 STANDALONE: pageEmbed', () => {
  it('representative node -> exact md + lossless byte-stable round-trip (sourcePageId preserved)', async () => {
    const { md1, md2, doc2 } = await roundTrip(
      mkDoc([{ type: 'pageEmbed', attrs: { sourcePageId: 'PAGE_X' } }]),
    );
    expect(md1).toBe('<!--pageembed {"sourcePageId":"PAGE_X"}-->');
    expect(md2).toBe(md1);
    const pe = findFirst(doc2, 'pageEmbed');
    expect(pe).not.toBeNull();
    expect(pe.attrs.sourcePageId).toBe('PAGE_X');
  });

  it('minimal node -> name-only discriminator; round-trips to pageEmbed', async () => {
    const { md1, doc2 } = await roundTrip(mkDoc([{ type: 'pageEmbed', attrs: {} }]));
    expect(md1).toBe('<!--pageembed-->');
    expect(findFirst(doc2, 'pageEmbed')).not.toBeNull();
  });

  it('inside a column -> schema-HTML data-type="pageEmbed" form (NO comment)', async () => {
    const { md1, doc2 } = await roundTrip(
      inColumn({ type: 'pageEmbed', attrs: { sourcePageId: 'PAGE_X' } }),
    );
    expect(md1).toContain('data-type="pageEmbed"');
    expect(md1).toContain('data-source-page-id="PAGE_X"');
    expect(md1).not.toContain('<!--pageembed');
    expect(findFirst(doc2, 'pageEmbed').attrs.sourcePageId).toBe('PAGE_X');
  });
});

describe('#293 #8 STANDALONE: transclusionReference', () => {
  it('representative node -> exact md + lossless byte-stable round-trip (both id links preserved)', async () => {
    const { md1, md2, doc2 } = await roundTrip(
      mkDoc([{ type: 'transclusionReference', attrs: { sourcePageId: 'PAGE_X', transclusionId: 'TR_Y' } }]),
    );
    expect(md1).toBe('<!--transclusion {"sourcePageId":"PAGE_X","transclusionId":"TR_Y"}-->');
    expect(md2).toBe(md1);
    const tr = findFirst(doc2, 'transclusionReference');
    expect(tr).not.toBeNull();
    expect(tr.attrs.sourcePageId).toBe('PAGE_X');
    expect(tr.attrs.transclusionId).toBe('TR_Y');
  });

  it('minimal node -> name-only discriminator; round-trips to transclusionReference', async () => {
    const { md1, doc2 } = await roundTrip(mkDoc([{ type: 'transclusionReference', attrs: {} }]));
    expect(md1).toBe('<!--transclusion-->');
    expect(findFirst(doc2, 'transclusionReference')).not.toBeNull();
  });

  it('inside a column -> schema-HTML data-type="transclusionReference" form (NO comment)', async () => {
    const { md1, doc2 } = await roundTrip(
      inColumn({ type: 'transclusionReference', attrs: { sourcePageId: 'PAGE_X', transclusionId: 'TR_Y' } }),
    );
    expect(md1).toContain('data-type="transclusionReference"');
    expect(md1).toContain('data-transclusion-id="TR_Y"');
    expect(md1).not.toContain('<!--transclusion');
    expect(findFirst(doc2, 'transclusionReference').attrs.transclusionId).toBe('TR_Y');
  });
});

// ---------------------------------------------------------------------------
// Discriminator integrity: the NAME is the ONLY type selector. A bare markdown
// target with NO following comment is NEVER sniffed into a media type.
// ---------------------------------------------------------------------------

describe('#293 #8 discriminator integrity (no comment -> never a media type)', () => {
  it('a bare ![](url) with NO comment is an IMAGE, never youtube/video/etc.', async () => {
    const doc2 = await markdownToProseMirror('![](https://youtu.be/abc)');
    expect(findFirst(doc2, 'image')).not.toBeNull();
    for (const t of ['youtube', 'video', 'audio', 'drawio', 'excalidraw']) {
      expect(findFirst(doc2, t)).toBeNull();
    }
  });

  it('a bare [text](src) with NO comment is a plain link, never pdf/attachment/embed', async () => {
    const doc2 = await markdownToProseMirror('[report.pdf](/files/report.pdf)');
    // The link MARK survives; NO media node materializes.
    expect(hasLinkMark(doc2)).toBe(true);
    for (const t of ['pdf', 'attachment', 'embed']) {
      expect(findFirst(doc2, t)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-open: malformed/misplaced discriminators never crash and never corrupt.
// ---------------------------------------------------------------------------

describe('#293 #8 fail-open', () => {
  it('malformed JSON after an image-form target does not throw; stays an image', async () => {
    const md = '![](u.png)<!--youtube {bad-->';
    const doc2 = await markdownToProseMirror(md);
    // The comment is inert (parseAttachedComment returns null), so the img is
    // left as a plain image and nothing throws.
    expect(findFirst(doc2, 'image')).not.toBeNull();
    expect(findFirst(doc2, 'youtube')).toBeNull();
    // Byte-stable on the way back out (no phantom growth).
    const back = convertProseMirrorToMarkdown(doc2);
    expect(convertProseMirrorToMarkdown(await markdownToProseMirror(back))).toBe(back);
  });

  it('malformed JSON after a link-form target does not throw; stays a plain link', async () => {
    const doc2 = await markdownToProseMirror('[f](/x)<!--attachment {bad}-->');
    expect(findFirst(doc2, 'attachment')).toBeNull();
    expect(hasLinkMark(doc2)).toBe(true);
  });

  it('a malformed standalone discriminator does not throw and materializes no atom', async () => {
    const doc2 = await markdownToProseMirror('<!--pageembed {oops-->');
    expect(findFirst(doc2, 'pageEmbed')).toBeNull();
    expect(findFirst(doc2, 'transclusionReference')).toBeNull();
  });

  it('an unknown key in a valid comment is ignored (fail-open); the node still materializes', async () => {
    const doc2 = await markdownToProseMirror('![](/y)<!--youtube {"unknownKey":1,"width":"560"}-->');
    const yt = findFirst(doc2, 'youtube');
    expect(yt).not.toBeNull();
    expect(yt.attrs.width).toBe('560');
    expect(yt.attrs).not.toHaveProperty('unknownKey');
  });

  it('an image-form discriminator with NO adjacent <img> is inert', async () => {
    // `text <!--youtube-->` puts the comment inside a <p> next to text, not an
    // <img>: wrong element -> inert, no youtube node, no crash.
    const doc2 = await markdownToProseMirror('some text <!--youtube-->');
    expect(findFirst(doc2, 'youtube')).toBeNull();
    expect(findFirst(doc2, 'paragraph')).not.toBeNull();
  });

  it('a standalone media discriminator in ATTACHED position (next to text) is inert', async () => {
    const doc2 = await markdownToProseMirror('inline text <!--pageembed {"sourcePageId":"p1"}-->');
    expect(findFirst(doc2, 'pageEmbed')).toBeNull();
    expect(findFirst(doc2, 'paragraph')).not.toBeNull();
  });
});
