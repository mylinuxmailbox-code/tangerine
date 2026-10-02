import type { HostCapabilities } from "../core/CapabilityManager.js";

export interface FirewallStatus {
  tooling: string[];
  privileged: boolean;
  usable: boolean;
  note: string;
}

/**
 * Detection only. Tangerine never edits the host's global firewall (spec §23, §63.5).
 * Any future rule must be scoped to a Tangerine-owned network namespace, carry a unique
 * id, and be registered as a SystemMutation with an explicit rollback.
 */
export function firewallStatus(caps: HostCapabilities): FirewallStatus {
  const tooling = ["nft", "iptables"].filter((t) => caps.helpers[t]);
  const privileged = caps.permissions.hasNetAdmin || caps.permissions.isRoot;
  return {
    tooling,
    privileged,
    usable: caps.firewall,
    note: tooling.length ? (privileged ? "tooling present and privileged (not used: restricted mode unimplemented)" : "tooling present but CAP_NET_ADMIN is missing (unprivileged)") : "no nft/iptables found",
  };
}
