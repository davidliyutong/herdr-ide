//go:build unix

package chathost

import (
	"os"
	"slices"
	"syscall"
)

// pider is what an adapter's Session may also be: one that tells its
// agent's process id, which is the id of the agent's process group (the
// adapters start every agent in a group of its own).
type pider interface{ PID() int }

// child is a process this one started.
type child struct{ pid, pgid int }

// targets are what a signal to the agents goes to: the process groups of
// the sessions that tell their process, and every child of the host, which
// an adapter started (an agent, an agent asked for its sessions) or the
// host did (the login shell). A child in a group of its own is signalled
// with its group; one in the host's group by itself.
type targets struct {
	groups []int // process group ids
	pids   []int // processes in the host's own group
}

// agentTargets collects the targets of sessions' processes and of the
// host's children.
func agentTargets(sessions []any) targets {
	var t targets
	own := syscall.Getpgrp()
	add := func(pid, pgid int) {
		switch {
		case pid <= 1:
		case pgid == own:
			if !slices.Contains(t.pids, pid) {
				t.pids = append(t.pids, pid)
			}
		case pgid > 1 && !slices.Contains(t.groups, pgid):
			t.groups = append(t.groups, pgid)
		}
	}
	for _, s := range sessions {
		if p, ok := s.(pider); ok {
			if pid := p.PID(); pid > 1 {
				add(pid, pid)
			}
		}
	}
	for _, c := range children(os.Getpid()) {
		add(c.pid, c.pgid)
	}
	return t
}

// signal sends sig to every target.
func (t targets) signal(sig syscall.Signal) {
	for _, g := range t.groups {
		syscall.Kill(-g, sig)
	}
	for _, p := range t.pids {
		syscall.Kill(p, sig)
	}
}
