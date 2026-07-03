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

#include "tap.h"

/* wssnoop/ssl tap — capture the plaintext an OpenSSL-linked process hands to /
 * gets back from the TLS layer, so userspace can decode the WebSocket frames
 * riding inside an otherwise-encrypted `wss://` connection. This is the ONE
 * thing that sees plaintext for an in-process TLS connection (an outbound
 * `wss://` client, or a direct-TLS server) — the socket-layer tap only sees
 * ciphertext there. It's OpenSSL-only: Go's crypto/tls and rustls have no
 * SSL_read/SSL_write to hook and are invisible here by construction.
 *
 * This object hooks the classic byte-count API (SSL_read/SSL_write); the newer
 * SSL_read_ex/SSL_write_ex pair — which CPython, and so Python `websockets`,
 * actually calls — lives in probe_ex.bpf.c (see tap.h for why they're split).
 *
 * SSL_write(ssl, buf, num): the plaintext is in `buf` at entry — grab it on the
 *   uprobe. (egress / client->server, frames are masked.)
 * SSL_read(ssl, buf, num):  `buf` is only filled by the time SSL_read returns,
 *   and the byte count is the return value — so we stash the buffer pointer on
 *   the entry uprobe and copy it on the uretprobe. (ingress, unmasked.)
 *
 * The `SSL*` pointer (first arg) is stable for the life of a connection, so we
 * ship it as an opaque connection id and let JS demux streams by (pid, ssl,
 * direction). No WebSocket/HTTP parsing happens here.
 *
 * The events ringbuf, focus filter, active_reads map and emit() are shared with
 * the `_ex` object through tap.h. */

/* int SSL_write(SSL *ssl, const void *buf, int num) — plaintext at entry. */
SEC("uprobe")
int BPF_KPROBE(probe_ssl_write, void *ssl, const void *buf, int num)
{
    if (num > 0)
        emit((__u64) ssl, (__u64) buf, (__u32) num, DIR_WRITE);
    return 0;
}

/* int SSL_read(SSL *ssl, void *buf, int num) — buffer filled by return. */
SEC("uprobe")
int BPF_KPROBE(probe_ssl_read_enter, void *ssl, void *buf, int num)
{
    __u64 id = bpf_get_current_pid_tgid();
    struct read_args a = { .ssl = (__u64) ssl, .buf = (__u64) buf, .nread = 0 };
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
        emit(ssl, buf, (__u32) ret, DIR_READ);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
