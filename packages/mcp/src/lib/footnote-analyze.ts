/**
 * Footnote diagnostics for imported Markdown (issue #166).
 *
 * A PURE, fence-aware text scan (independent of the Markdown->ProseMirror
 * conversion path, so it reports the same problems for `create_page`,
 * `update_page` and `import_page_markdown`). It never changes the document — the
 * importer still creates the page; this only surfaces footnote problems to the
 * caller so an agent can fix its own markup instead of shipping broken footnotes.
 *
 * Detected problems:
 *  - danglingReferences: a `[^id]` reference with no `[^id]:` definition.
 *  - emptyDefinitions:   a `[^id]:` whose (kept) text is empty/whitespace.
 *  - duplicateDefinitions: an id defined by two or more `[^id]:` lines (only the
 *    first is kept on import — first-wins; see extractFootnotes).
 *  - referencesInTables: a `[^id]` marker found in a GFM table row (heuristic:
 *    the line, trimmed, starts with `|`) — footnotes in table cells often do not
 *    render as expected.
 */

import {
  lexFootnoteLines,
  forEachFootnoteReference,
} from "./footnote-lex.js";

export interface FootnoteDiagnostics {
  /** Reference ids (distinct, document order) with no matching definition. */
  danglingReferences: string[];
  /** Definition ids whose first (kept) text is empty/whitespace. */
  emptyDefinitions: string[];
  /** Ids defined by two or more `[^id]:` lines (only the first is kept). */
  duplicateDefinitions: string[];
  /** Reference ids found inside a GFM table row (heuristic). */
  referencesInTables: string[];
  /** Human-readable warning lines for the tool result (one per problem class). */
  warnings: string[];
}

/**
 * Analyze the footnotes in a Markdown string. Pure; safe to call on any body.
 */
export function analyzeFootnotes(markdown: string): FootnoteDiagnostics {
  // Distinct reference ids in first-appearance order, plus the set of ids seen
  // inside a table row.
  const refIds: string[] = [];
  const refIdSet = new Set<string>();
  const referencesInTables = new Set<string>();
  const addRef = (id: string, inTable: boolean) => {
    if (!refIdSet.has(id)) {
      refIdSet.add(id);
      refIds.push(id);
    }
    if (inTable) referencesInTables.add(id);
  };

  // Definition texts per id, in first-appearance order of the id.
  const defTextsById = new Map<string, string[]>();

  // Same lexer the importer uses, so the analysis matches exactly what import
  // keeps/strips (#166): fenced lines are inert, definition lines are pulled.
  for (const tok of lexFootnoteLines(markdown)) {
    if (tok.inFence) continue;
    if (tok.definition) {
      const { id, text } = tok.definition;
      const arr = defTextsById.get(id);
      if (arr) arr.push(text);
      else defTextsById.set(id, [text]);
      // A definition's TEXT can itself reference another footnote (`[^a]: see
      // [^b]`); count those so such a `[^b]` is not falsely reported dangling.
      forEachFootnoteReference(text, (rid) => addRef(rid, false));
      continue;
    }
    const inTable = tok.line.trimStart().startsWith("|");
    forEachFootnoteReference(tok.line, (id) => addRef(id, inTable));
  }

  const danglingReferences = refIds.filter((id) => !defTextsById.has(id));
  const duplicateDefinitions: string[] = [];
  const emptyDefinitions: string[] = [];
  for (const [id, texts] of defTextsById) {
    if (texts.length >= 2) duplicateDefinitions.push(id);
    // First-wins: the kept definition is the first one; flag it if it is blank.
    if ((texts[0] ?? "").trim().length === 0) emptyDefinitions.push(id);
  }
  const tableRefs = [...referencesInTables];

  const warnings: string[] = [];
  const list = (ids: string[]) => ids.map((id) => `[^${id}]`).join(", ");
  if (danglingReferences.length > 0) {
    warnings.push(
      `Footnote reference(s) with no matching definition: ${list(danglingReferences)} (each will render as an empty footnote in the editor).`,
    );
  }
  if (emptyDefinitions.length > 0) {
    warnings.push(
      `Footnote definition(s) with empty text: ${list(emptyDefinitions)}.`,
    );
  }
  if (duplicateDefinitions.length > 0) {
    warnings.push(
      `Footnote id(s) defined more than once (only the first definition was kept): ${list(duplicateDefinitions)}.`,
    );
  }
  if (tableRefs.length > 0) {
    warnings.push(
      `Footnote marker(s) inside a table row (footnotes in table cells may not render as expected): ${list(tableRefs)}.`,
    );
  }

  return {
    danglingReferences,
    emptyDefinitions,
    duplicateDefinitions,
    referencesInTables: tableRefs,
    warnings,
  };
}

/**
 * The optional `footnoteWarnings` field for a page-write tool result: present
 * (with the warning lines) only when `markdown` has footnote problems, omitted
 * otherwise. One helper so all three call sites (create/update/import) attach the
 * field identically. Spread into the result: `{ ...result, ...footnoteWarningsField(text) }`.
 */
export function footnoteWarningsField(markdown: string): {
  footnoteWarnings?: string[];
} {
  const { warnings } = analyzeFootnotes(markdown);
  return warnings.length > 0 ? { footnoteWarnings: warnings } : {};
}
