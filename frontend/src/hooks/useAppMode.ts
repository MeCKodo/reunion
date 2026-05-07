import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_MODE_STATE,
  fetchMode,
  switchMode,
  type ModeState,
  type SwitchModePayload,
  type SwitchModeResult,
} from "@/lib/mode";

export type UseAppModeResult = {
  state: ModeState;
  loaded: boolean;
  /** Reload the latest state from the backend (useful after a manual change). */
  refresh: () => Promise<void>;
  /** Switch mode + persist on the backend. Keeps local state in sync on success. */
  apply: (payload: SwitchModePayload) => Promise<SwitchModeResult>;
};

// Backend treats `/api/mode` as the single source of truth; the hook is a thin
// cache so consumers don't refetch on every render. We avoid a global store so
// other hooks (e.g. `useAnnotations`) can keep their existing patterns.
export function useAppMode(): UseAppModeResult {
  const [state, setState] = useState<ModeState>(DEFAULT_MODE_STATE);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchMode();
      setState(next);
    } catch (error) {
      // Surfacing this would steal focus; the toast layer in App handles it.
      console.warn("fetch mode failed:", error);
    } finally {
      setLoaded(true);
    }
  }, []);

  const apply = useCallback(
    async (payload: SwitchModePayload): Promise<SwitchModeResult> => {
      const result = await switchMode(payload);
      if (result.ok) setState(result.state);
      return result;
    },
    []
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, loaded, refresh, apply };
}
