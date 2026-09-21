import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  docsCanonicallyEqual,
} from 'docmost-client';

// Resolve fixtures relative to this test file so the test is CWD-independent.
const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(here, 'fixtures', 'corpus');

/** Run a single document through export -> import -> export. */
async function roundTrip(doc: any) {
  const md1 = convertProseMirrorToMarkdown(doc);
  const doc2 = await markdownToProseMirror(md1);
  const md2 = convertProseMirrorToMarkdown(doc2);
  return { md1, md2, doc2 };
}

describe('round-trip corpus (SPEC §11)', () => {
  // Discover the corpus synchronously at collection time so each fixture gets
  // its own `it` with the file name in the test title.
  const files = readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();

  it('has a non-empty corpus', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const name of files) {
    it(`${name}: markdown byte-stable AND canonically stable`, async () => {
      const doc = JSON.parse(await readFile(join(CORPUS_DIR, name), 'utf8'));
      const { md1, md2, doc2 } = await roundTrip(doc);

      // 1) The byte-stable markdown property git actually needs.
      expect(md2, `${name}: markdown not byte-stable`).toBe(md1);
      // 2) Semantic stability (block ids stripped, default-null normalized).
      expect(
        docsCanonicallyEqual(doc, doc2),
        `${name}: document not canonically stable`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// FORMER KNOWN LIMITATION — now promoted into the green corpus above.
//
// SPEC §11 flagged images and diagrams as high round-trip risk, and
// `image-diagrams.json` (a paragraph + block image + drawio + excalidraw) was
// held out here with `it.fails` because it was not byte-stable on export #1: the
// drawio/excalidraw `align` default "center" materialized on import, so export
// #2 grew a `data-align="center"` suffix.
//
// #293 canon #8 removes that divergence. The diagram family now serializes at
// TOP LEVEL as `![](src)<!--drawio|excalidraw {…}-->`, and — exactly like the
// image `![](src)` form — a default `align:"center"` is OMITTED from the comment
// JSON (it re-materializes as the schema default on import, then is omitted again
// on re-export). The block-image hoist that once left a phantom empty paragraph
// is already absorbed by `stripEmptyParagraphs`. The fixture is therefore now
// BOTH byte-stable AND canonically stable, so it lives in fixtures/corpus as
// `11-image-diagrams.json` and is exercised by the green corpus loop above.
// ---------------------------------------------------------------------------
