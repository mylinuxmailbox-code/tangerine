import React from "react";
import { Box, Text } from "ink";
import type { MetricsSnapshot } from "../monitoring/MetricsStore.js";
import type { SessionPlan } from "../core/Tangerine.js";
import type { TangerineState } from "../core/Lifecycle.js";
import { RuntimePanel } from "./RuntimePanel.js";
import { CpuPanel } from "./CpuPanel.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { GraphicsPanel } from "./GraphicsPanel.js";
import { ProcessPanel } from "./ProcessPanel.js";
import { NetworkPanel } from "./NetworkPanel.js";
import { BenchmarkPanel } from "./BenchmarkPanel.js";
import { StatusBar } from "./StatusBar.js";

export interface DashboardProps {
  snapshot: MetricsSnapshot;
  plan?: SessionPlan;
  state: TangerineState;
  benchmarkLines?: readonly string[];
  hint: string;
}

export function Dashboard({ snapshot, plan, state, benchmarkLines, hint }: DashboardProps): React.JSX.Element {
  const dot = state === "running" ? "●" : "○";
  return (
    <Box flexDirection="column" width={78}>
      <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
        <Text bold color="#ff8a00">TANGERINE</Text>
        <Text color={state === "running" ? "green" : "yellow"}>{state.toUpperCase()} {dot}</Text>
      </Box>
      <RuntimePanel plan={plan} fps={snapshot.fps} />
      <CpuPanel cpu={snapshot.cpu} />
      <MemoryPanel memory={snapshot.memory} swap={snapshot.swap} />
      <GraphicsPanel gpu={snapshot.gpu} plan={plan} />
      <ProcessPanel proc={snapshot.process} plan={plan} />
      <NetworkPanel plan={plan} />
      {benchmarkLines ? <BenchmarkPanel lines={benchmarkLines} /> : null}
      <StatusBar state={state} graphics={plan?.performance.graphics.backend ?? "n/a"} sandbox={plan ? (plan.sandbox.enabled ? "ON" : "OFF") : "n/a"} hint={hint} />
    </Box>
  );
}
