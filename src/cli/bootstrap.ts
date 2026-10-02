import { join } from "node:path";
import { RealCommandRunner } from "../system/Commands.js";
import { RealLinuxSystem, type LinuxSystem } from "../system/Linux.js";
import { LinuxProcFs, type ProcFs } from "../system/ProcFs.js";
import { LinuxSysFs, type SysFs } from "../system/SysFs.js";
import { detectPlatform, detectRuntimePlatform, type PlatformInfo } from "../system/Platform.js";
import { classifyHardware } from "../performance/HardwareProfile.js";
import { loadConfig, type LoadedConfig } from "../config/loader.js";
import { Logger, fileSink, stderrSink } from "../utils/Logger.js";
import { resolveDirs, type Dirs } from "../core/SessionStore.js";
import { createDefaultRuntimeManager } from "../runtime/RuntimeManager.js";
import { BenchmarkStore } from "../benchmark/BenchmarkStore.js";
import type { TangerineDeps } from "../core/Tangerine.js";
import { cliOverrides, type CliArgs } from "./args.js";

export interface Context {
  deps: TangerineDeps;
  loaded: LoadedConfig;
  platform: PlatformInfo;
  sys: LinuxSystem;
  proc: ProcFs;
  sysfs: SysFs;
  dirs: Dirs;
  logger: Logger;
  logFile: string;
  store: BenchmarkStore;
}

export function logFilePath(dirs: Dirs): string {
  return join(dirs.state, "logs", "tangerine.log");
}

/** Wires real implementations together. Tests build TangerineDeps by hand with fakes instead. */
export async function createContext(args: CliArgs, opts: { stderrLogs: boolean }): Promise<Context> {
  const logger = Logger.create("info");
  const runner = new RealCommandRunner(logger.child("cmd"));
  const sys = new RealLinuxSystem(runner);
  const proc = new LinuxProcFs(sys);
  const sysfs = new LinuxSysFs(sys);
  const platform = await detectPlatform(sys, proc);
  const topo = await sysfs.readCpuTopology();
  const hardware = classifyHardware(platform, topo);
  const loaded = await loadConfig({ hardware, filePath: args.configPath, fileMustExist: args.configPath !== undefined, cli: cliOverrides(args) });

  const dirs = resolveDirs();
  const logFile = logFilePath(dirs);
  logger.setLevel(loaded.config.logging.level);
  if (loaded.config.logging.toFile) logger.addSink(fileSink(logFile));
  if (opts.stderrLogs) logger.addSink(stderrSink());

  const store = new BenchmarkStore(dirs.state);
  const deps: TangerineDeps = { sys, proc, sysfs, platform: detectRuntimePlatform(), logger, dirs, runtimeManager: createDefaultRuntimeManager(sys), benchmarkStore: store };
  return { deps, loaded, platform, sys, proc, sysfs, dirs, logger, logFile, store };
}
