#define BPF_NO_KFUNC_PROTOTYPES

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#include "tap.h"

/* wssnoop/go tap — capture the plaintext a Go program hands to / gets back from
 * crypto/tls, the pure-Go TLS stack that has no OpenSSL symbols for the SSL tap
 * to hook. Hooks the public wss:// data path, crypto/tls.(*Conn).Write/Read;
 * gorilla/websocket (and any net/http client) writes and reads WebSocket frames
 * straight through these.
 *
 * Go ABI (register-based since Go 1.17). On arm64 the first integer/pointer
 * args land in X0..X7 — the same registers the C ABI uses — so BPF_KPROBE's
 * PARMn read them directly. A method's receiver is arg 0, and a []byte passes
 * as three words (ptr, len, cap):
 *   func (c *Conn) Write(b []byte) (int, error)
 *     X0 = c, X1 = b.ptr, X2 = b.len, X3 = b.cap.
 * The *Conn pointer is stable for the connection's life, so it doubles as the
 * opaque connection id (like the SSL* for OpenSSL), and JS demuxes by
 * (pid, conn, direction).
 *
 * Egress only, for now: Write's plaintext is in `b` at entry, so one uprobe
 * suffices. Read fills its buffer by the time it returns and Go's runtime moves
 * goroutine stacks (which corrupts uretprobe trampolines), so ingress needs
 * uprobes placed at the function's RET sites plus goroutine-keyed state — added
 * separately. A separate loadable object (best-effort attach) because these
 * symbols exist only in an unstripped Go binary; see tap.h. */

/* func (c *Conn) Write(b []byte) (int, error) — plaintext in `b` at entry. */
SEC("uprobe")
int BPF_KPROBE(probe_go_tls_write, void *c, void *ptr, __u64 len)
{
    if ((long) len > 0)
        emit((__u64) c, (__u64) ptr, (__u32) len, DIR_WRITE);
    return 0;
}

/* Read fills its buffer by the time it returns and reports the count as the
 * return value, so we stash the buffer on entry and emit on return — as for
 * SSL_read, but with two Go twists:
 *
 *  - Keyed by goroutine id, not thread id. Read blocks on the network, and Go
 *    can resume the goroutine on a different OS thread, so the return fires on a
 *    different tid than entry; only the goid is stable across the call. The g
 *    pointer lives in X28 on arm64; goid sits at a fixed offset in runtime.g
 *    (below), read from the process's memory.
 *  - Uses a uretprobe for the return. Go's runtime relocates goroutine stacks,
 *    which can corrupt the uretprobe trampoline; if that proves unstable this
 *    switches to uprobes placed at the function's RET offsets. Validated per Go
 *    build before relying on it. */

/* runtime.g.goid byte offset — from the target's DWARF (go1.24 arm64). Go
 * version-specific; regenerate with demo/goworker/extract_goid for another
 * toolchain. */
#define GOID_OFF 0xa0
/* arm64 dedicates X28 to the current g (goroutine) pointer. */
#define GO_G_REG 28

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __type(key, __u64); /* goid */
    __type(value, struct read_args);
    __uint(max_entries, 10240);
} go_reads SEC(".maps");

static __always_inline __u64 go_goid(struct pt_regs *ctx)
{
    __u64 g = ctx->regs[GO_G_REG], goid = 0;
    bpf_probe_read_user(&goid, sizeof(goid), (const void *) (g + GOID_OFF));
    return goid;
}

/* func (c *Conn) Read(b []byte) (int, error) — buffer filled by return. */
SEC("uprobe")
int probe_go_tls_read_enter(struct pt_regs *ctx)
{
    struct read_args a = { .ssl = PT_REGS_PARM1(ctx), .buf = PT_REGS_PARM2(ctx), .nread = 0 };
    __u64 goid = go_goid(ctx);
    bpf_map_update_elem(&go_reads, &goid, &a, BPF_ANY);
    return 0;
}

SEC("uretprobe")
int probe_go_tls_read_exit(struct pt_regs *ctx)
{
    __u64 goid = go_goid(ctx);
    struct read_args *a = bpf_map_lookup_elem(&go_reads, &goid);
    if (!a)
        return 0;
    __u64 conn = a->ssl, buf = a->buf;
    bpf_map_delete_elem(&go_reads, &goid);

    long n = PT_REGS_RC(ctx); /* first return value (int n) in X0 */
    if (n > 0)
        emit(conn, buf, (__u32) n, DIR_READ);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
