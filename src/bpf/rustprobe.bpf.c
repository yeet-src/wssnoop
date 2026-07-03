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
 * Ingress (rustls CommonState::take_received_plaintext) returns the decrypted
 * bytes by value, a harder return-ABI case, added separately. */

/* fn write(&mut self, buf: &[u8]) -> io::Result<usize> — plaintext at entry. */
SEC("uprobe")
int BPF_KPROBE(probe_rust_tls_write, void *conn, void *ptr, __u64 len)
{
    if ((long) len > 0)
        emit((__u64) conn, (__u64) ptr, (__u32) len, DIR_WRITE);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
