import React from "react";
import { Box, Text } from "ink";
import { Panel, Unavailable } from "./Panel.js";
import type { Metric } from "../monitoring/Metric.js";
import type { CpuUsage } from "../monitoring/CpuMonitor.js";
import { bar, colorFor, fmt } from "./format.js";

function CpuPanelImpl({ cpu }: { cpu: Metric<CpuUsage> }): React.JSX.Element {
  if (!cpu.available) return <Panel title="CPU"><Unavailable reason={cpu.reason} /></Panel>;
  const v = cpu.value;
  return (
    <Panel title={`CPU  ${fmt(v.totalPercent, 0)}%${v.tempC !== undefined ? `   ${fmt(v.tempC, 0)}°C` : ""}${v.freqRatio !== undefined ? `   clock ${fmt(v.freqRatio * 100, 0)}% of max` : ""}`}>
      {v.perCpu.map((c) => (
        <Box key={c.id}>
          <Box width={10}><Text dimColor>Core {c.id}</Text></Box>
          <Text color={colorFor(c.percent)}>{bar(c.percent)}</Text>
          <Text> {fmt(c.percent, 0).padStart(3)}%{c.freqMhz !== undefined ? `  ${c.freqMhz} MHz` : ""}</Text>
        </Box>
      ))}
    </Panel>
  );
}
export const CpuPanel = React.memo(CpuPanelImpl);
