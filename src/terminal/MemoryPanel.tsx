import React from "react";
import { Panel, Row, Unavailable } from "./Panel.js";
import type { Metric } from "../monitoring/Metric.js";
import type { MemoryUsage } from "../monitoring/MemoryMonitor.js";
import type { SwapPressure } from "../monitoring/SwapMonitor.js";
import { fmt, gb } from "./format.js";

function level(s: SwapPressure): string {
  const rate = s.pagesInPerSecond + s.pagesOutPerSecond;
  return `${s.active ? "ACTIVE (thrash)" : rate < 1 ? "none" : "low"}  in ${fmt(s.pagesInPerSecond, 0)}/s out ${fmt(s.pagesOutPerSecond, 0)}/s`;
}

function MemoryPanelImpl({ memory, swap }: { memory: Metric<MemoryUsage>; swap: Metric<SwapPressure> }): React.JSX.Element {
  return (
    <Panel title="MEMORY">
      {memory.available ? (
        <>
          <Row label="RAM">{`${gb(memory.value.usedKb)} / ${gb(memory.value.totalKb)} GB used (${fmt(memory.value.utilizationPercent, 0)}%)  cache ${gb(memory.value.cachedKb)} GB`}</Row>
          <Row label="Swap">{`${gb(memory.value.swapUsedKb)} / ${gb(memory.value.swapTotalKb)} GB`}</Row>
          <Row label="Mem pressure">{memory.value.psiSomeAvg10 === undefined ? "PSI unavailable" : `${fmt(memory.value.psiSomeAvg10)}% stalled (10s)`}</Row>
        </>
      ) : (
        <Unavailable reason={memory.reason} />
      )}
      <Row label="Swap I/O">{swap.available ? level(swap.value) : <Unavailable reason={swap.reason} />}</Row>
    </Panel>
  );
}
export const MemoryPanel = React.memo(MemoryPanelImpl);
