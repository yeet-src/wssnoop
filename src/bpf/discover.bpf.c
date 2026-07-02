/* wssnoop/discover — layer-1 connection discovery, a separate loadable object
 * from the SSL tap (bin/discover.bpf.o, not linked into bin/probe.bpf.o).
 *
 * The tap (wssnoop.bpf.c) is expensive: a uprobe on every SSL call, per-binary.
 * To know *where* WebSocket traffic is without paying that, watch the kernel's
 * connection lifecycle instead — one fexit/tcp_connect catches every outbound
 * TCP connection (v4+v6) with the dialing pid, and tcp_close marks its end.
 * Per-connection, not per-byte, so it's cheap enough to run host-wide. JS
 * builds a live connection map from these, then attaches the tap (layer 2) only
 * to a process it decides is interesting.
 *
 * It lives in its own object because start() rejects an object with an
 * unattached uprobe program (YEET-DX-NOTES): discovery must load WITHOUT the
 * tap's SSL uprobes, so it can't share the tap's object. There's no enable
 * flag — being loaded is the enable; the JS `from()` lifecycle attaches while
 * the map is watched and detaches when it isn't. */

#define BPF_NO_KFUNC_PROTOTYPES

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_endian.h>

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
    __uint(max_entries, 1 << 18);   /* connection events are rare vs SSL bytes */
} conns SEC(".maps");

/* One discovery record for a sock. Reads the remote endpoint straight off the
 * sock_common, so it works for both v4 and v6 (v4 address in the first 4 bytes
 * of raddr). */
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

char LICENSE[] SEC("license") = "GPL";
