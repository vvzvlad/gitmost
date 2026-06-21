import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { lookupTemplate } from "@/features/page-embed/services/page-embed-api";
import type { PageTemplateLookup } from "@/features/page-embed/types/page-embed.types";

type ContextValue = {
  subscribe: (s: {
    sourcePageId: string;
    setResult: (r: PageTemplateLookup) => void;
  }) => () => void;
  refresh: (sourcePageId: string) => Promise<void>;
};

const PageEmbedLookupContext = createContext<ContextValue | null>(null);

/**
 * Batching/de-dup lookup context for whole-page embeds (pageEmbed). Mirrors the
 * transclusion lookup context but keys purely on `sourcePageId`. On public
 * shares there is no lookup in MVP, so the context simply isn't mounted (the
 * node view renders a placeholder when the context is absent).
 *
 * NOTE (intentional near-duplicate of `transclusion-lookup-context.tsx`): this
 * provider duplicates that file's batching / de-dup / cache machinery; only the
 * lookup key (sourcePageId here vs sourcePageId+transclusionId there) and the
 * API call differ. Unifying them now would mean a generic, parameterised lookup
 * provider — a larger client refactor that isn't worth it for just two
 * consumers. Per Gitea #94, extract a shared generic provider when a THIRD
 * lookup consumer appears; until then keep the two in sync by hand. (Tracked,
 * deliberately deferred — not forgotten.)
 */
export function PageEmbedLookupProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const subscribersRef = useRef(new Map<string, Array<(r: PageTemplateLookup) => void>>());
  const queueRef = useRef(new Set<string>());
  const tickRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultCacheRef = useRef(new Map<string, PageTemplateLookup>());
  const inFlightRef = useRef(new Set<string>());
  const pendingRef = useRef(new Map<string, Array<() => void>>());

  const flush = useCallback(async () => {
    tickRef.current = null;
    const ids = Array.from(queueRef.current);
    queueRef.current.clear();
    if (ids.length === 0) return;

    for (const id of ids) inFlightRef.current.add(id);

    const resolveWaiters = (id: string) => {
      const waiters = pendingRef.current.get(id);
      if (!waiters) return;
      pendingRef.current.delete(id);
      for (const w of waiters) w();
    };

    try {
      const { items } = await lookupTemplate({ sourcePageIds: ids });
      const returned = new Set<string>();
      for (const r of items) {
        returned.add(r.sourcePageId);
        resultCacheRef.current.set(r.sourcePageId, r);
        inFlightRef.current.delete(r.sourcePageId);
        const subs = subscribersRef.current.get(r.sourcePageId);
        if (subs) {
          for (const set of subs) set(r);
        }
        resolveWaiters(r.sourcePageId);
      }
      // Harden against a partial/short server response: any requested id not
      // present in `items` would otherwise stay in `inFlightRef` forever
      // (subscribe/refresh are guarded by `!inFlightRef.has(id)`) and its
      // refresh() promise would never resolve. Clear + resolve those ids,
      // mirroring the catch branch, so no id can be stranded in-flight.
      for (const id of ids) {
        if (!returned.has(id)) {
          inFlightRef.current.delete(id);
          resolveWaiters(id);
        }
      }
    } catch (err) {
      // Surface the failure: errors must never be swallowed silently.
      console.error("[pageEmbed] template lookup failed", err);
      for (const id of ids) {
        inFlightRef.current.delete(id);
        resolveWaiters(id);
      }
    }
  }, []);

  const enqueue = useCallback(
    (id: string) => {
      queueRef.current.add(id);
      if (tickRef.current === null) {
        tickRef.current = setTimeout(flush, 10);
      }
    },
    [flush],
  );

  const subscribe = useCallback<ContextValue["subscribe"]>(
    ({ sourcePageId, setResult }) => {
      const list = subscribersRef.current.get(sourcePageId) ?? [];
      list.push(setResult);
      subscribersRef.current.set(sourcePageId, list);

      const cached = resultCacheRef.current.get(sourcePageId);
      if (cached) {
        setResult(cached);
      } else if (!inFlightRef.current.has(sourcePageId)) {
        enqueue(sourcePageId);
      }

      return () => {
        const cur = subscribersRef.current.get(sourcePageId) ?? [];
        const next = cur.filter((x) => x !== setResult);
        if (next.length === 0) subscribersRef.current.delete(sourcePageId);
        else subscribersRef.current.set(sourcePageId, next);
      };
    },
    [enqueue],
  );

  const refresh = useCallback<ContextValue["refresh"]>(
    (sourcePageId) =>
      new Promise<void>((resolve) => {
        resultCacheRef.current.delete(sourcePageId);
        inFlightRef.current.delete(sourcePageId);
        const waiters = pendingRef.current.get(sourcePageId) ?? [];
        waiters.push(resolve);
        pendingRef.current.set(sourcePageId, waiters);
        enqueue(sourcePageId);
      }),
    [enqueue],
  );

  useEffect(
    () => () => {
      if (tickRef.current) clearTimeout(tickRef.current);
    },
    [],
  );

  const value = useMemo<ContextValue>(
    () => ({ subscribe, refresh }),
    [subscribe, refresh],
  );

  return (
    <PageEmbedLookupContext.Provider value={value}>
      {children}
    </PageEmbedLookupContext.Provider>
  );
}

export function usePageEmbedLookup(sourcePageId: string | null | undefined): {
  result: PageTemplateLookup | null;
  refresh: () => Promise<void>;
  available: boolean;
} {
  const ctx = useContext(PageEmbedLookupContext);
  const [result, setResult] = useState<PageTemplateLookup | null>(null);

  useEffect(() => {
    if (!ctx || !sourcePageId) return;
    const unsubscribe = ctx.subscribe({ sourcePageId, setResult });
    return unsubscribe;
  }, [ctx, sourcePageId]);

  const refresh = useCallback(async () => {
    if (!ctx || !sourcePageId) return;
    await ctx.refresh(sourcePageId);
  }, [ctx, sourcePageId]);

  return { result, refresh, available: Boolean(ctx) };
}
