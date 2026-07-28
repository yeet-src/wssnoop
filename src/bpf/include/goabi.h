/* Go's register ABI (ABIInternal, register-based since Go 1.17), in the shape of
 * bpf_tracing.h's PT_REGS_* accessors.
 *
 * Go does not use the platform C ABI, so PT_REGS_PARMn is not the right reader
 * for a Go function. On arm64 the two agree (both start at X0), which is why
 * PARMn appears to work there; on amd64 Go starts at RAX while the C ABI starts
 * at RDI, so PARMn silently reads unrelated registers.
 *
 * Include AFTER vmlinux.h and bpf_tracing.h — the field names are the kernel's
 * struct pt_regs, and the bpf_target_* guards come from bpf_tracing.h. */
#pragma once

#if defined(bpf_target_x86)

/* Integer/pointer args in order: RAX, RBX, RCX, RDI, RSI, R8, R9, R10, R11.
 * R14 is reserved for the current g. */
#define GO_PARM1(x) ((x)->ax)
#define GO_PARM2(x) ((x)->bx)
#define GO_PARM3(x) ((x)->cx)
#define GO_G(x)     ((x)->r14)

#elif defined(bpf_target_arm64)

/* Integer/pointer args in order: X0..X15. X28 is reserved for the current g. */
#define GO_PARM1(x) ((x)->regs[0])
#define GO_PARM2(x) ((x)->regs[1])
#define GO_PARM3(x) ((x)->regs[2])
#define GO_G(x)     ((x)->regs[28])

#else
#error "goabi.h: unsupported target architecture"
#endif
