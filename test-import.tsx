// Diagnostic / reproduction script for the /pages/import 400 regression
// (see docs/backlog/pages-import-broken-400.md).
//
// Run from repo root:  npx tsx test-import.tsx
//
// Exercises the full server-side import chain directly against source:
//   markdownToHtml (@docmost/editor-ext)
//   -> cheerio load + normalizeImportHtml
//   -> generateJSON (happy-dom DOMParser -> ProseMirror) with all 44 tiptapExtensions
//
// Also pokes the happy-dom cleanup behavior used in generateJSON's `finally`
// block, to rule out the "finally throw masks the real result" footgun.
//
// If this script throws on some input, that input reproduces the prod 400 and
// the thrown error is the real cause hidden behind "Error processing file content".

import { markdownToHtml } from '@docmost/editor-ext';
import { generateJSON } from './apps/server/src/common/helpers/prosemirror/html/generateJSON';
import { tiptapExtensions } from './apps/server/src/collaboration/collaboration.util';
import { load } from 'cheerio';
import { normalizeImportHtml } from './apps/server/src/integrations/import/utils/import-formatter';
import { Window } from 'happy-dom';

// Mirror the exact server chain for a .md file.
async function processMd(md: string): Promise<any> {
  const html = await markdownToHtml(md);
  const $ = load(html);
  normalizeImportHtml($, $.root());
  const normalizedHtml = $.html() || '';
  return generateJSON(normalizedHtml, tiptapExtensions);
}

let failures = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`✅ ${name}`))
    .catch((err: any) => {
      failures++;
      console.error(`❌ ${name}: ${err?.name}: ${err?.message}`);
      if (err?.stack) console.error(err.stack);
    });
}

async function main() {
  console.log('=== Section A: full import chain (markdown -> PM JSON) ===');
  const mdCases: Array<[string, string]> = [
    ['basic markdown', '# Title\n\n**bold** and *italic*.\n\n- a\n- b\n'],
    ['empty', ''],
    ['whitespace only', '   \n\n   '],
    ['just title', '# Title'],
    ['html entities', '# Test & <code> "quotes" </code>'],
    ['nested lists', '# T\n\n- a\n  - b\n  - c\n- d'],
    ['task list', '- [ ] todo\n- [x] done'],
    ['emoji', '# Test 🎉 emoji ✓'],
    ['cyrillic', '# Заголовок\n\nТекст на русском'],
    ['code with special chars', '```\nconst x = "<>&"\n```'],
    ['link', '[example](https://example.com)'],
    ['image', '![alt](https://example.com/img.png)'],
    ['table', '| Col1 | Col2 |\n|------|------|\n| v1 | v2 |\n'],
    ['blockquote', '> quote\n> line2'],
  ];
  for (const [name, md] of mdCases) {
    await check(`md: ${name}`, () => processMd(md));
  }

  console.log('\n=== Section B: raw generateJSON on tricky HTML fragments ===');
  const htmlCases: Array<[string, string]> = [
    ['plain paragraph', '<p>Hello</p>'],
    ['deeply nested divs', '<div><div><div><p>deep</p></div></div></div>'],
    ['unclosed-ish tags (browser-fixup)', '<b>bold<i>both</b>italic'],
    ['empty body', ''],
    ['only whitespace nodes', '   \n  '],
  ];
  for (const [name, html] of htmlCases) {
    await check(`html: ${name}`, () => generateJSON(html, tiptapExtensions));
  }

  console.log('\n=== Section C: happy-dom cleanup behavior (generateJSON finally block) ===');
  await check('sync finally with abort()/close() returns SUCCESS', () => {
    // Mirrors generateJSON.ts finally exactly: no await, no try/catch.
    const w = new Window();
    try {
      const dp = new w.DOMParser();
      dp.parseFromString('<!DOCTYPE html><html><body><p>hi</p></body></html>', 'text/html');
    } finally {
      w.happyDOM.abort();
      w.happyDOM.close();
    }
  });
  await check('abort()/close() are Promises (async) in happy-dom 20', async () => {
    const w = new Window();
    const a = w.happyDOM.abort();
    const c = w.happyDOM.close();
    if (!(a instanceof Promise) || !(c instanceof Promise)) {
      throw new Error('expected abort/close to return Promises');
    }
    await a;
    await c;
  });
  await check('double close() does not throw', () => {
    const w = new Window();
    w.happyDOM.close();
    w.happyDOM.close();
  });

  console.log(`\n=== Done. Failures: ${failures} ===`);
  if (failures > 0) process.exitCode = 1;
}

main();
