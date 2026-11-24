package gui

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/machines"
)

// Errors of Enable.
var (
	ErrOff      = errors.New("program windows are off for this machine")
	ErrNotReady = errors.New("the display is not ready")
)

// EnableResult reports what Enable did.
type EnableResult struct {
	Enabled int      `json:"enabled"` // shells that got the variables typed in
	Already int      `json:"already"` // shells started with the display
	Busy    []string `json:"busy"`    // terminals running a program
	Typed   []string `json:"typed"`   // terminals typed into
	Failed  []string `json:"failed"`  // terminals that could not be reached
	Command string   `json:"command"` // what was typed, for the busy terminals
}

// ExportCommand is the shell command that sets env (values single-quoted;
// the leading space keeps it out of shell history where that is enabled).
func ExportCommand(env map[string]string) string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(" export")
	for _, k := range keys {
		b.WriteString(" " + k + "='" + strings.ReplaceAll(env[k], "'", `'\''`) + "'")
	}
	return b.String()
}

// Shells reaches the terminals that Enable types into: those of the
// machine's terminal core.
type Shells interface {
	// All lists every terminal, for an Enable without a list.
	All(ctx context.Context) ([]string, error)
	// Shell returns the pid of id's shell (0 when it has none) and whether
	// it waits at its prompt: an interactive shell is its own process
	// group, in the foreground while it reads a command line.
	Shell(ctx context.Context, id string) (pid int, idle bool, err error)
	// Send types text into id.
	Send(ctx context.Context, id, text string) error
}

// interruptPause lets a shell handle Ctrl-C before the command follows: the
// terminal discards input that arrives with the interrupt.
var interruptPause = 200 * time.Millisecond

// shellNames are the shells the export command is written for, by
// executable name; anything else in a terminal (a program that replaced its
// shell with exec, an agent) is never typed into.
var shellNames = map[string]bool{"bash": true, "zsh": true, "fish": true, "dash": true, "sh": true, "ksh": true, "mksh": true, "yash": true, "ash": true}

// Decisions of Enable for one terminal.
const (
	enableAlready = "already"
	enableBusy    = "busy"
	enableType    = "type"
)

// decide tells what Enable does with a terminal whose shell is p (nil when the
// agent could not see it): idle means it waits at its prompt, typed that
// the core typed the export into it before.
func decide(p *agentproto.GUIProc, idle, typed bool) string {
	switch {
	case typed || (p != nil && p.Display):
		return enableAlready
	case p == nil || !idle || !shellNames[p.Comm]:
		return enableBusy
	}
	return enableType
}

// shellProcs asks the machine's agent about the processes pids (action
// shells): which were started with the display, and their executables'
// names. A variable so tests can stand in for the agent.
var shellProcs = func(ctx context.Context, mc *machines.Machine, pids []string) (map[int]*agentproto.GUIProc, error) {
	conn, rep, err := mc.Open(ctx, agentproto.Header{Op: agentproto.OpGUI, Action: "shells", Args: pids})
	if err != nil {
		return nil, err
	}
	conn.Close()
	procs := map[int]*agentproto.GUIProc{}
	if rep.GUI != nil {
		for i := range rep.GUI.Procs {
			procs[rep.GUI.Procs[i].Pid] = &rep.GUI.Procs[i]
		}
	}
	return procs, nil
}

// typeExport discards a half-typed command line with Ctrl-C, then types
// cmd and Enter.
func typeExport(send func(text string) error, cmd string) error {
	if err := send("\x03"); err != nil {
		return err
	}
	time.Sleep(interruptPause)
	return send(cmd + "\r")
}

// Enable gives the shells of terminals that were opened without the
// display (before it existed, or outside the UI), reached through shells,
// the display's environment: a known shell waiting at its prompt gets
// Ctrl-C and the export command; the others are left alone and reported.
// ids defaults to all of them. One that cannot be reached is reported in
// Failed; the result always lists what was typed, also with an error.
func (m *Manager) Enable(ctx context.Context, mc *machines.Machine, shells Shells, ids []string) (*EnableResult, error) {
	if !m.enabled(mc.ID()) {
		return nil, ErrOff
	}
	env := m.PaneEnv(mc)
	if env == nil {
		return nil, ErrNotReady
	}
	if len(ids) == 0 {
		all, err := shells.All(ctx)
		if err != nil {
			return nil, err
		}
		ids = all
	}
	type shell struct {
		id   string
		pid  int
		idle bool
	}
	res := &EnableResult{Busy: []string{}, Typed: []string{}, Failed: []string{}, Command: ExportCommand(env)}
	var found []shell
	var pids []string
	for _, id := range ids {
		pid, idle, err := shells.Shell(ctx, id)
		switch {
		case err != nil:
			res.Failed = append(res.Failed, id)
		case pid == 0:
			res.Busy = append(res.Busy, id)
		default:
			found = append(found, shell{id, pid, idle})
			pids = append(pids, strconv.Itoa(pid))
		}
	}
	procs := map[int]*agentproto.GUIProc{}
	if len(pids) > 0 {
		var err error
		if procs, err = shellProcs(ctx, mc, pids); err != nil {
			return res, err // nothing typed yet
		}
	}
	for _, sh := range found {
		m.mu.Lock()
		typed := m.ds[mc.ID()].typed[sh.id] == env["DISPLAY"]
		m.mu.Unlock()
		switch decide(procs[sh.pid], sh.idle, typed) {
		case enableAlready:
			res.Already++
			continue
		case enableBusy:
			res.Busy = append(res.Busy, sh.id)
			continue
		}
		// Check again right before typing: the user may have started a
		// program meanwhile.
		pid, idle, err := shells.Shell(ctx, sh.id)
		if err != nil {
			res.Failed = append(res.Failed, sh.id)
			continue
		}
		if !idle || pid != sh.pid {
			res.Busy = append(res.Busy, sh.id)
			continue
		}
		send := func(text string) error { return shells.Send(ctx, sh.id, text) }
		if err := typeExport(send, res.Command); err != nil {
			res.Failed = append(res.Failed, sh.id)
			continue
		}
		m.mu.Lock()
		m.ds[mc.ID()].typed[sh.id] = env["DISPLAY"]
		m.mu.Unlock()
		res.Enabled++
		res.Typed = append(res.Typed, sh.id)
	}
	return res, nil
}
