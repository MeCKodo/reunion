import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drop-in replacement for `useState` that mirrors the value to
 * `localStorage` so the choice survives reloads. Accepts the same
 * "value | (prev) => value" updater pattern as React state.
 *
 * Storage failures (private mode, quota, JSON errors) degrade silently to
 * in-memory state — we never want a UI control to throw because of disk I/O.
 *
 * Keys are auto-prefixed with a namespace so different features can't collide.
 */

const NAMESPACE = "logue";

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(`${NAMESPACE}:${key}`);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${NAMESPACE}:${key}`, JSON.stringify(value));
  } catch {
    // ignore — quota exceeded or storage disabled
  }
}

export function usePersistentState<T>(
  key: string,
  initialValue: T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  // Lazy initializer: read localStorage exactly once on mount.
  const [state, setState] = useState<T>(() => read(key, initialValue));

  // Track the most recent key so a hot-swapped key (rare) writes to the
  // right slot rather than overwriting the previous one.
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  useEffect(() => {
    write(keyRef.current, state);
  }, [state]);

  // Stable setter signature matching React.Dispatch.
  const setPersistent = useCallback<React.Dispatch<React.SetStateAction<T>>>(
    (next) => {
      setState(next);
    },
    []
  );

  return [state, setPersistent];
}
