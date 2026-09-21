// Mantine Idle hook to support reset handle  - MIT
//src: https://github.com/mantinedev/mantine/blob/06018d0beff22caa7b36d796e56ad597cc5c23f7/packages/%40mantine/hooks/src/use-idle/use-idle.ts
import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_EVENTS: (keyof DocumentEventMap)[] = [
  "keypress",
  "mousemove",
  "touchmove",
  "click",
  "scroll",
];
const DEFAULT_OPTIONS = {
  events: DEFAULT_EVENTS,
  initialState: true,
};

export function useIdle(
  timeout: number,
  options?: Partial<{
    events: (keyof DocumentEventMap)[];
    initialState: boolean;
  }>,
) {
  const { events, initialState } = { ...DEFAULT_OPTIONS, ...options };
  const [idle, setIdle] = useState<boolean>(initialState);
  const timer = useRef<number>(-1);

  // `resetIdle` is a dependency of consumer effects (page-editor's socket
  // connect/disconnect effect). Declared inline it got a fresh identity on
  // every render, re-running those effects on every render. The timer lives in
  // a ref and `setIdle` is stable, so `timeout` is the only real dependency.
  const reset = useCallback(() => {
    setIdle(false);
    if (timer.current) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => {
      setIdle(true);
    }, timeout);
  }, [timeout]);

  useEffect(() => {
    const handleEvents = () => {
      reset();
    };

    events.forEach((event) => document.addEventListener(event, handleEvents));

    // Start the timer immediately instead of waiting for the first event to happen
    timer.current = window.setTimeout(() => {
      setIdle(true);
    }, timeout);

    return () => {
      events.forEach((event) =>
        document.removeEventListener(event, handleEvents),
      );
    };
  }, [timeout, events]);

  return { isIdle: idle, resetIdle: reset };
}
