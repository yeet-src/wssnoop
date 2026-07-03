#define BPF_NO_KFUNC_PROTOTYPES

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#include "tap.h"

/* wssnoop/ssl-ex tap — the SSL_read_ex / SSL_write_ex counterpart of
 * wssnoop.bpf.c. Same plaintext, same ringbuf (via tap.h), different symbols.
 *
 * These are the OpenSSL 1.1.1+ "ex" reads/writes: the count is reported through
 * an out-param (`size_t *`) and the return is a 0/1 status rather than a byte
 * count. CPython's _ssl calls exactly these, so Python `websockets` — and any
 * consumer built against modern OpenSSL — is only visible through this object,
 * not the classic SSL_read/SSL_write in probe.bpf.o.
 *
 * A separate loadable object because these symbols are absent from BoringSSL
 * and pre-1.1.1 OpenSSL, and start() rejects an object with any unattached
 * uprobe (see tap.h) — probe.js attaches this one best-effort so its absence
 * never disturbs the classic-API capture. */

/* int SSL_write_ex(SSL *ssl, const void *buf, size_t num, size_t *written)
 * — plaintext at entry, same as SSL_write. `num` is the buffer the app handed
 * us (a full WebSocket frame); capture it there. A short write only means fewer
 * bytes reached the wire, not that unseen frame bytes exist. */
SEC("uprobe")
int BPF_KPROBE(probe_ssl_write_ex, void *ssl, const void *buf, unsigned long num)
{
    if (num > 0)
        emit((__u64) ssl, (__u64) buf, (__u32) num, DIR_WRITE);
    return 0;
}

/* int SSL_read_ex(SSL *ssl, void *buf, size_t num, size_t *readbytes)
 * — like SSL_read, but the count lands in *readbytes and the return is a 0/1
 * status. Stash the buffer and the readbytes pointer on entry; deref it on
 * return once the buffer is filled. */
SEC("uprobe")
int BPF_KPROBE(probe_ssl_read_ex_enter, void *ssl, void *buf, unsigned long num, void *readbytes)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct read_args a = { .ssl = (__u64) ssl, .buf = (__u64) buf, .nread = (__u64) readbytes };
    bpf_map_update_elem(&active_reads, &id, &a, BPF_ANY);
    return 0;
}

SEC("uretprobe")
int BPF_KRETPROBE(probe_ssl_read_ex_exit, int ret)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct read_args *a = bpf_map_lookup_elem(&active_reads, &id);
    if (!a)
        return 0;

    __u64 ssl = a->ssl;
    __u64 buf = a->buf;
    __u64 nread = a->nread;
    bpf_map_delete_elem(&active_reads, &id);

    if (ret <= 0 || !nread) /* 0 = failure/retry; *readbytes is then untouched */
        return 0;

    __u64 n = 0;
    if (bpf_probe_read_user(&n, sizeof(n), (const void *) nread))
        return 0;
    if (n > 0)
        emit(ssl, buf, (__u32) n, DIR_READ);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
