export interface ScopeOptions {
  unitName: string;
  memoryHighBytes?: number;
}

/**
 * cgroup v2 resource control without root, via a transient systemd *user* scope:
 *   systemd-run --user --scope --unit NAME -p MemoryHigh=BYTES -- command...
 * `--scope` makes systemd-run exec the command in-place, so the PID (and process group)
 * is preserved and the scope is garbage-collected when the last process exits. That makes
 * rollback automatic: no cgroup directory is left behind. Needs a running user manager
 * (XDG_RUNTIME_DIR + session bus) and the `memory` controller delegated to the user slice
 * (default on Ubuntu 22.04 / Mint 21 with cgroup v2).
 */
export function buildScopeArgs(o: ScopeOptions): string[] {
  const props: string[] = [];
  if (o.memoryHighBytes && o.memoryHighBytes > 0) props.push("-p", `MemoryHigh=${Math.floor(o.memoryHighBytes)}`);
  if (!props.length) return [];
  return ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--unit", o.unitName, ...props, "--"];
}

export function scopeUnitName(sessionId: string): string {
  return `tangerine-${sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}.scope`;
}
