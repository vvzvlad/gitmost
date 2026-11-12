import { useCallback, useEffect, useRef } from "react";

function releaseSentinel(sentinel: WakeLockSentinel): void {
  void sentinel
    .release()
    .catch((err) =>
      console.warn("[dictation] screen wake lock release failed", err),
    );
}

/**
 * Keeps the screen awake while dictation records: a phone that auto-locks its
 * screen suspends microphone capture. acquire() requests a screen wake lock,
 * release() drops it, and unmount releases it too. Not getting the lock (API
 * missing, page hidden, permission policy) is only logged and never blocks
 * recording.
 */
export function useScreenWakeLock(): {
  acquire: () => void;
  release: () => void;
} {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  // Bumped by every acquire() and release(): a request that resolves after a
  // newer acquire/release releases its own lock instead of keeping it.
  const generationRef = useRef(0);

  const release = useCallback((): void => {
    generationRef.current += 1;
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    if (sentinel) releaseSentinel(sentinel);
  }, []);

  const acquire = useCallback((): void => {
    const generation = ++generationRef.current;
    if (!navigator.wakeLock) return;
    navigator.wakeLock
      .request("screen")
      .then((sentinel) => {
        if (generation !== generationRef.current) {
          releaseSentinel(sentinel);
          return;
        }
        sentinelRef.current = sentinel;
      })
      .catch((err) =>
        console.warn("[dictation] screen wake lock unavailable", err),
      );
  }, []);

  useEffect(() => release, [release]);

  return { acquire, release };
}
