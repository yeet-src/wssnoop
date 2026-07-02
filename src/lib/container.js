/* container — the one pure fact about containers: a process's cgroup paths tell
 * you which container (if any) it runs in. docker / containerd / crio / podman /
 * k8s all embed the 64-hex container id in the cgroup path. Kept dependency-free
 * so both the presentation lookup (probes/procinfo.js) and binary discovery
 * (probes/discover.js) can share it. */

/* Short (12-char) container id from a process's cgroup paths, or null when the
 * process isn't containerized. */
export function containerOf(cgroups) {
  for (const c of cgroups || []) {
    const m = /(?:docker[-/]|containerd[-/]|crio-|libpod-)([0-9a-f]{12,64})/.exec(c.pathname || "");
    if (m) return m[1].slice(0, 12);
  }
  return null;
}
