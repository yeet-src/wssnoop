#define BPF_NO_KFUNC_PROTOTYPES

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#include "tap.h"

/* wssnoop/rustls tap — capture the plaintext a rustls program hands to / gets
 * back from its TLS layer. rustls is pure Rust with no OpenSSL symbols, and no
 * C ABI: its boundary functions are generic, monomorphized, and exported under
 * mangled names carrying a codegen hash, so the exact symbol is specific to a
 * given rustls+rustc build. libbpf resolves them from .symtab daemon-side, so
 * probe.js supplies the mangled names (see RUST_SYMS there); a build with
 * different versions needs the names regenerated (nm the binary).
 *
 * Egress crosses at ConnectionCommon::<T as PlaintextSink>::write(&mut self,
 * buf: &[u8]): the &[u8] is a fat pointer, so on arm64 the args land
 * X0 = &mut self, X1 = buf.ptr, X2 = buf.len — the same register shape as every
 * other write boundary, captured at entry. The connection (&mut self) pointer
 * is stable for the connection, so it doubles as the opaque id.
 *
 * Ingress crosses at CommonState::take_received_plaintext(&mut self, bytes:
 * Vec<u8>): the decrypt path hands the just-decrypted app-data Vec to this to
 * buffer it, so the plaintext is an *argument* at entry — no return capture
 * needed (validated: it fires per read; into_first_chunk/consume_first_chunk
 * don't). The bytes are 24 bytes passed indirectly, so X1 points to
 * {cap/marker @ +0, ptr @ +8, len @ +16} (cap carries a 0x8000… high-bit
 * marker — confirmed empirically). The `&mut self` (CommonState, X0) is the
 * same pointer PlaintextSink::write sees for egress, so both directions share
 * one connection id. */

/* fn write(&mut self, buf: &[u8]) -> io::Result<usize> — plaintext at entry. */
SEC("uprobe")
int BPF_KPROBE(probe_rust_tls_write, void *conn, void *ptr, __u64 len)
{
    if ((long) len > 0)
        emit((__u64) conn, (__u64) ptr, (__u32) len, DIR_WRITE);
    return 0;
}

/* fn take_received_plaintext(&mut self, bytes) — decrypted app data behind X1
 * as {cap @ +0, ptr @ +8, len @ +16}. */
SEC("uprobe")
int BPF_KPROBE(probe_rust_tls_read, void *conn, void *vec)
{
    __u64 ptr = 0, len = 0;
    if (bpf_probe_read_user(&ptr, sizeof(ptr), (const void *) ((__u64) vec + 8)) ||
        bpf_probe_read_user(&len, sizeof(len), (const void *) ((__u64) vec + 16)))
        return 0;
    if (len > 0 && len < (1u << 20))
        emit((__u64) conn, ptr, (__u32) len, DIR_READ);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
