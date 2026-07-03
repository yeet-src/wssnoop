// Dev helper: print the byte offset of runtime.g.goid (and the g pointer
// register) from a Go binary's DWARF, so the Go tap can read goid to pair a
// crypto/tls.(*Conn).Read entry with its return across goroutine migration.
//
//	go run . /tmp/go-worker
package main

import (
	"debug/dwarf"
	"debug/elf"
	"fmt"
	"os"
)

func main() {
	f, err := elf.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	d, err := f.DWARF()
	if err != nil {
		panic(err)
	}
	r := d.Reader()
	for {
		e, err := r.Next()
		if e == nil || err != nil {
			break
		}
		if e.Tag != dwarf.TagStructType {
			continue
		}
		if name, _ := e.Val(dwarf.AttrName).(string); name != "runtime.g" {
			continue
		}
		sub := d.Reader()
		sub.Seek(e.Offset)
		sub.Next() // the struct itself
		for {
			m, err := sub.Next()
			if m == nil || err != nil || m.Tag == 0 {
				break
			}
			if m.Tag == dwarf.TagMember {
				n, _ := m.Val(dwarf.AttrName).(string)
				off, _ := m.Val(dwarf.AttrDataMemberLoc).(int64)
				if n == "goid" || n == "m" || n == "stack" {
					fmt.Printf("runtime.g.%s @ offset %d (0x%x)\n", n, off, off)
				}
			}
		}
		return
	}
	fmt.Println("runtime.g not found in DWARF")
}
