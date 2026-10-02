import type { NetworkConfig, NetworkMode } from "../config/schema.js";
import type { SandboxCapabilities } from "../core/CapabilityManager.js";
import { TangerineError } from "../core/Errors.js";

export interface NetworkPlan {
  requested: NetworkMode;
  effective: NetworkMode;
  /** Does the sandbox need a private network namespace? */
  needNetNamespace: boolean;
  warnings: string[];
}

/**
 * Network access is explicit and fail-closed (spec §23).
 *  blocked      -> private, empty network namespace (only a downed loopback): no connectivity.
 *  restricted   -> needs per-namespace firewall rules (nft + CAP_NET_ADMIN inside a netns we
 *                  also provision veth for). NOT implemented yet: falls back to `blocked`,
 *                  the safer direction, with a warning. The host's global firewall is never touched.
 *  unrestricted -> shares the host network (no namespace).
 */
export function planNetwork(cfg: NetworkConfig, sandboxCaps: SandboxCapabilities, sandboxEnabled: boolean): NetworkPlan {
  const warnings: string[] = [];
  let effective = cfg.mode;
  if (cfg.mode === "restricted") {
    effective = "blocked";
    warnings.push(`network.mode=restricted is not implemented (${cfg.allow.length} allow rule(s) ignored): falling back to blocked [NETWORK_POLICY_FAILED, recoverable]`);
  }
  const needNet = effective !== "unrestricted";
  if (needNet && (!sandboxEnabled || !sandboxCaps.networkNamespace)) {
    throw new TangerineError({
      code: "NETWORK_POLICY_FAILED",
      subsystem: "network",
      message: "Network is set to blocked, but a network namespace cannot be created to enforce it.",
      recoverable: false,
      hostModified: false,
      fallback: "none (fail-closed): the workload was not started",
      hint: "Install bubblewrap (sudo apt install bubblewrap) / enable user namespaces, or explicitly set network.mode=unrestricted.",
    });
  }
  return { requested: cfg.mode, effective, needNetNamespace: needNet, warnings };
}
