/* vmlinux.h dumped from a recent kernel emits a block of kfunc/ksym
 * prototypes (e.g. bpf_stream_vprintk) that collide with the ones in an
 * older bundled bpf_helpers.h. We call no kfuncs, so suppress that block
 * — bpf_helpers.h supplies every helper we use. */
#define BPF_NO_KFUNC_PROTOTYPES

/* The bpftool-generated vmlinux.h emits forward declarations the kernel
 * BTF dump can't fully resolve, which clang flags under -Wall. Harmless
 * — silence them for this header alone, leaving -Wall live below. */
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

/* wssnoop — tap the plaintext that an OpenSSL-linked process hands to /
 * gets back from the TLS layer, so userspace can decode the WebSocket
 * frames riding inside an otherwise-encrypted `wss://` connection.
 *
 * SSL_write(ssl, buf, num): the plaintext is in `buf` at entry — grab it
 *   on the uprobe. (egress / client->server, frames are masked.)
 * SSL_read(ssl, buf, num):  `buf` is only filled by the time SSL_read
 *   returns, and the byte count is the return value — so we stash the
 *   buffer pointer on the entry uprobe and copy it on the uretprobe.
 *   (ingress / server->client, frames are not masked.)
 *
 * The `SSL*` pointer (first arg) is stable for the life of a connection,
 * so we ship it as an opaque connection id and let JS demux streams by
 * (pid, ssl, direction). No WebSocket/HTTP parsing happens here. */

#define CHUNK    4096     /* payload bytes captured per SSL call (power of 2).
                           * The whole struct (incl. this array) is decoded into
                           * a JS object PER ring event, so its size is the
                           * dominant per-event allocation — keep it tight. WS
                           * control/JSON messages are almost always < 1 KB; a
                           * larger SSL call is reported truncated (state marks
                           * the conn) rather than captured whole. */
#define CAP_MASK 0x0fff   /* `cap &= CAP_MASK` bounds the copy for the verifier;
                           * caps capture at 4095 bytes (one short of CHUNK). */

#define DIR_READ  0       /* ingress: bytes coming up out of SSL_read  */
#define DIR_WRITE 1       /* egress:  bytes going down into SSL_write  */

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

/* Anchor the struct in BTF so the loader can decode ringbuf records by
 * the type name "ssl_event" (the `btf_struct` passed to .bind in JS). */
__attribute__((used)) static const struct ssl_event __ssl_event_anchor;

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);
} events SEC(".maps");

/* SSL_read fills its buffer asynchronously, so carry the (ssl, buf) pair
 * from the entry uprobe to the return uretprobe, keyed by the calling
 * thread. A hash (not a single slot) tolerates nested/recursive TLS use. */
struct read_args {
    __u64 ssl;
    __u64 buf;
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u64);
    __type(value, struct read_args);
    __uint(max_entries, 10240);
} active_reads SEC(".maps");

/* The same carry-the-buffer trick for tcp_recvmsg (the plaintext recv path). A
 * separate map from active_reads so an SSL_read and a tcp_recvmsg on one thread
 * can't clobber each other. */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u64);
    __type(value, struct read_args);
    __uint(max_entries, 10240);
} active_tcp_reads SEC(".maps");

/* User-writable capture filter — the user->kernel control path. JS writes two
 * slots live (yeet:bpf ArrayMap.update): slot 0 a focus SSL*, slot 1 a focus
 * pid. When a slot is nonzero, only matching events are emitted; zero (the
 * default) captures everything. Filtering happens before the ringbuf reserve,
 * so muted traffic costs almost nothing — the "target one connection on a busy
 * production node, zero overhead for the rest" story. */
#define FOCUS_SSL 0
#define FOCUS_PID 1
#define FOCUS_TCP 2   /* plaintext-TCP capture enable (0 = off, the default) */
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __type(key, __u32);
    __type(value, __u64);
    __uint(max_entries, 3);
} focus SEC(".maps");

/* Plaintext TCP capture (ws://) is off unless the user asks for it: the kprobes
 * below fire host-wide on every tcp_sendmsg/recvmsg, so gate emission on a flag
 * JS sets only with --plaintext. Cheap (one array lookup) when off. */
static __always_inline int tcp_enabled(void)
{
    __u32 k = FOCUS_TCP;
    __u64 *v = bpf_map_lookup_elem(&focus, &k);
    return v && *v;
}

static __always_inline void emit(__u64 ssl, __u64 buf, __u32 len, __u8 dir, __u8 transport)
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

    e->ts = bpf_ktime_get_ns();
    e->ssl = ssl;
    e->pid = pid;
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
    if (cap && bpf_probe_read_user(e->data, cap, (const void *) buf)) {
        bpf_ringbuf_discard(e, 0);
        return;
    }

    bpf_ringbuf_submit(e, 0);
}

/* int SSL_write(SSL *ssl, const void *buf, int num) — plaintext at entry. */
SEC("uprobe")
int BPF_KPROBE(probe_ssl_write, void *ssl, const void *buf, int num)
{
    if (num > 0)
        emit((__u64) ssl, (__u64) buf, (__u32) num, DIR_WRITE, TRANSPORT_TLS);
    return 0;
}

/* int SSL_read(SSL *ssl, void *buf, int num) — buffer filled by return. */
SEC("uprobe")
int BPF_KPROBE(probe_ssl_read_enter, void *ssl, void *buf, int num)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct read_args a = { .ssl = (__u64) ssl, .buf = (__u64) buf };
    bpf_map_update_elem(&active_reads, &id, &a, BPF_ANY);
    return 0;
}

SEC("uretprobe")
int BPF_KRETPROBE(probe_ssl_read_exit, int ret)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct read_args *a = bpf_map_lookup_elem(&active_reads, &id);
    if (!a)
        return 0;

    __u64 ssl = a->ssl;
    __u64 buf = a->buf;
    bpf_map_delete_elem(&active_reads, &id);

    if (ret > 0)
        emit(ssl, buf, (__u32) ret, DIR_READ, TRANSPORT_TLS);
    return 0;
}

/* ---- plaintext TCP (ws://) ----------------------------------------------
 *
 * Non-TLS WebSocket data rides a plain TCP socket: no SSL_* to hook, so tap the
 * kernel's tcp_sendmsg / tcp_recvmsg instead. `struct sock *sk` is the stable
 * per-connection id (the TCP analogue of SSL*). The payload lives in the user
 * iovec behind msg->msg_iter; we read its first segment (covers the single-iov
 * common case for both ITER_UBUF and ITER_IOVEC). These fire host-wide, so they
 * no-op unless --plaintext set the enable flag (tcp_enabled). */

/* First data byte the iter points at: ITER_UBUF carries a bare user pointer;
 * ITER_IOVEC an array whose first element we follow. Other iter types (kvec /
 * bvec, kernel-internal) aren't user sendmsg/recvmsg payloads — skip them. */
static __always_inline __u64 iter_base(struct msghdr *msg)
{
    /* Copy the embedded iov_iter out, then read its (anonymous-union) members
     * locally — a comma-chain BPF_CORE_READ can't walk an embedded struct. */
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
 * plaintext is in the user iovec at entry, same as SSL_write. A single send is
 * often scattered across several iovec segments (a corked WebSocket frame
 * arrives as separate header + payload segments), so emit ONE event per segment
 * rather than concatenating in-kernel: each goes through the same fixed-offset
 * emit() (the verifier balks at variable-offset ringbuf writes), and the JS
 * stream decoder reassembles the segments back into frames per connection. */
SEC("kprobe/tcp_sendmsg")
int BPF_KPROBE(probe_tcp_sendmsg, struct sock *sk, struct msghdr *msg, __u64 size)
{
    if (!tcp_enabled() || (long) size <= 0)
        return 0;
    struct iov_iter it;
    if (bpf_core_read(&it, sizeof(it), &msg->msg_iter))
        return 0;
    if (it.iter_type == 0 /* ITER_UBUF */) {
        emit((__u64) sk, (__u64) it.ubuf, (__u32) it.count, DIR_WRITE, TRANSPORT_TCP);
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
            emit((__u64) sk, (__u64) v.iov_base, (__u32) v.iov_len, DIR_WRITE, TRANSPORT_TCP);
    }
    return 0;
}

/* int tcp_recvmsg(struct sock *sk, struct msghdr *msg, size_t len, ...) — the
 * dest buffer is filled by return, so stash (sk, buf) at entry and copy it on
 * the return probe with the byte count, mirroring SSL_read. */
SEC("kprobe/tcp_recvmsg")
int BPF_KPROBE(probe_tcp_recvmsg_enter, struct sock *sk, struct msghdr *msg)
{
    if (!tcp_enabled())
        return 0;
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
        emit(sk, buf, (__u32) ret, DIR_READ, TRANSPORT_TCP);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
