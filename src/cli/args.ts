import type { PartialConfig, PerformanceProfile, GraphicsBackend } from "../config/schema.js";
import { TangerineError } from "../core/Errors.js";

export type Command = "start" | "stop" | "restart" | "status" | "inspect" | "doctor" | "benchmark" | "config" | "logs" | "help" | "version";
const COMMANDS: Command[] = ["start", "stop", "restart", "status", "inspect", "doctor", "benchmark", "config", "logs", "help", "version"];

export interface CliArgs {
  command: Command;
  positional: string[];
  /** argv after `--`: the workload command line. */
  workload: string[];
  profile?: PerformanceProfile;
  graphics?: GraphicsBackend;
  noNetwork: boolean;
  debug: boolean;
  verbose: boolean;
  quiet: boolean;
  dryRun: boolean;
  benchmark: boolean;
  noUi: boolean;
  json: boolean;
  configPath?: string;
  durationSec?: number;
  warmupSec?: number;
  cooldownSec?: number;
  runs?: number;
  experiment?: string;
  savePreference: boolean;
  lines?: number;
}

function fail(msg: string): never {
  throw new TangerineError({ code: "CONFIG_INVALID", subsystem: "cli", message: msg, recoverable: false, hint: "Run `tangerine help`." });
}

export function parseArgs(argv: string[]): CliArgs {
  const dd = argv.indexOf("--");
  const head = dd >= 0 ? argv.slice(0, dd) : argv;
  const workload = dd >= 0 ? argv.slice(dd + 1) : [];
  const a: CliArgs = { command: "help", positional: [], workload, noNetwork: false, debug: false, verbose: false, quiet: false, dryRun: false, benchmark: false, noUi: false, json: false, savePreference: false };
  let i = 0;
  const next = (flag: string): string => {
    const v = head[++i];
    if (v === undefined) fail(`${flag} requires a value`);
    return v;
  };
  const num = (flag: string, min: number): number => {
    const n = Number(next(flag));
    if (!Number.isFinite(n) || n < min) fail(`${flag} must be a number >= ${min}`);
    return n;
  };
  let haveCommand = false;
  for (; i < head.length; i++) {
    const t = head[i] as string;
    if (!t.startsWith("-")) {
      if (!haveCommand) {
        if (!COMMANDS.includes(t as Command)) fail(`Unknown command "${t}"`);
        a.command = t as Command;
        haveCommand = true;
      } else a.positional.push(t);
      continue;
    }
    switch (t) {
      case "--profile": {
        const v = next(t);
        if (!["safe", "balanced", "performance", "custom"].includes(v)) fail(`--profile must be safe|balanced|performance|custom`);
        a.profile = v as PerformanceProfile;
        break;
      }
      case "--graphics": {
        const v = next(t);
        if (!["auto", "opengl", "vulkan"].includes(v)) fail(`--graphics must be auto|opengl|vulkan`);
        a.graphics = v as GraphicsBackend;
        break;
      }
      case "--no-network": a.noNetwork = true; break;
      case "--debug": a.debug = true; break;
      case "--verbose": a.verbose = true; break;
      case "--quiet": a.quiet = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "--benchmark": a.benchmark = true; break;
      case "--no-ui": a.noUi = true; break;
      case "--json": a.json = true; break;
      case "--save-preference": a.savePreference = true; break;
      case "--config": a.configPath = next(t); break;
      case "--duration": a.durationSec = num(t, 1); break;
      case "--warmup": a.warmupSec = num(t, 0); break;
      case "--cooldown": a.cooldownSec = num(t, 0); break;
      case "--runs": a.runs = Math.floor(num(t, 1)); break;
      case "--experiment": a.experiment = next(t); break;
      case "-n": case "--lines": a.lines = Math.floor(num(t, 1)); break;
      case "-h": case "--help": a.command = "help"; haveCommand = true; break;
      case "-v": case "--version": a.command = "version"; haveCommand = true; break;
      default: fail(`Unknown option ${t}`);
    }
  }
  return a;
}

/** CLI layer of the config precedence chain. Only explicitly given flags produce keys. */
export function cliOverrides(a: CliArgs): PartialConfig {
  const o: PartialConfig = {};
  if (a.profile) o.performance = { ...o.performance, profile: a.profile };
  if (a.graphics) o.graphics = { ...o.graphics, backend: a.graphics };
  if (a.noNetwork) o.network = { mode: "blocked" };
  if (a.debug) o.logging = { level: "debug" };
  else if (a.verbose) o.logging = { level: "info" };
  else if (a.quiet) o.logging = { level: "error" };
  if (a.noUi) o.ui = { enabled: false };
  if (a.workload.length) o.runtime = { executable: a.workload[0], args: a.workload.slice(1) };
  if (a.debug) o.graphics = { ...o.graphics, debug: true };
  return o;
}

export const HELP = `Tangerine - execution & optimization control plane for Android x86_64 workloads on Linux

USAGE
  tangerine <command> [options] [-- <workload command> [args...]]

COMMANDS
  start       Launch the workload in a prepared, monitored environment
  stop        Gracefully stop the running session (SIGTERM, then rollback)
  restart     stop, then start
  status      Show the active session
  inspect     Show detected capabilities and the resolved plan (read-only)
  doctor      Check this host (PASS / WARN / FAIL / UNAVAILABLE)
  benchmark   Run measured sessions; 'benchmark compare <labelA> <labelB>', 'benchmark list'
  config      Print the effective config; 'config path', 'config init'
  logs        Print recent log lines (-n N)

OPTIONS
  --profile safe|balanced|performance|custom
  --graphics auto|opengl|vulkan
  --no-network     force network.mode=blocked
  --dry-run        print the full plan; make NO host changes
  --benchmark      with 'start': record a benchmark result when the session ends
  --no-ui          plain log output instead of the Ink dashboard
  --config PATH    config file (default ~/.config/tangerine/config.json)
  --debug | --verbose | --quiet
  --json           machine-readable output (doctor, inspect, status)

BENCHMARK OPTIONS
  --runs N  --duration SEC  --warmup SEC  --cooldown SEC
  --experiment cpu|graphics|memory|compositor   one-variable-at-a-time ladder
  --save-preference    store the measured graphics winner for 'graphics: auto' (graphics experiment only)

EXAMPLES
  tangerine doctor
  tangerine start --dry-run -- ~/android/run.sh game.apk
  tangerine start --profile balanced -- ~/android/run.sh game.apk
  tangerine benchmark --experiment graphics --runs 3 --duration 60 -- ~/android/run.sh game.apk
`;
