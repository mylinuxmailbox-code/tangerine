import React from "react";
import { Panel, Row } from "./Panel.js";
import type { SessionPlan } from "../core/Tangerine.js";
import { describeNetworkNamespace } from "../network/NetworkNamespace.js";

function NetworkPanelImpl({ plan }: { plan?: SessionPlan }): React.JSX.Element {
  return (
    <Panel title="NETWORK / SANDBOX">
      <Row label="Network">{plan ? `${plan.network.effective.toUpperCase()}  - ${describeNetworkNamespace(plan.network.effective)}` : "n/a"}</Row>
      <Row label="Sandbox">
        {plan ? (plan.sandbox.enabled ? `${plan.sandbox.backend}  fs:${plan.sandbox.enforced.filesystemIsolation ? "isolated" : "OPEN"}  pid-ns:${plan.sandbox.enforced.pidNamespace ? "on" : "off"}  seccomp:off` : "OFF (unsandboxed)") : "n/a"}
      </Row>
    </Panel>
  );
}
export const NetworkPanel = React.memo(NetworkPanelImpl);
