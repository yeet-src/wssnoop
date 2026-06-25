// Shared BPF object. Both .bpf.c units are linked into one bin/probe.bpf.o
// and loaded once here; the per-feature probe modules (cpusched.js,
// runqlat.js) import this `control` and attach their own maps to it. All
// binds must happen before the single start(), so they live together here.
import { BpfObject } from "yeet:bpf";

// bin/probe.bpf.o sits at the project root. `base: import.meta.dirname`
// anchors the lookup on this module's directory, which differs by one level
// between the two ways the project runs: bundled, everything is flattened
// into src/index.jsx (dirname = src/, so ../bin); run straight from source
// for a faster loop (`yeet run src/main.jsx`), this file stays at src/probes/
// (dirname one deeper, so ../../bin). Detect the bundle by its entry filename.
const inBundle = import.meta.filename.endsWith("/index.jsx");
const probe = new BpfObject({
  exe: inBundle ? "../bin/probe.bpf.o" : "../../bin/probe.bpf.o",
  base: import.meta.dirname,
});

export const control = await probe
  .bind("events", { kind: "ringbuf", btf_struct: "sched_event" }) // cpusched stream
  .bind("probe.data", { kind: "data" }) // cpusched min-slice knob (.data section)
  .bind("runq_hist", { kind: "array" }) // runqlat histogram (polled)
  .start(); // the tracepoints auto-attach

export const numCpus = system.numCpus;
