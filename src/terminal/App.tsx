import React, { useEffect, useRef, useState } from "react";
import { useApp, useInput, useStdin } from "ink";
import type { Tangerine } from "../core/Tangerine.js";
import { Dashboard } from "./Dashboard.js";

export interface AppProps {
  tangerine: Tangerine;
  refreshMs: number;
  /** Lines pushed by the benchmark runner (mutated array, read on each throttled tick). */
  benchmarkLines?: string[];
  onQuit: () => void;
}

/**
 * Rendering is throttled to `refreshMs` and independent of sampling: monitors only write to the
 * store; this timer copies the snapshot into React state when its version has changed. Panels are memoised on
 * metric identity, so unchanged metrics cost nothing.
 */
export function App({ tangerine, refreshMs, benchmarkLines, onQuit }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const store = tangerine.store;
  const [snapshot, setSnapshot] = useState(store.snapshot);
  const [state, setState] = useState(tangerine.machine.state);
  const [lines, setLines] = useState<readonly string[] | undefined>(benchmarkLines ? [...benchmarkLines] : undefined);
  const lastVersion = useRef(store.version);
  const lastLines = useRef(benchmarkLines?.length ?? 0);

  useEffect(() => {
    const t = setInterval(() => {
      if (store.version !== lastVersion.current) {
        lastVersion.current = store.version;
        setSnapshot(store.snapshot);
      }
      if (benchmarkLines && benchmarkLines.length !== lastLines.current) {
        lastLines.current = benchmarkLines.length;
        setLines([...benchmarkLines]);
      }
    }, refreshMs);
    const off = tangerine.machine.onChange((s) => setState(s));
    return () => {
      clearInterval(t);
      off();
    };
  }, [store, tangerine, refreshMs, benchmarkLines]);

  useInput(
    (input, key) => {
      if (input === "q" || (key.ctrl && input === "c")) {
        onQuit();
        exit();
      }
    },
    { isActive: isRawModeSupported },
  );

  return <Dashboard snapshot={snapshot} plan={tangerine.currentPlan} state={state} benchmarkLines={lines} hint={isRawModeSupported ? "q: stop" : "Ctrl-C: stop"} />;
}
