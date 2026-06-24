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

/** Matches a footnote DEFINITION line: `[^id]: text` (id + text captured). */
const DEF_RE = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
/** Matches every footnote REFERENCE `[^id]` in a line (global; id captured). */
const REF_RE_G = /\[\^([^\]\s]+)\]/g;
/** Opening/closing fence marker (``` or ~~~). */
const FENCE_RE = /^(\s*)(`{3,}|~{3,})/;

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

/** Scan a line for every `[^id]` reference, invoking `onRef(id)` for each. */
function forEachReference(line: string, onRef: (id: string) => void): void {
  REF_RE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE_G.exec(line)) !== null) onRef(m[1]);
}

/**
 * Analyze the footnotes in a Markdown string. Pure; safe to call on any body.
 */
export function analyzeFootnotes(markdown: string): FootnoteDiagnostics {
  const lines = markdown.split("\n");

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

  let fence: string | null = null;
  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    // Footnote syntax shown inside a code fence is not real markup.
    if (fence !== null) continue;

    const defM = DEF_RE.exec(line);
    if (defM) {
      const id = defM[1];
      const text = defM[2];
      const arr = defTextsById.get(id);
      if (arr) arr.push(text);
      else defTextsById.set(id, [text]);
      // A definition's TEXT can itself reference another footnote (`[^a]: see
      // [^b]`); count those so such a `[^b]` is not falsely reported dangling.
      forEachReference(text, (rid) => addRef(rid, false));
      continue;
    }

    const inTable = line.trimStart().startsWith("|");
    forEachReference(line, (id) => addRef(id, inTable));
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
