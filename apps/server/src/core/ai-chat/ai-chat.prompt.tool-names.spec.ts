import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROMPT_TOOL_NAMES } from './ai-chat.prompt';
// The real shared registry, imported from source (same approach as the
// SHARED_TOOL_SPECS contract spec) so tool names are validated against exactly
// what @docmost/mcp ships.
import { SHARED_TOOL_SPECS } from '../../../../../packages/mcp/src/tool-specs';
import { INLINE_TOOL_TIERS, LOAD_TOOLS_NAME } from './tools/tool-tiers';

/**
 * #448 guard — a nonexistent tool name in ai-chat.prompt.ts must fail a test.
 *
 * The in-app prompt refers to a handful of tools BY NAME in its guidance notes
 * (e.g. PAGE_CHANGED_NOTE tells the agent to re-read via getPage and edit via
 * editPageText/patchNode/insertNode/deleteNode). Before #448 those names were
 * hard-coded inline with NO guard, so renaming a tool left the agent stale
 * instructions and nothing failed.
 *
 * APPROACH — substitution + a precise source scan:
 *  1. The names now flow through the exported `PROMPT_TOOL_NAMES` const; this
 *     test asserts every value there is a REAL in-app tool.
 *  2. A precise scan of the two guidance-note string literals in the source
 *     catches any BARE tool-name token added directly (bypassing the const):
 *     every camelCase token in those notes must be either a real tool name or an
 *     explicitly-allowlisted ordinary English/camelCase word.
 *
 * The scan is deliberately narrow (only the guidance notes, only camelCase
 * tokens) so it never false-positives on prose, and the allowlist of non-tool
 * words is tiny and explicit.
 */

// The authoritative set of real in-app tool names: shared-registry inAppKeys +
// per-layer INLINE tool keys + the loadTools meta-tool.
const VALID_TOOL_NAMES = new Set<string>([
  ...Object.values(SHARED_TOOL_SPECS).map((s) => s.inAppKey),
  ...Object.keys(INLINE_TOOL_TIERS),
  LOAD_TOOLS_NAME,
]);

// Ordinary camelCase words that appear in the guidance-note prose and are NOT
// tool names. Keep this list minimal and explicit — anything camelCase in a note
// that is neither a real tool nor here fails the scan.
const NON_TOOL_WORDS = new Set<string>([]);

describe('#448 prompt tool-name guard', () => {
  it('every PROMPT_TOOL_NAMES value is a real in-app tool', () => {
    for (const [key, name] of Object.entries(PROMPT_TOOL_NAMES)) {
      expect(typeof name).toBe('string');
      expect(VALID_TOOL_NAMES.has(name)).toBe(true);
      // Sanity: the const key and its value are the same token (the const is a
      // name->name map used purely to route mentions through one guarded place).
      expect(key).toBe(name);
    }
  });

  it('the guidance notes reference no bogus tool name (bare-literal scan)', () => {
    const src = readFileSync(
      join(__dirname, 'ai-chat.prompt.ts'),
      'utf8',
    );

    // Extract the two guidance-note string constants and the current-page
    // selection line — the only places the prompt names tools in prose. Each is
    // a `const NAME =` ... `;` block; we scan their raw text for camelCase
    // tokens. (Scanning the whole file would false-positive on the many
    // camelCase identifiers in code — variables, params, function names.)
    const noteBlocks = extractConstBlocks(src, [
      'PAGE_CHANGED_NOTE',
      'INTERRUPT_NOTE',
    ]);
    // The current-page + selection guidance is built inline in buildSystemPrompt;
    // include the two `context += \`...\`` template lines that mention tools.
    const contextLines = src
      .split('\n')
      .filter((l) => l.includes('context +=') && l.includes('getCurrentPage'))
      .join('\n');

    // Neutralize string-literal escape sequences (\n, \t, ...) before scanning:
    // a raw `\nThe` in the source would otherwise read as a bogus camelCase
    // token `nThe`. Replace any backslash-escape with a space.
    const scanText = (noteBlocks + '\n' + contextLines).replace(/\\./g, ' ');
    expect(scanText.length).toBeGreaterThan(0); // guard against a bad extraction

    // camelCase token = lowercase start, at least one internal uppercase letter.
    const tokens = new Set(scanText.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) ?? []);
    const offenders = [...tokens].filter(
      (t) => !VALID_TOOL_NAMES.has(t) && !NON_TOOL_WORDS.has(t),
    );
    expect(offenders).toEqual([]);
  });

  it('the specific tools the notes rely on are all real (regression pins)', () => {
    for (const name of [
      'getPage',
      'editPageText',
      'patchNode',
      'insertNode',
      'deleteNode',
      'getCurrentPage',
      'loadTools',
    ]) {
      expect(VALID_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

/**
 * Extract the raw text of one or more top-level `const NAME = ... ;` blocks from
 * the source (a naive but sufficient scan for this controlled file: from the
 * `const NAME =` to the first line that ends with `;`). Returns the blocks
 * concatenated.
 */
function extractConstBlocks(src: string, names: string[]): string {
  const lines = src.split('\n');
  const out: string[] = [];
  for (const name of names) {
    const start = lines.findIndex((l) => l.trimStart().startsWith(`const ${name} =`));
    if (start < 0) continue;
    for (let i = start; i < lines.length; i++) {
      out.push(lines[i]);
      if (lines[i].trimEnd().endsWith(';')) break;
    }
  }
  return out.join('\n');
}
