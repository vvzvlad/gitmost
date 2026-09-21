import { diffWordsWithSpace, diffChars } from "diff";
import { IComment } from "@/features/comment/types/comment.types";

// Whether the suggested-edit (#315) "Apply" button should be shown for a
// comment: it must carry a suggestion, not already be applied or resolved, be a
// top-level comment, and the viewer must be able to edit the page.
export function canShowApply(comment: IComment, canEdit?: boolean): boolean {
  return Boolean(
    canEdit &&
      comment.suggestedText &&
      !comment.suggestionAppliedAt &&
      !comment.resolvedAt &&
      !comment.parentCommentId,
  );
}

// One contiguous run of text within a suggestion's "before" or "after" line.
// `changed` marks the fragment that actually differs from the other side, so
// the UI can emphasise only the intraline delta (git/GitHub-style) instead of
// the whole line.
export interface Segment {
  text: string;
  changed: boolean;
}

// A pure "before -> after" intraline diff (#331): the old line split into
// common vs. removed-and-changed fragments, and the new line split into common
// vs. added-and-changed fragments. Concatenating each side's `text` reproduces
// the original strings.
export interface SuggestionDiff {
  old: Segment[];
  new: Segment[];
}

// Push a segment, coalescing runs of the same `changed` flag on the same side
// so the render emits as few spans as possible and tests stay predictable.
function pushSegment(segments: Segment[], text: string, changed: boolean): void {
  if (text === "") return;
  const last = segments[segments.length - 1];
  if (last && last.changed === changed) {
    last.text += text;
  } else {
    segments.push({ text, changed });
  }
}

// Compute an intraline diff between the old `selection` and the new
// `suggestedText` of a suggestion. PURE — no React, no DOM, no I/O.
//
// Hybrid word + char algorithm (per #331):
//   1. `diffWordsWithSpace` yields word-granular parts [{value, added, removed}].
//   2. An ADJACENT removed+added pair (a word replacement) is refined with
//      `diffChars`: shared characters stay common, differing characters are
//      marked `changed` on their respective side. This is what keeps a
//      one-letter edit (заведем -> заведём) from highlighting the whole word.
//   3. A lone `added` (insertion) or lone `removed` (deletion) marks the whole
//      fragment `changed`.
//   4. An unchanged part is `common` on both sides.
//
// Rejected alternatives: pure `diffChars` is noisy on word swaps; pure
// `diffWordsWithSpace` highlights the whole word rather than the changed letter.
export function computeSuggestionDiff(
  oldStr: string,
  newStr: string,
): SuggestionDiff {
  const oldSegments: Segment[] = [];
  const newSegments: Segment[] = [];

  const parts = diffWordsWithSpace(oldStr, newStr);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const next = parts[i + 1];

    // A word replacement: a removed part immediately followed by an added part
    // (or the reverse). Refine it character-by-character so only the differing
    // letters are highlighted while shared letters stay common.
    const isReplacementPair =
      next &&
      ((part.removed && next.added) || (part.added && next.removed));

    if (isReplacementPair) {
      const removedPart = part.removed ? part : next;
      const addedPart = part.added ? part : next;

      const charParts = diffChars(removedPart.value, addedPart.value);
      for (const cp of charParts) {
        if (cp.added) {
          pushSegment(newSegments, cp.value, true);
        } else if (cp.removed) {
          pushSegment(oldSegments, cp.value, true);
        } else {
          // Shared character: common on both sides.
          pushSegment(oldSegments, cp.value, false);
          pushSegment(newSegments, cp.value, false);
        }
      }

      i++; // consume the paired part as well
      continue;
    }

    if (part.added) {
      // Lone insertion: only present in the new line, wholly changed.
      pushSegment(newSegments, part.value, true);
    } else if (part.removed) {
      // Lone deletion: only present in the old line, wholly changed.
      pushSegment(oldSegments, part.value, true);
    } else {
      // Unchanged: common on both sides.
      pushSegment(oldSegments, part.value, false);
      pushSegment(newSegments, part.value, false);
    }
  }

  return { old: oldSegments, new: newSegments };
}

// Whether the suggested-edit (#329) "Не применять" (Dismiss) button should be
// shown. Dismiss does NOT change the page text (so it needs only canComment, not
// canEdit), BUT a childless dismiss IRREVERSIBLY hard-deletes the comment, so the
// server gates it on comment-owner-OR-space-admin (#338 F5). The button must
// mirror that authz or a non-owner non-admin sees a live Dismiss that always
// 403s → red error. Hence isOwnerOrAdmin is required IN ADDITION to canComment.
// Same not-applied/not-resolved/top-level conditions as Apply.
export function canShowDismiss(
  comment: IComment,
  canComment?: boolean,
  isOwnerOrAdmin?: boolean,
): boolean {
  return Boolean(
    canComment &&
      isOwnerOrAdmin &&
      comment.suggestedText &&
      !comment.suggestionAppliedAt &&
      !comment.resolvedAt &&
      !comment.parentCommentId,
  );
}
