//go:build linux

package chathost

import (
	"os"
	"strconv"
	"strings"
)

// children are the processes whose parent is ppid, from /proc/<pid>/stat.
func children(ppid int) []child {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var out []child
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == ppid {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		// pid (comm) state ppid pgrp ...; comm may hold spaces and
		// parentheses, so the fields start after the last ")".
		s := string(b)
		i := strings.LastIndexByte(s, ')')
		if i < 0 {
			continue
		}
		f := strings.Fields(s[i+1:])
		if len(f) < 3 {
			continue
		}
		parent, err1 := strconv.Atoi(f[1])
		pgrp, err2 := strconv.Atoi(f[2])
		if err1 == nil && err2 == nil && parent == ppid {
			out = append(out, child{pid: pid, pgid: pgrp})
		}
	}
	return out
}
