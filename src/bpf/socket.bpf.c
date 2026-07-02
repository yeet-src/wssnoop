/* wssnoop/socket — the socket-layer taps, one loadable object (bin/socket.bpf.o)
 * separate from the SSL uprobe tap. Two jobs, both kernel-global kprobes/fexit
 * with no uprobe, so this object always loads (start() rejects an object with an
 * unattached uprobe — keeping these here means a non-OpenSSL process can't fail
 * an attach and take socket capture down with it):
 *
 *   1. Discovery (layer 1) — one fexit/tcp_connect catches every outbound TCP
 *      connection (v4+v6) with the dialing pid, tcp_close marks its end. Per
 *      connection, not per byte, so it's cheap to run host-wide. JS builds a
 *      live connection map from these, the browse list you pick tap targets from.
 *
 *   2. Plaintext capture (ws://) — tcp_sendmsg/recvmsg carry the plaintext of a
 *      NON-TLS WebSocket (an ALB-terminated server leg, or any plain ws://).
 *      Gated on a focus-pid set: emit only for pids JS armed, so an idle host
 *      pays nothing to userspace. This sees only what's plaintext on the wire —
 *      an in-process TLS client's bytes are ciphertext here (use the SSL tap).
 *
 * NB the sendmsg/recvmsg kprobes read msghdr/iov, which is kernel-version
 * sensitive; treat plaintext capture as best-effort until it moves to a
 * BTF-stable hook (fentry) or a wire tap (tcx). Discovery uses fexit already. */

#define BPF_NO_KFUNC_PROTOTYPES

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_endian.h>

#include "events.h"

/* ---- discovery (layer 1) ------------------------------------------------- */

#define CONN_OPEN  0
#define CONN_CLOSE 1

/* vmlinux.h carries no socket.h #defines — spell out the two address families
 * we branch on (v4 = 2, v6 = 10 on Linux). */
#define AF_INET  2
#define AF_INET6 10

struct conn_event {
    __u64 ts;
    __u64 sk;         /* struct sock* — the opaque per-connection id */
    __u32 pid;        /* tgid (userspace pid that dialed) */
    __u32 tid;        /* pid  (userspace tid) */
    __u16 rport;      /* remote port, host order */
    __u8  family;     /* AF_INET (2) | AF_INET6 (10) */
    __u8  event;      /* CONN_OPEN | CONN_CLOSE */
    __u8  raddr[16];  /* remote address; v4 in the first 4 bytes, else v6 */
};
__attribute__((used)) static const struct conn_event __conn_event_anchor;

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 18);   /* connection events are rare vs data bytes */
} conns SEC(".maps");

static __always_inline void emit_conn(struct sock *sk, __u8 event)
{
    struct conn_event *e = bpf_ringbuf_reserve(&conns, sizeof(*e), 0);
    if (!e)
        return;

    __u64 id = bpf_get_current_pid_tgid();
    e->ts = bpf_ktime_get_ns();
    e->sk = (__u64) sk;
    e->pid = id >> 32;
    e->tid = (__u32) id;
    e->event = event;
    e->family = BPF_CORE_READ(sk, __sk_common.skc_family);
    e->rport = bpf_ntohs(BPF_CORE_READ(sk, __sk_common.skc_dport));

    __builtin_memset(e->raddr, 0, sizeof(e->raddr));
    if (e->family == AF_INET6)
        BPF_CORE_READ_INTO(&e->raddr, sk, __sk_common.skc_v6_daddr.in6_u.u6_addr8);
    else
        BPF_CORE_READ_INTO(&e->raddr, sk, __sk_common.skc_daddr);

    bpf_ringbuf_submit(e, 0);
}

/* int tcp_connect(struct sock *sk) — the one v4+v6 outbound-connect chokepoint;
 * at fexit the destination is set, so we get the full remote endpoint + dialing
 * pid. This is the discovery signal: which process is reaching what, host-wide. */
SEC("fexit/tcp_connect")
int BPF_PROG(fexit_tcp_connect, struct sock *sk, int ret)
{
    if (ret == 0)
        emit_conn(sk, CONN_OPEN);
    return 0;
}

/* void tcp_close(struct sock *sk, long timeout) — the connection's end, so the
 * userspace map can drop it (matched by the sk id from CONN_OPEN). */
SEC("kprobe/tcp_close")
int BPF_KPROBE(probe_tcp_close, struct sock *sk)
{
    emit_conn(sk, CONN_CLOSE);
    return 0;
}

/* ---- plaintext capture (ws://) ------------------------------------------- */

/* The set of pids to emit plaintext for — JS adds a pid when it arms a process
 * whose SSL uprobe didn't attach (so plaintext is the only way to see it), and
 * removes it on disarm. An empty set emits nothing, so the host-wide kprobes
 * below cost only a hash lookup per tcp_sendmsg/recvmsg until you arm. */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u32);
    __type(value, __u8);
    __uint(max_entries, 1024);
} focus_pids SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);
} frames SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u64);
    __type(value, struct read_args);
    __uint(max_entries, 10240);
} active_tcp_reads SEC(".maps");

static __always_inline void emit_frame(__u64 sk, __u64 buf, __u32 len, __u8 dir)
{
    if (len == 0)
        return;
    __u64 id = bpf_get_current_pid_tgid();
    __u32 pid = id >> 32;
    if (!bpf_map_lookup_elem(&focus_pids, &pid)) /* only armed pids; empty = none */
        return;

    struct ssl_event *e = bpf_ringbuf_reserve(&frames, sizeof(*e), 0);
    if (!e)
        return;
    if (fill_event(e, sk, buf, len, dir, TRANSPORT_TCP) < 0) {
        bpf_ringbuf_discard(e, 0);
        return;
    }
    bpf_ringbuf_submit(e, 0);
}

/* First data byte the iter points at: ITER_UBUF carries a bare user pointer;
 * ITER_IOVEC an array whose first element we follow. Other iter types (kvec /
 * bvec, kernel-internal) aren't user sendmsg/recvmsg payloads — skip them. */
static __always_inline __u64 iter_base(struct msghdr *msg)
{
    struct iov_iter it;
    if (bpf_core_read(&it, sizeof(it), &msg->msg_iter))
        return 0;
    if (it.iter_type == 0 /* ITER_UBUF */)
        return (__u64) it.ubuf;
    if (it.iter_type == 1 /* ITER_IOVEC */) {
        struct iovec iov;
        if (bpf_core_read(&iov, sizeof(iov), it.__iov))
            return 0;
        return (__u64) iov.iov_base;
    }
    return 0;
}

/* int tcp_sendmsg(struct sock *sk, struct msghdr *msg, size_t size) — the
 * plaintext is in the user iovec at entry. A single send is often scattered
 * across several iovec segments (a corked WebSocket frame arrives as separate
 * header + payload segments), so emit ONE event per segment rather than
 * concatenating in-kernel; the JS stream decoder reassembles per connection. */
SEC("kprobe/tcp_sendmsg")
int BPF_KPROBE(probe_tcp_sendmsg, struct sock *sk, struct msghdr *msg, __u64 size)
{
    if ((long) size <= 0)
        return 0;
    struct iov_iter it;
    if (bpf_core_read(&it, sizeof(it), &msg->msg_iter))
        return 0;
    if (it.iter_type == 0 /* ITER_UBUF */) {
        emit_frame((__u64) sk, (__u64) it.ubuf, (__u32) it.count, DIR_WRITE);
        return 0;
    }
    if (it.iter_type != 1 /* only plain ITER_IOVEC */)
        return 0;
    const struct iovec *iov = it.__iov;
    __u64 nr = it.nr_segs;
#pragma unroll
    for (int i = 0; i < 8; i++) {
        if ((__u64) i >= nr)
            break;
        struct iovec v;
        if (bpf_core_read(&v, sizeof(v), &iov[i]))
            break;
        if (v.iov_len)
            emit_frame((__u64) sk, (__u64) v.iov_base, (__u32) v.iov_len, DIR_WRITE);
    }
    return 0;
}

/* int tcp_recvmsg(struct sock *sk, struct msghdr *msg, size_t len, ...) — the
 * dest buffer is filled by return, so stash (sk, buf) at entry and copy it on
 * the return probe with the byte count, mirroring SSL_read. */
SEC("kprobe/tcp_recvmsg")
int BPF_KPROBE(probe_tcp_recvmsg_enter, struct sock *sk, struct msghdr *msg)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct read_args a = { .ssl = (__u64) sk, .buf = iter_base(msg) };
    if (a.buf)
        bpf_map_update_elem(&active_tcp_reads, &id, &a, BPF_ANY);
    return 0;
}

SEC("kretprobe/tcp_recvmsg")
int BPF_KRETPROBE(probe_tcp_recvmsg_exit, int ret)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct read_args *a = bpf_map_lookup_elem(&active_tcp_reads, &id);
    if (!a)
        return 0;
    __u64 sk = a->ssl, buf = a->buf;
    bpf_map_delete_elem(&active_tcp_reads, &id);
    if (ret > 0)
        emit_frame(sk, buf, (__u32) ret, DIR_READ);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
