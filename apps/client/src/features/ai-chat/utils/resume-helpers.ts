import type { UIMessage } from "@ai-sdk/react";
import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";

/**
 * Pure decisions for the resumable-SSE resume machinery (#184 phase 1.5). A tab
 * that reopens a chat whose agent run is still going attaches to the server's
 * run-stream registry (replay + live tail) instead of polling snapshots; these
 * small predicates decide WHICH tail is safe to resume and how to seed the store,
 * extracted so they can be unit-tested in isolation.
 */

/**
 * A STREAMING tail: the last persisted row is an assistant row still marked
 * `status === 'streaming'`. #491 (tail-only): such a tail is seeded UNCHANGED —
 * it carries the persisted steps 0..N-1 — and the run-stream registry's tail
 * (frames for steps >= N) is APPENDED to it by the SDK's `readUIMessageStream`
 * continuation. Only the presence of this tail decides WHETHER to attach.
 */
export function isStreamingTail(rows: IAiChatMessageRow[]): boolean {
  const tail = rows[rows.length - 1];
  return !!tail && tail.role === "assistant" && tail.status === "streaming";
}

/**
 * A SETTLED assistant tail: the last row is an assistant row whose status is
 * anything OTHER than 'streaming'. A settled assistant tail must NEVER resume —
 * replaying a finished run into a store that already holds its message duplicates
 * parts (`text-start` always pushes a new part).
 */
export function isSettledAssistantTail(rows: IAiChatMessageRow[]): boolean {
  const tail = rows[rows.length - 1];
  return !!tail && tail.role === "assistant" && tail.status !== "streaming";
}

/**
 * #491 tail-only anchor: the count of FINISHED steps whose parts are persisted in
 * THIS assistant row (`metadata.stepsPersisted`), written atomically with `parts`
 * server-side. The resume client reads it as its persisted step frontier N — the
 * tail-only attach asks the run-stream registry for the frames of step N onward
 * (the seed already carries steps 0..N-1). Absent on pre-#491 rows => 0.
 */
export function stepsPersistedOf(
  row: IAiChatMessageRow | null | undefined,
): number {
  const n = row?.metadata?.stepsPersisted;
  return typeof n === "number" && n >= 0 ? Math.floor(n) : 0;
}

/** One page of the messages infinite-query cache (`{ items, meta }`). */
export interface IMessagePage {
  items: IAiChatMessageRow[];
  meta: unknown;
}

/**
 * #491 delta-poll merge: upsert the delta poll's `rows` into the messages
 * infinite-query page structure IDEMPOTENTLY by id. The delta endpoint's overlap
 * window GUARANTEES occasional REPEATS, so this MUST converge: a row already
 * present is REPLACED IN PLACE (per-step growth of an in-progress row), a new row
 * is APPENDED to the last page in chronological order (the server returns delta
 * rows oldest-first). Applying the same delta twice equals applying it once. Never
 * mutates the input pages (returns fresh page objects with cloned item arrays).
 */
export function mergeDeltaRowsIntoPages(
  pages: IMessagePage[],
  rows: IAiChatMessageRow[],
): IMessagePage[] {
  if (rows.length === 0) return pages;
  const next: IMessagePage[] = pages.map((p) => ({
    ...p,
    items: p.items.slice(),
  }));
  const locate = (id: string): [number, number] | null => {
    for (let pi = 0; pi < next.length; pi++) {
      const ii = next[pi].items.findIndex((it) => it.id === id);
      if (ii !== -1) return [pi, ii];
    }
    return null;
  };
  for (const row of rows) {
    const at = locate(row.id);
    if (at) {
      next[at[0]].items[at[1]] = row; // replace in place — idempotent by id
    } else if (next.length > 0) {
      next[next.length - 1].items.push(row); // append chronologically
    } else {
      next.push({ items: [row], meta: undefined });
    }
  }
  return next;
}

/**
 * Merge an assistant message into the rendered list by id: replace the message
 * with the same id in place (the in-progress assistant row is already seeded from
 * history, so per-step growth replaces it), or append it when absent. Returns a
 * new array; the input is never mutated.
 */
export function mergeById(
  messages: UIMessage[],
  incoming: UIMessage | null | undefined,
): UIMessage[] {
  if (!incoming) return messages;
  const idx = messages.findIndex((m) => m.id === incoming.id);
  if (idx === -1) return [...messages, incoming];
  const next = messages.slice();
  next[idx] = incoming;
  return next;
}
