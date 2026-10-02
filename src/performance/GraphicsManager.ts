import type { GraphicsBackend, GraphicsConfig } from "../config/schema.js";
import type { LinuxSystem } from "../system/Linux.js";
import type { GpuInfo } from "../system/SysFs.js";
import { TangerineError } from "../core/Errors.js";

export interface GraphicsCapabilities {
  opengl: boolean;
  vulkan: boolean;
  /** Vulkan is present but only via a software rasteriser (lavapipe). */
  vulkanSoftwareOnly: boolean;
  renderer?: string;
  glVersion?: string;
  mesaVersion?: string;
  /** Installed Mesa DRI drivers, e.g. iris, crocus, swrast. */
  driDrivers: string[];
  vulkanIcds: string[];
  vulkanDevices: string[];
  isIntel: boolean;
  kernelDriver?: string;
  /** True when glxinfo/vulkaninfo were consulted (slower, needs a display). */
  deep: boolean;
  details: string[];
}

export interface GraphicsSelection {
  requested: GraphicsBackend;
  /** "none": auto-detection found no usable API; the workload still starts (it may be headless or bring its own renderer). */
  backend: "opengl" | "vulkan" | "none";
  reason: string;
  environment: Record<string, string>;
  frameLimit?: number;
  vsync: boolean;
  /** Host directory to persist the shader cache in, if enabled. */
  shaderCacheHostDir?: string;
  notes: string[];
}

const DRI_DIRS = ["/usr/lib/x86_64-linux-gnu/dri", "/usr/lib64/dri", "/usr/lib/dri"];
const ICD_DIRS = ["/usr/share/vulkan/icd.d", "/etc/vulkan/icd.d", "/usr/local/share/vulkan/icd.d"];
const GL_LIBS = ["/usr/lib/x86_64-linux-gnu/libGL.so.1", "/usr/lib64/libGL.so.1", "/usr/lib/libGL.so.1", "/usr/lib/x86_64-linux-gnu/libEGL.so.1"];
const VK_LOADER = ["/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/lib64/libvulkan.so.1", "/usr/lib/libvulkan.so.1"];

export function parseGlxinfo(text: string): { renderer?: string; glVersion?: string; mesaVersion?: string } {
  const renderer = /OpenGL renderer string:\s*(.+)/.exec(text)?.[1]?.trim();
  const glVersion = /OpenGL version string:\s*(.+)/.exec(text)?.[1]?.trim();
  const mesaVersion = glVersion ? /Mesa\s+([0-9][^\s]*)/.exec(glVersion)?.[1] : undefined;
  return { renderer, glVersion, mesaVersion };
}

export function parseVulkanSummary(text: string): string[] {
  return [...text.matchAll(/deviceName\s*=\s*(.+)/g)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
}

async function listDir(sys: LinuxSystem, dir: string): Promise<string[]> {
  try {
    return await sys.readDir(dir);
  } catch {
    return [];
  }
}

/**
 * Detects graphics APIs from files first (no processes, no display needed). With `deep`,
 * also consults glxinfo / vulkaninfo when installed, which can reveal the actual renderer.
 */
export async function detectGraphics(sys: LinuxSystem, gpu: GpuInfo | undefined, opts: { deep: boolean }): Promise<GraphicsCapabilities> {
  const details: string[] = [];
  const driDrivers = new Set<string>();
  for (const d of DRI_DIRS) for (const f of await listDir(sys, d)) {
    const m = /^(.+)_dri\.so$/.exec(f);
    if (m?.[1]) driDrivers.add(m[1]);
  }
  let libGl = false;
  for (const l of GL_LIBS) if (await sys.exists(l)) libGl = true;
  const icds: string[] = [];
  for (const d of ICD_DIRS) for (const f of await listDir(sys, d)) if (f.endsWith(".json")) icds.push(f);
  let loader = false;
  for (const l of VK_LOADER) if (await sys.exists(l)) loader = true;

  const hwDri = [...driDrivers].filter((d) => d !== "swrast" && d !== "kms_swrast" && d !== "zink");
  const hwIcds = icds.filter((f) => !/lvp|lavapipe|swrast/i.test(f));
  const intelDev = gpu?.devices.find((d) => d.isIntel);

  const caps: GraphicsCapabilities = {
    opengl: libGl && driDrivers.size > 0,
    vulkan: loader && hwIcds.length > 0,
    vulkanSoftwareOnly: loader && hwIcds.length === 0 && icds.length > 0,
    driDrivers: [...driDrivers].sort(),
    vulkanIcds: icds.sort(),
    vulkanDevices: [],
    isIntel: !!intelDev || hwDri.some((d) => ["iris", "crocus", "i965", "i915"].includes(d)),
    kernelDriver: intelDev?.driver ?? gpu?.devices[0]?.driver,
    deep: opts.deep,
    details,
  };
  details.push(`DRI drivers: ${caps.driDrivers.join(", ") || "none"}`);
  details.push(`Vulkan ICDs: ${caps.vulkanIcds.join(", ") || "none"}`);

  if (opts.deep) {
    if (sys.which("glxinfo")) {
      const r = await sys.execute("glxinfo", ["-B"], { timeoutMs: 4000 });
      if (r.exitCode === 0) Object.assign(caps, parseGlxinfo(r.stdout));
      else details.push("glxinfo failed (no X display?); renderer unknown");
    } else details.push("glxinfo not installed (package mesa-utils): renderer unknown");
    if (sys.which("vulkaninfo")) {
      const r = await sys.execute("vulkaninfo", ["--summary"], { timeoutMs: 6000 });
      if (r.exitCode === 0) {
        caps.vulkanDevices = parseVulkanSummary(r.stdout);
        // vulkaninfo is the authority when it ran: it exercises the loader + ICD end to end.
        const hw = caps.vulkanDevices.filter((n) => !/llvmpipe|lavapipe|software/i.test(n));
        caps.vulkan = hw.length > 0;
        caps.vulkanSoftwareOnly = !hw.length && caps.vulkanDevices.length > 0;
      } else details.push("vulkaninfo failed; falling back to ICD file detection");
    } else details.push("vulkaninfo not installed (package vulkan-tools): Vulkan detection is file-based only");
  }
  return caps;
}

export interface SelectOptions {
  /** A recorded benchmark preference (never assumed): only used when backend === "auto". */
  benchmarkPreference?: "opengl" | "vulkan";
  shaderCacheHostDir?: string;
  shaderCacheMaxSize?: string;
}

/**
 * Chooses the backend and builds the graphics environment (spec §8).
 * Only documented variables are emitted:
 *   vblank_mode           Mesa DRI config (envvars): 0 = never wait for vblank
 *   MESA_VK_WSI_PRESENT_MODE  Mesa Vulkan WSI present mode (fifo|immediate|...)
 *   mesa_glthread         Mesa GL threaded dispatch
 *   MESA_SHADER_CACHE_DIR / MESA_SHADER_CACHE_MAX_SIZE  Mesa on-disk shader cache
 *   LIBGL_DEBUG=verbose   Mesa libGL loader diagnostics
 *   VK_LOADER_DEBUG       Khronos Vulkan loader diagnostics
 * There is no generic frame-limit variable; `frameLimit` is passed to the runtime adapter.
 */
export function selectGraphics(cfg: GraphicsConfig, caps: GraphicsCapabilities, opts: SelectOptions = {}): GraphicsSelection {
  const notes: string[] = [];
  let backend: "opengl" | "vulkan" | "none";
  let reason: string;

  if (cfg.backend === "opengl" || cfg.backend === "vulkan") {
    if (!caps[cfg.backend]) {
      throw new TangerineError({
        code: "GRAPHICS_BACKEND_UNAVAILABLE",
        subsystem: "graphics",
        message: `Requested graphics backend "${cfg.backend}" is not available: ${caps.details.join("; ")}`,
        recoverable: true,
        fallback: "use --graphics auto to pick an available backend",
        hint: cfg.backend === "vulkan" ? "Install mesa-vulkan-drivers and vulkan-tools (Mint 21.3), or choose opengl." : "Install mesa libGL/libEGL drivers (libgl1-mesa-dri), or choose vulkan.",
      });
    }
    backend = cfg.backend;
    reason = `explicitly requested (${cfg.backend})`;
  } else if (opts.benchmarkPreference && caps[opts.benchmarkPreference]) {
    backend = opts.benchmarkPreference;
    reason = `auto: previously recorded benchmark preference (${backend})`;
  } else if (caps.opengl) {
    backend = "opengl";
    reason = caps.vulkan
      ? "auto: OpenGL and Vulkan both present; no benchmark preference recorded, so the most widely supported path (OpenGL) is used. Not assumed faster: run `tangerine benchmark --experiment graphics`."
      : "auto: only OpenGL is available";
  } else if (caps.vulkan) {
    backend = "vulkan";
    reason = "auto: only Vulkan is available";
  } else {
    backend = "none";
    reason = "auto: no usable OpenGL or hardware Vulkan detected; continuing without graphics configuration (run `tangerine doctor`)";
    notes.push("No graphics API detected: no graphics environment is set. Install Mesa drivers (libgl1-mesa-dri, mesa-vulkan-drivers) if the workload renders.");
  }
  if (caps.vulkanSoftwareOnly && backend === "vulkan") notes.push("Vulkan resolves to a software rasteriser: expect poor performance.");

  const env: Record<string, string> = {};
  if (backend === "none") {
    /* nothing to configure */
  } else if (!cfg.vsync) {
    if (backend === "opengl") env["vblank_mode"] = "0";
    else env["MESA_VK_WSI_PRESENT_MODE"] = "immediate";
  } else if (backend === "vulkan") {
    env["MESA_VK_WSI_PRESENT_MODE"] = "fifo";
  } // GL vsync=true: leave Mesa's default (app-controlled swap interval) untouched.

  if (cfg.glthread && backend === "opengl") env["mesa_glthread"] = "true";
  if (cfg.debug) {
    if (backend === "opengl") env["LIBGL_DEBUG"] = "verbose";
    else env["VK_LOADER_DEBUG"] = "error,warn";
  }
  let shaderCacheHostDir: string | undefined;
  if (cfg.shaderCache && opts.shaderCacheHostDir) {
    shaderCacheHostDir = opts.shaderCacheHostDir;
    env["MESA_SHADER_CACHE_DIR"] = "/tangerine/shader-cache"; // path *inside* the sandbox
    env["MESA_SHADER_CACHE_MAX_SIZE"] = opts.shaderCacheMaxSize ?? "512M";
  }
  if (cfg.frameLimit) notes.push(`frameLimit=${cfg.frameLimit} is not a Mesa feature; it is forwarded to the runtime adapter, which must implement it.`);
  Object.assign(env, cfg.extraEnvironment ?? {});

  return { requested: cfg.backend, backend, reason, environment: env, frameLimit: cfg.frameLimit, vsync: cfg.vsync, shaderCacheHostDir, notes };
}
