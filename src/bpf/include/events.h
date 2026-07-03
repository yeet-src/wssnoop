/* Shared plaintext-capture record, used by BOTH loadable objects:
 *   - wssnoop.bpf.c (the SSL uprobe tap → bin/probe.bpf.o)
 *   - socket.bpf.c  (the socket-layer taps → bin/socket.bpf.o)
 * They're separate objects (the SSL uprobes can't share an object with the
 * always-loadable socket probes — start() rejects an unattached uprobe), so the
 * record type is shared here as source, not linked: each object gets its own
 * copy in BTF, both under the name "ssl_event" that JS binds the ringbuf to.
 *
 * Include AFTER vmlinux.h and <bpf/bpf_helpers.h> — fill_event() uses the
 * helpers and __u* types those provide. */
#pragma once

#define CHUNK    4096     /* payload bytes captured per call (power of 2). The
                           * whole struct is decoded into a JS object per ring
                           * event, so its size dominates the per-event cost —
                           * keep it tight; larger calls report truncated. */
#define CAP_MASK 0x0fff   /* `cap &= CAP_MASK` bounds the copy for the verifier;
                           * caps capture at 4095 bytes (one short of CHUNK). */

#define DIR_READ  0       /* ingress: bytes coming up out of SSL_read / recv  */
#define DIR_WRITE 1       /* egress:  bytes going down into SSL_write / send  */

#define TRANSPORT_TLS 0   /* captured at the OpenSSL boundary (wss://)   */
#define TRANSPORT_TCP 1   /* captured at the plain TCP boundary (ws://)  */

struct ssl_event {
    __u64 ts;
    __u64 ssl;        /* SSL* (TLS) or struct sock* (TCP) — opaque per-connection id */
    __u32 pid;        /* tgid (userspace pid) */
    __u32 tid;        /* pid  (userspace tid) */
    __u32 len;        /* full plaintext length of this call */
    __u32 cap_len;    /* bytes actually copied into data[] (<= len) */
    __u8  dir;        /* DIR_READ | DIR_WRITE */
    __u8  transport;  /* TRANSPORT_TLS | TRANSPORT_TCP */
    __u8  _pad[2];
    __u8  data[CHUNK];
};

/* Anchor the struct in BTF so the loader can decode ringbuf records by the type
 * name "ssl_event" (the `btf_struct` passed to .bind in JS). */
__attribute__((used)) static const struct ssl_event __ssl_event_anchor;

/* Carry a read call's args from its entry probe to its return probe, keyed by
 * the calling thread — read buffers are only filled by the time the call
 * returns. A hash (not a single slot) tolerates nested/recursive use.
 *
 * `nread` is SSL_read_ex's `size_t *readbytes` out-param: that variant reports
 * the count through this pointer and returns only a 0/1 status, so the return
 * probe reads `*nread` for the length. Plain SSL_read leaves it 0 and uses the
 * return value instead. */
struct read_args {
    __u64 ssl;
    __u64 buf;
    __u64 nread;
};

/* Fill a reserved event and copy up to CAP_MASK bytes of plaintext from user
 * `buf`. Returns 0 on success, -1 if the user copy faulted (caller discards the
 * ringbuf reservation). The filtering (which pid/connection to emit) is the
 * caller's — it differs per object — so this is only the fill + bounded copy. */
static __always_inline int fill_event(struct ssl_event *e, __u64 conn, __u64 buf,
                                       __u32 len, __u8 dir, __u8 transport)
{
    __u64 id = bpf_get_current_pid_tgid();
    e->ts = bpf_ktime_get_ns();
    e->ssl = conn;
    e->pid = id >> 32;
    e->tid = (__u32) id;
    e->len = len;
    e->dir = dir;
    e->transport = transport;
    e->_pad[0] = e->_pad[1] = 0;

    /* Clamp then mask so the verifier sees a bounded copy length. */
    __u32 cap = len;
    if (cap > CAP_MASK)
        cap = CAP_MASK;
    e->cap_len = cap;

    barrier_var(cap);
    cap &= CAP_MASK;
    if (cap && bpf_probe_read_user(e->data, cap, (const void *) buf))
        return -1;
    return 0;
}
