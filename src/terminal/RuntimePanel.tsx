import React from "react";
import { Panel, Row, Unavailable } from "./Panel.js";
import type { SessionPlan } from "../core/Tangerine.js";
import type { Metric } from "../monitoring/Metric.js";
import type { FpsStats } from "../monitoring/FpsMonitor.js";
import { fmt } from "./format.js";

function RuntimePanelImpl({ plan, fps }: { plan?: SessionPlan; fps: Metric<FpsStats> }): React.JSX.Element {
  return (
    <Panel title="RUNTIME">
      <Row label="Runtime">{plan ? `${plan.runtimeId}${plan.runtimeVersion ? " " + plan.runtimeVersion : ""}` : "n/a"}</Row>
      <Row label="Graphics">{plan ? `${plan.performance.graphics.backend.toUpperCase()}  (${plan.performance.graphics.requested})` : "n/a"}</Row>
      {fps.available ? (
        <>
          <Row label="FPS">{`${fmt(fps.value.instantFps)}  avg ${fmt(fps.value.avgFps)}  min ${fmt(fps.value.minFps)}`}</Row>
          <Row label="Frame Time">{`${fmt(fps.value.avgFrameTimeMs)} ms  p95 ${fmt(fps.value.frameTimeP95Ms)} ms${fps.value.source === "fps-reports" ? "  (derived from FPS reports)" : ""}`}</Row>
        </>
      ) : (
        <Row label="FPS"><Unavailable reason={fps.reason} /></Row>
      )}
    </Panel>
  );
}
export const RuntimePanel = React.memo(RuntimePanelImpl);
