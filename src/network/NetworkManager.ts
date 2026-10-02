import type { NetworkConfig } from "../config/schema.js";
import type { HostCapabilities } from "../core/CapabilityManager.js";
import { planNetwork, type NetworkPlan } from "./NetworkPolicy.js";
import { firewallStatus, type FirewallStatus } from "./FirewallManager.js";

export class NetworkManager {
  plan(cfg: NetworkConfig, caps: HostCapabilities, sandboxEnabled: boolean): { plan: NetworkPlan; firewall: FirewallStatus } {
    return { plan: planNetwork(cfg, caps.sandbox, sandboxEnabled), firewall: firewallStatus(caps) };
  }
}
