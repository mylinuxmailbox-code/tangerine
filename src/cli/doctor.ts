import type { Context } from "./bootstrap.js";
import type { HostCapabilities } from "../core/CapabilityManager.js";
import { CapabilityManager } from "../core/CapabilityManager.js";
import { SwapPressureDetector } from "../monitoring/SwapMonitor.js";
import { sleep } from "../utils/Async.js";
import { summarizeCpu } from "../performance/CpuManager.js";
import { planAffinity } from "../performance/AffinityManager.js";

export type DoctorStatus = "PASS" | "WARN" | "FAIL" | "UNAVAILABLE";
export interface DoctorCheck {
  category: string;
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}
export interface DoctorReport {
  checks: DoctorCheck[];
  /** Hypotheses, explicitly NOT verified. */
  tips: string[];
  caps: HostCapabilities;
}

export async function runDoctor(ctx: Context): Promise<DoctorReport> {
  const { sys, proc, sysfs, platform, loaded } = ctx;
  const caps = await new CapabilityManager(sys, proc, sysfs).detect({ deepGraphics: true });
  const checks: DoctorCheck[] = [];
  const add = (category: string, name: string, status: DoctorStatus, detail: string, fix?: string): void => void checks.push({ category, name, status, detail, fix });
  const hw = loaded.hardware;

  // Platform
  add("Platform", "architecture", platform.isX86_64 ? "PASS" : "FAIL", platform.arch, platform.isX86_64 ? undefined : "Tangerine targets x86_64 Android workloads.");
  add("Platform", "kernel", "PASS", platform.kernel);
  add("Platform", "distribution", "PASS", `${platform.distro ?? "unknown"} ${platform.distroVersion ?? ""} ${platform.distroCodename ?? ""}${platform.isMintMate && platform.distroVersion?.startsWith("21") ? "  (primary target: Linux Mint 21.x MATE)" : "  (primary target is Linux Mint 21.3 MATE; others are best-effort)"}`);
  add("Platform", "desktop", platform.desktop ? "PASS" : "UNAVAILABLE", `${platform.desktop ?? "XDG_CURRENT_DESKTOP not set"} / session ${platform.sessionType ?? "?"}`);
  if (platform.sessionType === "wayland") add("Platform", "display server", "WARN", "Wayland session: sandbox display mounts assume an X11 socket", "Use an X11 session (MATE default).");

  // CPU
  const t = caps.topology;
  add("CPU", "model", "PASS", `${platform.cpuModel ?? "unknown"}; hardware class ${hw.id}`);
  add("CPU", "topology", "PASS", `${t.physicalCoreCount} cores / ${t.logicalCount} threads, SMT ${t.smt ? "on" : "off"}, ${t.numaNodes || 1} NUMA node(s); online ${t.online.join(",")}`);
  add("CPU", "affinity support", caps.cpuAffinity ? "PASS" : "WARN", caps.cpuAffinity ? "taskset works" : "taskset missing or failing", "sudo apt install util-linux");
  const first = t.cpus.find((c) => c.online);
  add("CPU", "frequency scaling", first?.governor ? "PASS" : "UNAVAILABLE", `${t.freqDriver ?? "no cpufreq driver"} / governor ${first?.governor ?? "n/a"}`);
  const temp = await sysfs.readThermalMilliC();
  add("CPU", "temperature", temp !== undefined ? (temp >= 90000 ? "WARN" : "PASS") : "UNAVAILABLE", temp !== undefined ? `${(temp / 1000).toFixed(0)} C (hottest zone)` : "no thermal zones readable", temp !== undefined && temp >= 90000 ? "Check cooling: sustained load will throttle." : undefined);
  const sum = await summarizeCpu(t, proc);
  const aff = planAffinity({ enabled: true, strategy: "auto" }, sum);
  add("CPU", "auto affinity plan", "PASS", aff.reason);

  // Memory
  const mem = await proc.readMemInfo();
  add("Memory", "RAM", mem.totalKb < 4 * 1048576 ? "WARN" : "PASS", `${(mem.totalKb / 1048576).toFixed(1)} GB total, ${(mem.availableKb / 1048576).toFixed(1)} GB available`, mem.totalKb < 4 * 1048576 ? "Under 4 GB: expect memory pressure with Android workloads." : undefined);
  add("Memory", "swap", mem.swapTotalKb === 0 ? "WARN" : "PASS", mem.swapTotalKb === 0 ? "no swap configured" : `${(mem.swapTotalKb / 1048576).toFixed(1)} GB total, ${((mem.swapTotalKb - mem.swapFreeKb) / 1048576).toFixed(2)} GB used`, mem.swapTotalKb === 0 ? "Without swap there is no buffer before the OOM killer acts; Android workloads can need more than a small-RAM host has." : undefined);
  const psi = await proc.readPsi("memory");
  add("Memory", "pressure stall info (PSI)", psi ? (psi.someAvg10 > 10 ? "WARN" : "PASS") : "UNAVAILABLE", psi ? `memory some avg10 = ${psi.someAvg10}%` : "/proc/pressure/memory not available (kernel without PSI or psi=0)");
  const det = new SwapPressureDetector({ activePagesPerSec: 1, inactivePagesPerSec: 1, enterSamples: 1, exitSamples: 1 });
  det.update(await proc.readVmStat(), Date.now());
  await sleep(600);
  const sp = det.update(await proc.readVmStat(), Date.now() + 600);
  add("Memory", "swap activity (600 ms sample)", sp ? (sp.pagesInPerSecond + sp.pagesOutPerSecond > 200 ? "WARN" : "PASS") : "UNAVAILABLE", sp ? `in ${sp.pagesInPerSecond.toFixed(0)} / out ${sp.pagesOutPerSecond.toFixed(0)} pages/s` : "could not sample /proc/vmstat", sp && sp.pagesInPerSecond + sp.pagesOutPerSecond > 200 ? "The host is swapping right now; close memory-heavy apps before benchmarking." : undefined);

  // Graphics
  const g = caps.graphics;
  add("Graphics", "renderer", g.renderer ? "PASS" : "UNAVAILABLE", g.renderer ?? "unknown (glxinfo missing or no display)", g.renderer ? undefined : "sudo apt install mesa-utils");
  add("Graphics", "Mesa", g.mesaVersion ? "PASS" : "UNAVAILABLE", g.mesaVersion ?? "version unknown");
  add("Graphics", "OpenGL", g.opengl ? "PASS" : "FAIL", g.opengl ? `DRI drivers: ${g.driDrivers.join(", ")}` : "no libGL/DRI drivers found", "sudo apt install libgl1-mesa-dri");
  add("Graphics", "Vulkan", g.vulkan ? "PASS" : g.vulkanSoftwareOnly ? "WARN" : "UNAVAILABLE", g.vulkan ? `devices: ${g.vulkanDevices.join(", ") || g.vulkanIcds.join(", ")}` : g.vulkanSoftwareOnly ? "software rasteriser only (lavapipe)" : "no hardware Vulkan ICD", "sudo apt install mesa-vulkan-drivers vulkan-tools");
  const gpu = caps.gpu.devices.find((d) => d.isIntel);
  add("Graphics", "Intel GPU", gpu ? "PASS" : "UNAVAILABLE", gpu ? `${gpu.driver ?? "?"}, clock ${gpu.curFreqMhz ?? "?"}/${gpu.maxFreqMhz ?? "?"} MHz` : "no Intel DRM device");
  add("Graphics", "debugfs telemetry", caps.gpu.debugfsReadable ? "PASS" : "UNAVAILABLE", caps.gpu.debugfsReadable ? "readable" : "not readable (optional; needs root)");

  // Runtime
  const cfg = loaded.config;
  const detected = await ctx.deps.runtimeManager.detectAll(cfg.runtime);
  const any = detected.some((d) => d.detected);
  add("Runtime", "adapter detection", any ? "PASS" : "WARN", detected.map((d) => `${d.id}:${d.detected ? "ok" : "not detected"}`).join(", "), any ? undefined : "Set runtime.executable in your config, or pass `-- <command>`.");
  add("Runtime", "executable", cfg.runtime.executable ? (any ? "PASS" : "FAIL") : "UNAVAILABLE", cfg.runtime.executable ?? "runtime.executable not set");

  // Sandbox
  add("Sandbox", "bubblewrap (filesystem isolation)", caps.bwrap ? "PASS" : "WARN", caps.bwrap ? caps.helpers["bwrap"] ?? "" : "not usable", "sudo apt install bubblewrap");
  add("Sandbox", "user namespaces", caps.unshareUserNs || caps.bwrap ? "PASS" : "FAIL", caps.unshareUserNs ? "unshare --user works" : caps.bwrap ? "via bwrap" : "unprivileged user namespaces blocked", "Check sysctl kernel.unprivileged_userns_clone / user.max_user_namespaces");
  add("Sandbox", "mount namespace", caps.sandbox.mountNamespace ? "PASS" : "UNAVAILABLE", String(caps.sandbox.mountNamespace));
  add("Sandbox", "pid namespace", caps.sandbox.pidNamespace ? "PASS" : "UNAVAILABLE", String(caps.sandbox.pidNamespace));
  add("Sandbox", "cgroups v2 (systemd user scope)", caps.systemdScope ? "PASS" : caps.cgroupV2 ? "WARN" : "UNAVAILABLE", caps.systemdScope ? "memory.high capping available without root" : caps.cgroupV2 ? "cgroup v2 present but no user scope" : "cgroup v2 not mounted");
  add("Sandbox", "seccomp", "UNAVAILABLE", `kernel support: ${caps.seccompKernelSupport}; Tangerine does not install a filter yet`);

  // Network
  add("Network", "network namespace", caps.networkNamespaces ? "PASS" : "FAIL", caps.networkNamespaces ? "can create private netns (network 'blocked' is enforceable)" : "cannot create a netns: 'blocked' cannot be enforced", "Install bubblewrap or enable user namespaces; otherwise network.mode must be 'unrestricted'.");
  add("Network", "firewall tooling", caps.firewall ? "PASS" : "UNAVAILABLE", caps.firewall ? "nft/iptables + privileges" : "unprivileged or no tooling (not required: Tangerine never edits the global firewall)");

  // Dependencies
  const major = Number(process.versions.node.split(".")[0]);
  add("Dependencies", platform.runtime.name, major >= 18 ? "PASS" : "FAIL", `${platform.runtime.name} ${platform.runtime.version}`, major >= 18 ? undefined : "Node >= 18.18 required");
  for (const hbin of ["taskset", "chrt", "nice", "unshare"]) add("Dependencies", hbin, caps.helpers[hbin] ? "PASS" : "WARN", caps.helpers[hbin] ?? "not found", "sudo apt install util-linux");
  for (const hbin of ["glxinfo", "vulkaninfo", "gsettings"]) add("Dependencies", `${hbin} (optional)`, caps.helpers[hbin] ? "PASS" : "UNAVAILABLE", caps.helpers[hbin] ?? "not found");

  // Hardware-specific hypotheses (never applied automatically)
  const tips: string[] = [];
  if (hw.id === "i3-6006u" || hw.id === "low-end") {
    tips.push("Core pinning on a low-core-count CPU is unproven. Test it: `tangerine benchmark --experiment cpu`.");
    if (mem.totalKb < 9 * 1048576) tips.push("Small-RAM host: try a memory.high cap: `tangerine benchmark --experiment memory`. Watch swap-in/out rates and 'mem pressure', not RAM %.");
    const swappiness = await proc.readSysctl("vm.swappiness");
    if (swappiness !== undefined && Number(swappiness) >= 60) tips.push(`vm.swappiness=${swappiness} (Mint default). Lower values (e.g. 10-30) make the kernel prefer dropping page cache over swapping; effect on your workload is unverified. Tangerine does NOT change it.`);
    const zram = await sys.exists("/sys/block/zram0");
    if (!zram && mem.totalKb < 9 * 1048576) tips.push("No zram device. Compressed RAM swap can be cheaper than SATA-SSD swap on small-RAM hosts (unverified here; also costs CPU on a 2-core part). Tangerine does NOT configure it.");
    tips.push("U-series CPU: on sustained load watch the 'clock % of max' and temperature in the dashboard; falling clock + rising temperature indicates thermal throttling (hypothesis until confirmed with benchmark cpuFreqMhzAvg).");
  }
  if (caps.marcoCompositor) tips.push("MATE/Marco compositing can be toggled for a session: `tangerine benchmark --experiment compositor`.");
  return { checks, tips, caps };
}

export function renderDoctor(r: DoctorReport): string {
  const L: string[] = [];
  let cat = "";
  const sym: Record<DoctorStatus, string> = { PASS: "PASS       ", WARN: "WARN       ", FAIL: "FAIL       ", UNAVAILABLE: "UNAVAILABLE" };
  for (const c of r.checks) {
    if (c.category !== cat) {
      cat = c.category;
      L.push("", cat.toUpperCase());
    }
    L.push(`  ${sym[c.status]} ${c.name}: ${c.detail}`);
    if (c.fix && c.status !== "PASS") L.push(`              -> ${c.fix}`);
  }
  const n = (s: DoctorStatus): number => r.checks.filter((c) => c.status === s).length;
  L.push("", `SUMMARY  PASS ${n("PASS")}  WARN ${n("WARN")}  FAIL ${n("FAIL")}  UNAVAILABLE ${n("UNAVAILABLE")}`);
  if (r.tips.length) {
    L.push("", "HYPOTHESES TO TEST (unverified - Tangerine changes none of these automatically)");
    for (const t of r.tips) L.push(`  * ${t}`);
  }
  return L.join("\n");
}
