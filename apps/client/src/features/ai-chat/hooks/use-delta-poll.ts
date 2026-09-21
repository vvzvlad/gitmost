import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getAiChatMessagesDelta } from "@/features/ai-chat/services/ai-chat-service.ts";
import {
  mergeDeltaRowsIntoPages,
  type IMessagePage,
} from "@/features/ai-chat/utils/resume-helpers.ts";
import { AI_CHAT_MESSAGES_RQ_KEY } from "@/features/ai-chat/queries/ai-chat-query.ts";
import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";

// #491/#555: the degraded DELTA poll interval. The window owns ONLY this dumb
// timer; the THREAD's run-lifecycle FSM owns arm/disarm (via onResumeFallback) and
// CONSUMES the run fact this hook surfaces (see run-fsm.spec.md §3.4, S1/S3). A
// LEADING tick fires once immediately when the poll arms (see below), so the first
// delta lands promptly instead of after a full interval (no ~5s first-poll latency).
export const DELTA_POLL_INTERVAL_MS = 2500;

/** The run fact the delta endpoint carries alongside the changed rows: the active
 *  run row `{ id, status }`, or `null` when no run is active on the chat. */
export type DeltaRunFact = { id: string; status: string } | null;

/** The messages infinite-query cache value the delta rows are merged into. */
export type MessagesInfiniteData =
  | { pages: IMessagePage[]; pageParams: unknown[] }
  | undefined;

/**
 * Merge a delta poll's `rows` into the messages infinite-query cache value,
 * IDEMPOTENTLY by id (the per-page upsert is `mergeDeltaRowsIntoPages`). Pure and
 * exported so the `setQueryData` shape — `{ ...old, pages }`, and the null-`old`
 * no-op — is unit-testable without rendering the window. Returns `old` unchanged
 * when the cache has not been seeded yet (nothing to merge into).
 */
export function applyDeltaRowsToMessagesCache(
  old: MessagesInfiniteData,
  rows: IAiChatMessageRow[],
): MessagesInfiniteData {
  if (!old) return old;
  return { ...old, pages: mergeDeltaRowsIntoPages(old.pages, rows) };
}

/** Are two delta run facts equivalent (both null, or same id + status)? Used to
 *  avoid re-surfacing (and re-rendering on) an unchanged fact each poll. */
export function sameRunFact(a: DeltaRunFact, b: DeltaRunFact): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && a.status === b.status;
}

/**
 * The degraded-poll DELTA transport (#491), extracted from `AiChatWindow` so it is
 * unit-testable in isolation (#555 W1). While `armed` (the thread's FSM entered a
 * poll-bearing recovery) AND `enabled` (the window is open) on a chat, it polls
 * `POST /ai-chat/messages/delta` every {@link DELTA_POLL_INTERVAL_MS}: the endpoint
 * returns only the rows CHANGED since the previous cursor (+ the run fact) in ONE
 * round-trip. The changed rows are merged into the SAME messages infinite-query
 * cache the thread reads (idempotently by id — the overlap window re-delivers
 * rows), so the thread's reconcile effect follows the detached run to its terminal
 * row from a fraction of the wire cost.
 *
 * It RETURNS the latest run fact so the WINDOW can forward it to the thread
 * (`polledRunFact` prop), where the FSM consumes it (#555 S3): a fresh NEGATIVE
 * fact quenches a stale `reconnecting`/`polling` immediately (I3), instead of
 * waiting for the terminal row or the reconnect ladder to exhaust. The cursor and
 * the surfaced fact RESET when the chat changes or the poll (dis)arms — the delta
 * chain is scoped to ONE resume attempt of ONE chat (invariant 8).
 */
export function useAiChatDeltaPoll(params: {
  chatId: string | null | undefined;
  armed: boolean;
  enabled: boolean;
}): DeltaRunFact | undefined {
  const { chatId, armed, enabled } = params;
  const queryClient = useQueryClient();
  // The DB-clock cursor echoed from the previous poll; `undefined` starts a fresh
  // chain (the server then returns just a cursor, no rows).
  const cursorRef = useRef<string | undefined>(undefined);
  // `undefined` = no poll result yet this cycle (the thread ignores it); `null` /
  // `{ id, status }` = an authoritative server run fact.
  const [runFact, setRunFact] = useState<DeltaRunFact | undefined>(undefined);

  // Reset the cursor + the surfaced fact whenever the chat changes or the poll
  // (dis)arms: the chain is scoped to one resume attempt of one chat. Resetting on
  // DISARM also lets a fresh negative fact on the NEXT arm re-quench (the thread's
  // dedupe keys off this reset).
  useEffect(() => {
    cursorRef.current = undefined;
    setRunFact(undefined);
  }, [chatId, armed]);

  useEffect(() => {
    if (!armed || !enabled || !chatId) return;
    const id = chatId;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await getAiChatMessagesDelta(id, cursorRef.current);
        if (cancelled) return;
        cursorRef.current = res.cursor;
        if (res.rows.length > 0) {
          queryClient.setQueryData(AI_CHAT_MESSAGES_RQ_KEY(id), (old) =>
            applyDeltaRowsToMessagesCache(
              old as MessagesInfiniteData,
              res.rows,
            ),
          );
        }
        // Surface the run fact (deduped so an unchanged fact does not re-render).
        // `undefined` (no result yet) is DISTINCT from `null` (authoritative
        // negative): the first poll always surfaces its fact, even a null one, so a
        // fresh negative quench is not swallowed.
        setRunFact((prev) =>
          prev !== undefined && sameRunFact(prev, res.run) ? prev : res.run,
        );
      } catch {
        // Transient failure (e.g. a server restart mid-run): swallow and retry on
        // the next tick — the poll must survive a bounce, like the old dumb refetch.
      }
    };
    // Leading tick: fire ONCE immediately on arm so the first delta lands promptly
    // instead of after a full interval (#555). It IS the first tick — it reads the
    // just-reset `undefined` cursor, so the cursor lifecycle is unchanged. The
    // `cancelled` guard above makes a StrictMode double-mount safe: the torn-down
    // closure's in-flight leading tick returns early and cannot write a stale
    // cursor/fact, so only the live effect's chain advances the cursor.
    void tick();
    const handle = setInterval(() => void tick(), DELTA_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [armed, enabled, chatId, queryClient]);

  return runFact;
}
