//go:build darwin

package chathost

import "golang.org/x/sys/unix"

// children are the processes whose parent is ppid, from the kernel's
// process table.
func children(ppid int) []child {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil
	}
	var out []child
	for _, p := range procs {
		if int(p.Eproc.Ppid) == ppid && int(p.Proc.P_pid) != ppid {
			out = append(out, child{pid: int(p.Proc.P_pid), pgid: int(p.Eproc.Pgid)})
		}
	}
	return out
}
