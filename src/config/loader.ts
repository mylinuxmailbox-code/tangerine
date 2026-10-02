import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PartialConfig, PerformanceProfile, TangerineConfig } from "./schema.js";
import { buildDefaults } from "./defaults.js";
import { configFromEnvironment } from "./environment.js";
import { assertValid } from "./validator.js";
import { deepFreeze, deepMerge, isRecord } from "../utils/Validation.js";
import { TangerineError } from "../core/Errors.js";
import type { HardwareClass } from "../performance/HardwareProfile.js";
import { profileDefinition } from "../performance/OptimizationProfile.js";

export function defaultConfigPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const base = env["XDG_CONFIG_HOME"] || join(env["HOME"] || homedir(), ".config");
  return join(base, "tangerine", "config.json");
}

export async function readConfigFile(path: string, mustExist: boolean): Promise<PartialConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (!mustExist && (e as { code?: string }).code === "ENOENT") return {};
    throw new TangerineError({ code: "CONFIG_INVALID", subsystem: "config", message: `Cannot read config file ${path}`, recoverable: false, cause: e, hint: "Check the path and permissions." });
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("top level must be a JSON object");
    return parsed as PartialConfig;
  } catch (e) {
    throw new TangerineError({ code: "CONFIG_INVALID", subsystem: "config", message: `Config file ${path} is not valid JSON: ${(e as Error).message}`, recoverable: false });
  }
}

export interface LoadedConfig {
  config: Readonly<TangerineConfig>;
  warnings: string[];
  /** Which layer set `performance.profile`; helps explain surprising results. */
  profileSource: "default" | "file" | "env" | "cli";
  hardware: HardwareClass;
  filePath?: string;
}

export interface LoadOptions {
  hardware: HardwareClass;
  filePath?: string;
  /** If true, a missing explicit --config file is an error. */
  fileMustExist?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  cli?: PartialConfig;
}

/**
 * Precedence (spec §34):  defaults(hardware) -> profile overlay -> config file -> environment -> CLI.
 * The profile *name* itself is resolved with the same precedence, then its overlay is slotted
 * below the file so explicit user keys always override a profile.
 */
export async function loadConfig(opts: LoadOptions): Promise<LoadedConfig> {
  const env = opts.env ?? process.env;
  const filePath = opts.filePath ?? defaultConfigPath(env);
  const file = await readConfigFile(filePath, opts.fileMustExist ?? false);
  const fromEnv = configFromEnvironment(env);
  const cli = opts.cli ?? {};

  const defaults = buildDefaults(opts.hardware);
  let profile: PerformanceProfile = defaults.performance.profile;
  let profileSource: LoadedConfig["profileSource"] = "default";
  for (const [layer, src] of [[file, "file"], [fromEnv, "env"], [cli, "cli"]] as const) {
    const p = layer.performance?.profile;
    if (p !== undefined) {
      profile = p;
      profileSource = src;
    }
  }
  const overlay = profileDefinition(profile, opts.hardware).overlay;
  const merged = deepMerge(defaults, overlay, file, fromEnv, cli);
  merged.performance.profile = profile;
  const warnings = assertValid(merged);
  return { config: deepFreeze(merged), warnings, profileSource, hardware: opts.hardware, filePath };
}
