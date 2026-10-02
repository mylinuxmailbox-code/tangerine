import type { NetworkMode } from "../config/schema.js";

/** Human-readable summary of what the namespace layer will do for a mode. */
export function describeNetworkNamespace(mode: NetworkMode): string {
  switch (mode) {
    case "blocked": return "private network namespace (no interfaces besides lo): no connectivity";
    case "restricted": return "private namespace + allow-list (unimplemented; treated as blocked)";
    case "unrestricted": return "host network namespace (shared)";
  }
}
