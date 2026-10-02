export interface SeccompStatus {
  enforced: boolean;
  kernelSupport: boolean;
  note: string;
}

/**
 * Honest placeholder (spec §21, §63.2): installing a seccomp-bpf filter from Node needs a
 * native helper (or bwrap's --seccomp <fd> with a compiled BPF program). Tangerine does not
 * ship one yet, so it reports `enforced: false` and never claims syscall filtering.
 */
export function seccompStatus(kernelSupport: boolean): SeccompStatus {
  return {
    enforced: false,
    kernelSupport,
    note: "no seccomp filter installed by Tangerine (kernel support: " + (kernelSupport ? "yes" : "unknown") + ")",
  };
}
