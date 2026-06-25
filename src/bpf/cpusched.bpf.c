// cpusched — stream context switches, one event per sched_switch, tagged
// with the CPU. Userspace turns the stream into a per-CPU heat grid and a
// live prev->next feed for the selected CPU.
//
// The runtime knob `min_slice_ns` is the two-way half: userspace patches
// it (via DataSec) and the kernel only emits switches whose outgoing task
// ran at least that long — a filter you can't do in JS, since JS only ever
// sees the events the kernel chose to emit.
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>

#define TASK_COMM_LEN 16

char LICENSE[] SEC("license") = "Dual BSD/GPL";

// Runtime knob, patched live from the UI. sched_switch is a firehose, so
// the default is a SAFE floor (1ms): only emit switches whose outgoing task
// ran at least this long, keeping the ring buffer (and the UI) sane. Lower
// it from the UI to see more. Non-zero also keeps it in .data (not .bss),
// so the bound section name stays `<obj>.data`. Must match `minSlice`'s
// initial value in probes/cpusched.js.
volatile __u64 min_slice_ns = 1000000;

// One context switch, streamed to userspace.
struct sched_event {
	__u32 cpu;
	__u32 prev_pid;
	__u32 next_pid;
	__u64 slice_ns;
	char prev_comm[TASK_COMM_LEN];
	char next_comm[TASK_COMM_LEN];
};

// Force BTF emission of sched_event so the daemon can resolve
// btf_struct: "sched_event" on the ring buffer.
struct sched_event *_unused_event __attribute__((unused));

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 256 * 1024);
} events SEC(".maps");

// This-CPU's previous sched_switch timestamp, to measure the outgoing
// task's on-CPU slice. Per-CPU, so a single slot (index 0) is private to
// each core — no locking, no key by CPU id.
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, __u64);
} last_ts SEC(".maps");

SEC("tracepoint/sched/sched_switch")
int on_sched_switch(struct trace_event_raw_sched_switch *ctx)
{
	__u32 zero = 0;
	__u64 now = bpf_ktime_get_ns();

	__u64 *last = bpf_map_lookup_elem(&last_ts, &zero);
	if (!last) {
		return 0;
	}
	__u64 prev = *last;
	*last = now;

	// Skip the first switch on each CPU (no prior timestamp) and any
	// slice shorter than the live knob.
	if (prev == 0) {
		return 0;
	}
	__u64 slice = now - prev;
	if (slice < min_slice_ns) {
		return 0;
	}

	struct sched_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e) {
		return 0; // ring full — drop is the backpressure
	}
	e->cpu = bpf_get_smp_processor_id();
	e->prev_pid = ctx->prev_pid;
	e->next_pid = ctx->next_pid;
	e->slice_ns = slice;
	bpf_probe_read_kernel_str(&e->prev_comm, sizeof(e->prev_comm), ctx->prev_comm);
	bpf_probe_read_kernel_str(&e->next_comm, sizeof(e->next_comm), ctx->next_comm);
	bpf_ringbuf_submit(e, 0);
	return 0;
}
