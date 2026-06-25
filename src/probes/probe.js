// Shared BPF object. Both .bpf.c units are linked into one bin/probe.bpf.o
// and loaded once here; the per-feature probe modules (cpusched.js,
// runqlat.js) import this `control` and attach their own maps to it. All
// binds must happen before the single start(), so they live together here.
import { BpfObject } from "yeet:bpf";

// `base: import.meta.dirname` resolves against the running bundle.
const probe = new BpfObject({ exe: "../bin/probe.bpf.o", base: import.meta.dirname });

export const control = await probe
  .bind("events", { kind: "ringbuf", btf_struct: "sched_event" }) // cpusched stream
  .bind("probe.data", { kind: "data" }) // cpusched min-slice knob (.data section)
  .bind("runq_hist", { kind: "array" }) // runqlat histogram (polled)
  .start(); // the tracepoints auto-attach

export const numCpus = system.numCpus;
