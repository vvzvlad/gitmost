/**
 * Docmost TipTap schema mirror.
 *
 * #293 STEP 5: the extension set (and its parseHTML/renderHTML behaviour) is now
 * owned by the shared `@docmost/prosemirror-markdown` package — the single
 * canonical schema every converter path targets. MCP re-exports it here instead
 * of maintaining its own drifted ~1200-line copy, so the schema can never drift
 * between mcp and the package/git-sync again.
 *
 * `docmostExtensions` comes from the package; `docmostSchema` is derived from it
 * exactly as before (`getSchema(docmostExtensions)`), built ONCE and reused by
 * every consumer (diff, collaboration write-back) so the schema is identical at
 * every call site.
 *
 * The two schema sanitizers (`clampCalloutType`, `sanitizeCssColor`) are
 * re-exported from the package's public barrel — they must NOT be re-defined
 * here, or the mcp copy drifts from the package's (it already had: the local
 * copy had lost the callout-type alias mapping the package applies). Single
 * source of truth in the package (#326 invariant #2).
 */
import { getSchema } from "@tiptap/core";
import {
  docmostExtensions,
  clampCalloutType,
  sanitizeCssColor,
} from "@docmost/prosemirror-markdown";

export { docmostExtensions, clampCalloutType, sanitizeCssColor };

/**
 * The ProseMirror schema for the docmost editor, built ONCE from
 * `docmostExtensions`. Pure and reused by every consumer (diff, collaboration
 * write-back) so the schema can never drift between call sites.
 */
export const docmostSchema = getSchema(docmostExtensions);
