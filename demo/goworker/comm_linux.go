package main

import (
	"syscall"
	"unsafe"
)

// setComm renames the process (comm) via prctl(PR_SET_NAME), so run.sh's
// comm-based worker identification treats the Go worker like the others.
// Best-effort — a failure just leaves the default comm.
func setComm(name string) {
	b := append([]byte(name), 0)
	if len(b) > 16 {
		b = b[:16]
		b[15] = 0
	}
	_, _, _ = syscall.Syscall(syscall.SYS_PRCTL, 15 /* PR_SET_NAME */, uintptr(unsafe.Pointer(&b[0])), 0)
}
