import React from "react";
import { Panel, Row, Unavailable } from "./Panel.js";
import type { Metric } from "../monitoring/Metric.js";
import type { GpuUsage } from "../monitoring/GpuMonitor.js";
import type { SessionPlan } from "../core/Tangerine.js";

function GraphicsPanelImpl({ gpu, plan }: { gpu: Metric<GpuUsage>; plan?: SessionPlan }): React.JSX.Element {
  const dev = gpu.available ? gpu.value.devices.find((d) => d.isIntel) ?? gpu.value.devices[0] : undefined;
  return (
    <Panel title="GRAPHICS">
      <Row label="Selection">{plan ? plan.performance.graphics.reason.slice(0, 70) : "n/a"}</Row>
      {dev ? (
        <Row label="GPU clock">{dev.actFreqMhz !== undefined || dev.curFreqMhz !== undefined ? `${dev.actFreqMhz ?? dev.curFreqMhz} MHz (max ${dev.maxFreqMhz ?? "?"})  ${dev.driver ?? ""}` : "not exposed by driver"}</Row>
      ) : (
        <Row label="GPU clock"><Unavailable reason={gpu.available ? "no device" : gpu.reason} /></Row>
      )}
    </Panel>
  );
}
export const GraphicsPanel = React.memo(GraphicsPanelImpl);
