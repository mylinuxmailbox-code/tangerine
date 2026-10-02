import React from "react";
import { Panel, Row, Unavailable } from "./Panel.js";
import type { Metric } from "../monitoring/Metric.js";
import type { ProcessUsage } from "../monitoring/ProcessMonitor.js";
import type { SessionPlan } from "../core/Tangerine.js";
import { fmt, mb } from "./format.js";

function ProcessPanelImpl({ proc, plan }: { proc: Metric<ProcessUsage>; plan?: SessionPlan }): React.JSX.Element {
  const sched = plan ? (plan.performance.scheduler.policy === "rr" ? `SCHED_RR ${plan.performance.scheduler.rtPriority}` : `Normal (nice ${plan.performance.scheduler.nice})`) : "n/a";
  const aff = plan ? (plan.performance.affinity.applied ? `CPU ${plan.performance.affinity.cpus.join(",")}` : "not pinned") : "n/a";
  return (
    <Panel title="PROCESS">
      {proc.available ? (
        <>
          <Row label="PID">{`${proc.value.pid}  (${proc.value.treePids.length} proc, ${proc.value.threads} threads)`}</Row>
          <Row label="Memory">{`RSS ${mb(proc.value.rssKb)} MB  anon ${mb(proc.value.anonKb)} MB  swap ${mb(proc.value.swapKb)} MB`}</Row>
          <Row label="CPU">{proc.value.cpuPercent === undefined ? "n/a" : `${fmt(proc.value.cpuPercent, 0)}% of one core`}</Row>
        </>
      ) : (
        <Row label="PID"><Unavailable reason={proc.reason} /></Row>
      )}
      <Row label="Priority">{sched}</Row>
      <Row label="Affinity">{aff}</Row>
    </Panel>
  );
}
export const ProcessPanel = React.memo(ProcessPanelImpl);
