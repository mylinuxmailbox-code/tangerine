export interface NamespaceOptions {
  mount: boolean;
  pid: boolean;
  net: boolean;
}

/**
 * util-linux `unshare` fallback backend (used only when bubblewrap is missing).
 * Facility: unshare(2) with CLONE_NEWUSER|NEWNS|NEWPID|NEWNET. Unprivileged via a user
 * namespace (needs kernel.unprivileged_userns_clone / max_user_namespaces > 0; default on Mint 21).
 * `-r` maps the caller to uid 0 *inside* the namespace only (util-linux 2.37 on Mint 21.3 lacks
 * --map-current-user); this grants no host privilege.
 *
 * What it gives: PID + network (+ mount-propagation) isolation.
 * What it does NOT give: a restricted filesystem view - the whole host FS stays visible.
 */
export function buildUnshareArgs(o: NamespaceOptions): string[] {
  const args = ["unshare", "--user", "--map-root-user", "--kill-child"];
  if (o.mount || o.pid) args.push("--mount");
  if (o.pid) args.push("--pid", "--fork", "--mount-proc");
  if (o.net) args.push("--net");
  args.push("--");
  return args;
}
