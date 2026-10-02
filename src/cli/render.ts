import type { SessionPlan } from "../core/Tangerine.js";
import { describeEnvironment } from "../runtime/EnvironmentBuilder.js";
import { describeNetworkNamespace } from "../network/NetworkNamespace.js";
import { describeProfile } from "../performance/OptimizationProfile.js";
import { profileDefinition } from "../performance/OptimizationProfile.js";
import type { HostCapabilities } from "../core/CapabilityManager.js";

const h = (t: string): string => `\n== ${t} ==`;
const yn = (b: boolean): string => (b ? "yes" : "no");

/** Dry-run output (spec §32): everything that WOULD happen. */
export function renderPlan(p: SessionPlan, opts: { showEnv?: boolean } = {}): string {
  const L: string[] = [];
  L.push("TANGERINE DRY RUN - no host changes have been made");
  L.push(h("HOST"));
  L.push(`${p.platform.distro ?? "Linux"} ${p.platform.distroVersion ?? ""} ${p.platform.distroCodename ?? ""} | kernel ${p.platform.kernel} | desktop ${p.platform.desktop ?? "?"} (${p.platform.sessionType ?? "?"})`);
  L.push(`${p.hardware.cpuModel ?? "unknown CPU"} | ${p.hardware.physicalCores}C/${p.hardware.logicalCpus}T | ${p.hardware.totalMemMb} MB RAM | hardware class: ${p.hardware.id}`);
  for (const n of p.hardware.notes) L.push(`  - ${n}`);
  L.push(h("PROFILE"));
  L.push(...describeProfile(profileDefinition(p.config.performance.profile, p.hardware)));
  L.push(h("RUNTIME"));
  L.push(`adapter: ${p.runtimeId}${p.runtimeVersion ? " " + p.runtimeVersion : ""}`);
  L.push(`executable: ${p.executable}`);
  L.push(`args: ${JSON.stringify(p.config.runtime.args)}`);
  L.push(h("GRAPHICS"));
  const g = p.performance.graphics;
  L.push(`backend: ${g.backend} (requested ${g.requested})`);
  L.push(`reason: ${g.reason}`);
  L.push(`vsync: ${g.vsync}${g.frameLimit ? `  frameLimit: ${g.frameLimit} (runtime-dependent)` : ""}`);
  L.push(`environment: ${Object.keys(g.environment).length ? Object.entries(g.environment).map(([k, v]) => `${k}=${v}`).join(" ") : "(none)"}`);
  L.push(h("CPU / SCHEDULER"));
  const a = p.performance.affinity;
  L.push(`affinity: ${a.applied ? `CPUs ${a.cpus.join(",")}` : "none"}  -- ${a.reason}`);
  const s = p.performance.scheduler;
  L.push(`scheduler: ${s.policy}${s.rtPriority ? " prio " + s.rtPriority : ""}  nice: ${s.nice} (requested ${s.requestedNice})`);
  L.push(`topology: ${p.performance.cpu.groups.map((gr) => `{${gr.join(",")}}`).join(" ")}  governor: ${p.performance.cpu.governor ?? "?"} (${p.performance.cpu.freqDriver ?? "?"})`);
  L.push(h("MEMORY"));
  L.push(p.performance.memory.reason);
  L.push(h("SANDBOX"));
  const sb = p.sandbox;
  L.push(`enabled: ${yn(sb.enabled)}  backend: ${sb.backend}`);
  L.push(`enforced: mount-ns ${yn(sb.enforced.mountNamespace)}, pid-ns ${yn(sb.enforced.pidNamespace)}, net-ns ${yn(sb.enforced.networkNamespace)}, filesystem isolation ${yn(sb.enforced.filesystemIsolation)}, cgroups ${yn(sb.enforced.cgroups)}, seccomp ${yn(sb.enforced.seccomp)}`);
  L.push(h("NETWORK"));
  L.push(`requested: ${p.network.requested}  effective: ${p.network.effective}  (${describeNetworkNamespace(p.network.effective)})`);
  L.push(`firewall: ${p.firewall.note} (Tangerine never edits the global firewall)`);
  L.push(h("MOUNTS"));
  if (!p.mounts.length) L.push("(none)");
  for (const m of p.mounts) L.push(`${m.kind}${m.device ? "(device)" : ""} ${m.readOnly ? "ro" : "rw"}  ${m.resolvedSource ?? m.source ?? "-"} -> ${m.target}   # ${m.purpose}`);
  for (const n of p.notes) L.push(`note: ${n}`);
  L.push(h("HOST MUTATIONS (all reversible unless stated)"));
  if (!p.plannedMutations.length) L.push("(none: scheduler/affinity/sandbox/cgroup are applied through launch wrappers and leave no host state)");
  for (const m of p.plannedMutations) L.push(`- ${m}`);
  L.push(h("LAUNCH COMMAND"));
  L.push(p.argv.map(shellQuote).join(" "));
  L.push(h("REQUIRED PRIVILEGES"));
  for (const x of p.privileges) L.push(`- ${x}`);
  if (opts.showEnv !== false) {
    L.push(h("ENVIRONMENT (values of secret-looking keys redacted)"));
    for (const e of describeEnvironment(p.environment)) L.push(`[${e.layer.padEnd(11)}] ${e.key}=${e.value}`);
  }
  if (p.warnings.length) {
    L.push(h("WARNINGS"));
    for (const w of p.warnings) L.push(`! ${w}`);
  }
  return L.join("\n");
}

/** Display only: the real launch never goes through a shell. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function renderCapabilities(c: HostCapabilities): string {
  const L: string[] = [h("CAPABILITIES").slice(1)];
  const keys: (keyof HostCapabilities)[] = ["cpuAffinity", "schedulerPriority", "realtimeScheduling", "cgroups", "namespaces", "networkNamespaces", "seccomp", "firewall", "opengl", "vulkan", "procFs", "sysFs"];
  for (const k of keys) L.push(`${String(k).padEnd(20)} ${String(c[k])}`);
  L.push("", "sandbox:", ...Object.entries(c.sandbox).map(([k, v]) => `  ${k.padEnd(20)} ${v}`));
  L.push("", "helpers:", ...Object.entries(c.helpers).map(([k, v]) => `  ${k.padEnd(12)} ${v ?? "-"}`));
  L.push("", `permissions: uid=${c.permissions.uid} CAP_SYS_NICE=${c.permissions.hasSysNice} CAP_NET_ADMIN=${c.permissions.hasNetAdmin} minNice=${c.permissions.minNice} rtprio-limit=${c.permissions.rtprioLimit ?? "?"}`);
  for (const n of c.notes) L.push(`note: ${n}`);
  return L.join("\n");
}
