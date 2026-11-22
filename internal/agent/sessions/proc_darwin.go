//go:build darwin

package sessions

import (
	"time"

	"golang.org/x/sys/unix"
)

// sysTable lists the processes of pid's process group (sysctl
// kern.proc.pgrp: no program is run).
func sysTable(pid int) ([]procEntry, error) {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return nil, err
	}
	ks, err := unix.SysctlKinfoProcSlice("kern.proc.pgrp", int(kp.Eproc.Pgid))
	if err != nil {
		return nil, err
	}
	out := make([]procEntry, 0, min(len(ks), maxProcs))
	for _, k := range ks {
		if len(out) >= maxProcs {
			break
		}
		out = append(out, procEntry{PID: int(k.Proc.P_pid), PPID: int(k.Eproc.Ppid), PGID: int(k.Eproc.Pgid)})
	}
	return out, nil
}

// sysStart is when process pid started (sysctl kern.proc.pid).
func sysStart(pid int) (time.Time, bool) {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || int(kp.Proc.P_pid) != pid {
		return time.Time{}, false
	}
	tv := kp.Proc.P_starttime
	return time.Unix(int64(tv.Sec), int64(tv.Usec)*1000), true
}
