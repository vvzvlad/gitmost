import { IComment } from "@/features/comment/types/comment.types";

// A visual-only series threshold: this many agent suggested-edits sharing one
// run key collapse under a single RunHeader. A group of one renders as a plain
// standalone card (no header). Policy constant — no env override.
export const GROUP_MIN = 2;

// One rendered unit of the top-level comment list: either a collapsed agent-run
// group (>= GROUP_MIN suggested-edits from the same chat+role) or a single
// comment (a human thread, an agent thread without an edit, or a lone edit).
export interface AgentRunGroup {
  kind: "run";
  key: string;
  comments: IComment[];
}
export interface SingleUnit {
  kind: "single";
  comment: IComment;
}
export type CommentRenderUnit = AgentRunGroup | SingleUnit;

// The grouping key of a top-level agent suggested-edit, or null when the comment
// is not a groupable edit. The key pins BOTH the AI chat and the acting role
// (`aiChatId + ":" + agent.name`) so two roles running in the same chat do not
// collapse under one header. A comment with `aiChatId == null` (an external MCP
// agent) has no chat to group by — it is deliberately never groupable and always
// renders as a single card (a time-bucketed synthetic run would split/merge runs
// arbitrarily and choke on ISO `createdAt`). PURE.
export function runKey(c: IComment): string | null {
  if (
    c.createdSource === "agent" &&
    c.suggestedText != null &&
    !c.parentCommentId &&
    c.aiChatId != null &&
    c.agent?.name
  ) {
    return `${c.aiChatId}:${c.agent.name}`;
  }
  return null;
}

// Collapse an ORDERED list of top-level comments into render units, preserving
// list order: a run is emitted in place of its FIRST member (later members are
// absorbed), everything else stays a single unit. Grouping is computed over the
// snapshot handed in; a streamed page / WS update may later promote a single
// edit into a run as more members arrive — that is acceptable (purely visual).
// PURE — no React/DOM, no mutation of the input.
export function groupAgentRuns(comments: IComment[]): CommentRenderUnit[] {
  // First pass: tally groupable edits per key so we know which keys clear
  // GROUP_MIN before we start emitting.
  const counts = new Map<string, number>();
  for (const c of comments) {
    const key = runKey(c);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const emitted = new Set<string>();
  const units: CommentRenderUnit[] = [];
  for (const c of comments) {
    const key = runKey(c);
    if (key && (counts.get(key) ?? 0) >= GROUP_MIN) {
      // Emit the whole run once, at the position of its first member; skip the
      // absorbed later members.
      if (emitted.has(key)) continue;
      emitted.add(key);
      units.push({
        kind: "run",
        key,
        comments: comments.filter((x) => runKey(x) === key),
      });
    } else {
      units.push({ kind: "single", comment: c });
    }
  }
  return units;
}
