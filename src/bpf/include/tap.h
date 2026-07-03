/* The SSL-tap emit path, shared by BOTH uprobe tap objects:
 *   - wssnoop.bpf.c  → bin/probe.bpf.o     (SSL_read / SSL_write)
 *   - probe_ex.bpf.c → bin/probe_ex.bpf.o  (SSL_read_ex / SSL_write_ex)
 *
 * They're separate loadable objects on purpose: the `_ex` symbols exist only in
 * OpenSSL >= 1.1.1 (a BoringSSL or ancient-OpenSSL target lacks them), and
 * start() rejects an object with any unattached uprobe — so folding both symbol
 * families into one object would let a missing `_ex` symbol take down the plain
 * SSL_read/SSL_write capture that target CAN offer. Kept apart, each attaches
 * independently and probe.js treats the `_ex` object as best-effort.
 *
 * Everything downstream of "here are (ssl, buf, len, dir)" is identical between
 * them, so it lives here once: the events ringbuf, the user-writable focus
 * filter, the per-thread read-args map, and the bounded emit(). The two objects
 * differ only in which symbols they hook and how the read length is recovered.
 *
 * Include AFTER vmlinux.h and the libbpf headers — emit() uses their helpers. */
#pragma once

#include "events.h"

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);
} events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u64);
    __type(value, struct read_args);
    __uint(max_entries, 10240);
} active_reads SEC(".maps");

/* User-writable capture filter — the user->kernel control path. JS writes two
 * slots live (yeet:bpf ArrayMap.update): slot 0 a focus SSL*, slot 1 a focus
 * pid. When a slot is nonzero, only matching events are emitted; zero (the
 * default) captures everything. Filtering happens before the ringbuf reserve,
 * so muted traffic costs almost nothing — the "target one connection on a busy
 * production node, zero overhead for the rest" story. */
#define FOCUS_SSL 0
#define FOCUS_PID 1
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __type(key, __u32);
    __type(value, __u64);
    __uint(max_entries, 2);
} focus SEC(".maps");

static __always_inline void emit(__u64 ssl, __u64 buf, __u32 len, __u8 dir)
{
    if (len == 0)
        return;

    __u64 id = bpf_get_current_pid_tgid();
    __u32 pid = id >> 32;
    __u32 k_ssl = FOCUS_SSL, k_pid = FOCUS_PID;
    __u64 *f_ssl = bpf_map_lookup_elem(&focus, &k_ssl);
    __u64 *f_pid = bpf_map_lookup_elem(&focus, &k_pid);
    if (f_ssl && *f_ssl && ssl != *f_ssl)
        return;
    if (f_pid && *f_pid && pid != (__u32) *f_pid)
        return;

    struct ssl_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)
        return;
    if (fill_event(e, ssl, buf, len, dir, TRANSPORT_TLS) < 0) {
        bpf_ringbuf_discard(e, 0);
        return;
    }
    bpf_ringbuf_submit(e, 0);
}
