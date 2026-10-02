import type { GraphicsSelection } from "../performance/GraphicsManager.js";
import { ENV_KEY_RE, hasNul } from "../utils/Validation.js";
import { redact } from "../utils/Logger.js";

export type EnvLayer = "base" | "runtime" | "graphics" | "performance" | "sandbox" | "user" | "passthrough";

/** Variables always forwarded when present: needed for a graphical process to start at all. */
const BASE_KEYS = ["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE", "TERM"];
const HOME_KEYS = ["HOME", "USER", "LOGNAME"];
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface EnvBuildInput {
  host: Readonly<Record<string, string | undefined>>;
  runtime: Record<string, string>;
  graphics: GraphicsSelection;
  performance: Record<string, string>;
  sandbox: Record<string, string>;
  /** Sandboxed: HOME is private, so host HOME/USER are NOT forwarded. */
  sandboxed: boolean;
  userOverrides: Record<string, string>;
  passEnv: string[];
}

export interface BuiltEnvironment {
  env: Record<string, string>;
  provenance: Record<string, EnvLayer>;
  rejected: { key: string; why: string }[];
}

/**
 * Deterministic, layered environment (spec §7):
 *   base -> runtime -> graphics -> performance -> sandbox -> user overrides -> validation.
 * The host environment is NOT inherited wholesale; only an allow-list plus names the user
 * explicitly asked for in runtime.passEnv.
 */
export function buildEnvironment(i: EnvBuildInput): BuiltEnvironment {
  const env: Record<string, string> = {};
  const prov: Record<string, EnvLayer> = {};
  const rejected: { key: string; why: string }[] = [];
  const put = (layer: EnvLayer, src: Record<string, string | undefined>): void => {
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      if (!ENV_KEY_RE.test(k)) rejected.push({ key: k, why: "invalid variable name" });
      else if (hasNul(v)) rejected.push({ key: k, why: "value contains NUL" });
      else {
        env[k] = v;
        prov[k] = layer;
      }
    }
  };

  const base: Record<string, string | undefined> = {};
  for (const k of BASE_KEYS) base[k] = i.host[k];
  base["PATH"] = i.host["PATH"] || DEFAULT_PATH;
  if (!i.sandboxed) for (const k of HOME_KEYS) base[k] = i.host[k];
  put("base", base);
  put("runtime", i.runtime);
  put("graphics", i.graphics.environment);
  put("performance", i.performance);
  put("sandbox", i.sandbox);
  const pass: Record<string, string | undefined> = {};
  for (const k of i.passEnv) pass[k] = i.host[k];
  put("passthrough", pass);
  put("user", i.userOverrides);
  return { env, provenance: prov, rejected };
}

/** Env for display/logging: keys + provenance; secret-looking values and long values are redacted. */
export function describeEnvironment(b: BuiltEnvironment): { key: string; layer: EnvLayer; value: string }[] {
  const safe = redact(b.env) as Record<string, string>;
  return Object.keys(b.env).sort().map((key) => ({ key, layer: b.provenance[key] as EnvLayer, value: String(safe[key]).length > 80 ? String(safe[key]).slice(0, 77) + "..." : String(safe[key]) }));
}
