import { describe, expect, it } from 'vitest';
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  docsCanonicallyEqual,
} from 'docmost-client';

// ---------------------------------------------------------------------------
// Media / atom node round-trip coverage (audio, video, pdf, attachment, embed,
// youtube). The existing specs (corpus + property test) exercise the EXPORT
// direction of these nodes only; their parseHTML branches (the INVERSE parse of
// the exported HTML) are otherwise unprotected. Each test runs the full
// export -> import -> export pipeline and pins:
//   - the exact md1 byte string the converter emits,
//   - whether md2 is byte-stable (md2 === md1) or grows by a materialized
//     schema default on the first import,
//   - the re-parsed doc2 attrs (NOTE: parseHTML reads via getAttribute and so
//     returns STRINGS for numeric attrs, which is what breaks naive canonical
//     equality), and
//   - docsCanonicallyEqual(doc, doc2) where the spec asserts a specific result.
//
// `convertProseMirrorToMarkdown` requires a full doc ({type:'doc', content:[]}),
// so each spec's `doc=[...]` content array is wrapped via mkDoc().
// ---------------------------------------------------------------------------

/** Wrap a content array (as the specs express `doc`) into a real PM doc. */
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

describe('media atom round-trip (audio/video/pdf/attachment/embed/youtube)', () => {
  // 1. audio with ALL optional attrs ---------------------------------------
  it('audio with src+attachmentId+size: byte-stable, size re-parses to the STRING "9001"', async () => {
    const doc = mkDoc([
      { type: 'audio', attrs: { src: '/a.mp3', attachmentId: 'att-7', size: 9001 } },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    // #293 canon #8 image-form: `![](src)` + the ALWAYS-emitted `audio`
    // discriminator carrying the other attrs as JSON (numerics stringified).
    expect(md1).toBe('![](/a.mp3)<!--audio {"attachmentId":"att-7","size":"9001"}-->');
    // Byte-stable: a second export reproduces the first exactly.
    expect(md2).toBe(md1);

    const audio = findFirst(doc2, 'audio');
    expect(audio).not.toBeNull();
    expect(audio.type).toBe('audio');
    expect(audio.attrs.src).toBe('/a.mp3');
    expect(audio.attrs.attachmentId).toBe('att-7');
    // NOTE: the schema's data-size parseHTML returns getAttribute() -> a STRING,
    // so the number 9001 comes back as the string '9001'.
    expect(audio.attrs.size).toBe('9001');
  });

  // 2. fully-populated video -----------------------------------------------
  it('video with all attrs: byte-stable; numeric attrs re-parse to STRINGS; canonical equality FALSE', async () => {
    const doc = mkDoc([
      {
        type: 'video',
        attrs: {
          src: '/v.mp4',
          alt: 'clip',
          attachmentId: 'att-1',
          width: 640,
          height: 480,
          size: 1234,
          align: 'center',
          aspectRatio: 1.777,
        },
      },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    // #293 canon #8 image-form: align="center" (the schema default) is OMITTED,
    // so the whole optional set except align rides in the `video` comment JSON.
    expect(md1).toBe(
      '![](/v.mp4)<!--video {"alt":"clip","attachmentId":"att-1","width":"640","height":"480","size":"1234","aspectRatio":"1.777"}-->',
    );
    expect(md2).toBe(md1);

    const video = findFirst(doc2, 'video');
    expect(video).not.toBeNull();
    expect(video.attrs.alt).toBe('clip');
    // All numeric attrs come back as STRINGS via getAttribute().
    expect(video.attrs.width).toBe('640');
    expect(video.attrs.height).toBe('480');
    expect(video.attrs.size).toBe('1234');
    expect(video.attrs.aspectRatio).toBe('1.777');

    // Byte-stable export but NOT canonically equal: the numeric width/height/
    // size/aspectRatio came back as strings, so deep-equal of the canonical
    // forms fails (align:'center' is normalized away, the numbers are not).
    expect(docsCanonicallyEqual(doc, doc2)).toBe(false);
  });

  // 3. minimal video (only src) --------------------------------------------
  it('minimal video (src only): the discriminator is STILL emitted; byte-stable; round-trips to VIDEO not image', async () => {
    const doc = mkDoc([{ type: 'video', attrs: { src: '/v.mp4' } }]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    // #293 canon #8: the comment is the type discriminator, so it is emitted even
    // with no extra attrs (name-only). Without it a bare `![](src)` would be read
    // as an `image`. align="center" default is omitted, so the form is byte-stable
    // (unlike the old div-form, which gained data-align="center" on import).
    expect(md1).toBe('![](/v.mp4)<!--video-->');
    expect(md2).toBe(md1);

    // Critically: it round-trips to a VIDEO node, NOT an image.
    const video = findFirst(doc2, 'video');
    expect(video).not.toBeNull();
    expect(video.type).toBe('video');
    expect(findFirst(doc2, 'image')).toBeNull();
    expect(video.attrs.src).toBe('/v.mp4');

    // align:'center' is normalized away via KNOWN_DEFAULTS.video, so the
    // documents ARE canonically equal.
    expect(docsCanonicallyEqual(doc, doc2)).toBe(true);
  });

  // 4. pdf with no numeric attrs (positive control) -------------------------
  it('pdf with src+name+attachmentId (no numerics): byte- AND canonically-stable', async () => {
    const doc = mkDoc([
      { type: 'pdf', attrs: { src: '/d.pdf', name: 'd.pdf', attachmentId: 'att-9' } },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    // #293 canon #8 link-form: `[name](src)` + the `pdf` discriminator; the id
    // link (attachmentId) is data-loss-critical and rides in the comment JSON.
    expect(md1).toBe('[d.pdf](/d.pdf)<!--pdf {"attachmentId":"att-9"}-->');
    expect(md2).toBe(md1);

    const pdf = findFirst(doc2, 'pdf');
    expect(pdf).not.toBeNull();
    expect(pdf.attrs.src).toBe('/d.pdf');
    expect(pdf.attrs.name).toBe('d.pdf');
    expect(pdf.attrs.attachmentId).toBe('att-9');

    // No numeric attrs to coerce to strings, so the round-trip is BOTH byte- and
    // canonically-stable (the positive control vs. the numeric-divergence cases).
    expect(docsCanonicallyEqual(doc, doc2)).toBe(true);
  });

  // 5. attachment with numeric size ----------------------------------------
  it('attachment with url+name+mime+size+attachmentId: byte-stable; size STRING; canonical FALSE', async () => {
    const doc = mkDoc([
      {
        type: 'attachment',
        attrs: {
          url: '/f.zip',
          name: 'f.zip',
          mime: 'application/zip',
          size: 512,
          attachmentId: 'att-3',
        },
      },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    // #293 canon #8 link-form: url is the target, name the visible text, and
    // mime/size/attachmentId ride in the `attachment` discriminator comment.
    expect(md1).toBe(
      '[f.zip](/f.zip)<!--attachment {"mime":"application/zip","size":"512","attachmentId":"att-3"}-->',
    );
    expect(md2).toBe(md1);

    const att = findFirst(doc2, 'attachment');
    expect(att).not.toBeNull();
    expect(att.attrs.url).toBe('/f.zip');
    expect(att.attrs.name).toBe('f.zip');
    expect(att.attrs.mime).toBe('application/zip');
    expect(att.attrs.attachmentId).toBe('att-3');
    // data-attachment-size parseHTML -> getAttribute() -> STRING.
    expect(att.attrs.size).toBe('512');

    // The numeric size coerced to a string breaks canonical equality.
    expect(docsCanonicallyEqual(doc, doc2)).toBe(false);
  });

  // 6. embed WITH explicit width/height/align (byte-stable) ----------------
  it('embed with explicit src+provider+align+width+height: byte-stable; width/height STRINGS', async () => {
    const doc = mkDoc([
      {
        type: 'embed',
        attrs: {
          src: 'https://x.com/e',
          provider: 'iframe',
          align: 'left',
          width: 600,
          height: 400,
        },
      },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    // #293 canon #8 link-form: provider is the visible text; the non-default
    // align/width/height (defaults center/800/600) ride in the comment JSON.
    expect(md1).toBe(
      '[iframe](https://x.com/e)<!--embed {"align":"left","width":"600","height":"400"}-->',
    );
    expect(md2).toBe(md1);

    const embed = findFirst(doc2, 'embed');
    expect(embed).not.toBeNull();
    expect(embed.attrs.src).toBe('https://x.com/e');
    expect(embed.attrs.provider).toBe('iframe');
    expect(embed.attrs.align).toBe('left');
    // data-width / data-height parseHTML -> getAttribute() -> STRINGS.
    expect(embed.attrs.width).toBe('600');
    expect(embed.attrs.height).toBe('400');
  });

  // 7. minimal embed (only src+provider) -----------------------------------
  it('minimal embed (src+provider): discriminator still emitted; byte-stable; defaults materialize as NUMBERS 800/600', async () => {
    const doc = mkDoc([
      { type: 'embed', attrs: { src: 'https://x.com/e', provider: 'iframe' } },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    // #293 canon #8: align/width/height are all at their schema defaults
    // (center/800/600), so the discriminator is name-only. Unlike the old
    // div-form (which grew three data-* attrs on import), the md-form OMITS the
    // defaults on BOTH exports, so it is byte-stable from export #1.
    expect(md1).toBe('[iframe](https://x.com/e)<!--embed-->');
    expect(md2).toBe(md1);

    const embed = findFirst(doc2, 'embed');
    expect(embed).not.toBeNull();
    expect(embed.type).toBe('embed');
    // Round-trips to EMBED, not a plain link.
    expect(embed.attrs.provider).toBe('iframe');
    expect(embed.attrs.align).toBe('center');
    // NOTE: these come from the addAttributes default (NOT parseHTML), so they
    // are the NUMBERS 800/600 — parseHTML only runs when the attribute is present.
    expect(embed.attrs.width).toBe(800);
    expect(embed.attrs.height).toBe(600);
  });

  // 8. youtube with src+width+height+align ---------------------------------
  it('youtube with src+width+height+align(right): byte-stable; width/height STRINGS; canonical FALSE', async () => {
    const doc = mkDoc([
      {
        type: 'youtube',
        attrs: {
          src: 'https://youtu.be/abc',
          width: 560,
          height: 315,
          align: 'right',
        },
      },
    ]);
    const { md1, md2, doc2 } = await roundTrip(doc);

    // #293 canon #8 image-form: width/height/align(right) ride in the `youtube`
    // discriminator comment (align "right" is non-default so it is kept).
    expect(md1).toBe(
      '![](https://youtu.be/abc)<!--youtube {"width":"560","height":"315","align":"right"}-->',
    );
    expect(md2).toBe(md1);

    const yt = findFirst(doc2, 'youtube');
    expect(yt).not.toBeNull();
    expect(yt.attrs.src).toBe('https://youtu.be/abc');
    expect(yt.attrs.align).toBe('right');
    // data-width / data-height parseHTML -> getAttribute() -> STRINGS.
    expect(yt.attrs.width).toBe('560');
    expect(yt.attrs.height).toBe('315');

    // Numeric width/height coerced to strings; align='right' is non-default so
    // it is kept (not in KNOWN_DEFAULTS.youtube's normalization). Canonical FALSE.
    expect(docsCanonicallyEqual(doc, doc2)).toBe(false);
  });
});
