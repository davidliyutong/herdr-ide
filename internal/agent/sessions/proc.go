//go:build unix

package sessions

import (
	"bufio"
	"bytes"
	"os"
	"path"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// procEntry is a process of the process table.
type procEntry struct{ PID, PPID, PGID int }

const (
	// maxDepth and maxCandidates bound the descendants of a terminal's
	// program looked at (a wrapper script, a launcher and the agent).
	maxDepth      = 3
	maxCandidates = 32
	// maxProcs bounds the entries of /proc read.
	maxProcs = 1 << 16
	// maxFDs bounds the open files of a process looked at.
	maxFDs = 4096
	// maxEnviron bounds what is read of a process's environment.
	maxEnviron = 1 << 20
	// clockTicks is the unit of /proc's times (USER_HZ), 100 on every
	// architecture Linux reports them for.
	clockTicks = 100
)

// procfs is the /proc to read processes from, false when processes are read
// from the system's process table instead (macOS).
func (r *Resolver) procfs() (string, bool) {
	if r.procRoot != "" {
		return r.procRoot, true
	}
	if runtime.GOOS == "linux" {
		return "/proc", true
	}
	return "", false
}

// procTable lists at least the processes of pid's process group.
func (r *Resolver) procTable(pid int) ([]procEntry, error) {
	if r.table != nil {
		return r.table(pid)
	}
	if root, ok := r.procfs(); ok {
		return procfsTable(root)
	}
	return sysTable(pid)
}

// startOf is when process pid started; false when it is not known (the
// process is gone).
func (r *Resolver) startOf(pid int) (time.Time, bool) {
	if pid <= 0 {
		return time.Time{}, false
	}
	if r.started != nil {
		return r.started(pid)
	}
	if root, ok := r.procfs(); ok {
		return procfsStart(root, pid)
	}
	return sysStart(pid)
}

// environ is the variables of process pid's environment this package reads;
// false when it cannot be read (macOS, another user's process).
func (r *Resolver) environ(pid int) (map[string]string, bool) {
	root, ok := r.procfs()
	if !ok || pid <= 0 {
		return nil, false
	}
	return procfsEnviron(root, pid)
}

// candidates are pid and its descendants in pid's process group, breadth
// first, at most maxDepth generations and maxCandidates processes: the
// terminal's program may be a wrapper script or a launcher whose child is
// the agent.
func (r *Resolver) candidates(pid int) []int {
	out := []int{pid}
	table, err := r.procTable(pid)
	if err != nil {
		return out
	}
	pgid, found := 0, false
	for _, e := range table {
		if e.PID == pid {
			pgid, found = e.PGID, true
			break
		}
	}
	if !found {
		return out
	}
	children := map[int][]int{}
	for _, e := range table {
		if e.PGID == pgid && e.PID != pid && e.PID > 0 {
			children[e.PPID] = append(children[e.PPID], e.PID)
		}
	}
	seen := map[int]bool{pid: true}
	level := []int{pid}
	for depth := 0; depth < maxDepth && len(level) > 0; depth++ {
		var next []int
		for _, q := range level {
			kids := children[q]
			slices.Sort(kids)
			for _, c := range kids {
				if seen[c] {
					continue
				}
				if len(out) >= maxCandidates {
					return out
				}
				seen[c] = true
				out = append(out, c)
				next = append(next, c)
			}
		}
		level = next
	}
	return out
}

// procfsStat reads root/<pid>/stat: the parent, the process group and the
// start time in clock ticks after boot.
func procfsStat(root string, pid int) (ppid, pgid int, start uint64, ok bool) {
	b, err := readSmall(path.Join(root, strconv.Itoa(pid), "stat"), 4096)
	if err != nil {
		return 0, 0, 0, false
	}
	// The command name (field 2) is in parentheses and may hold anything,
	// ") " too: the other fields follow the last ')'.
	i := bytes.LastIndexByte(b, ')')
	if i < 0 {
		return 0, 0, 0, false
	}
	// f[0] is field 3 (state): the parent is field 4, the process group
	// field 5 and the start time field 22.
	f := strings.Fields(string(b[i+1:]))
	if len(f) < 20 {
		return 0, 0, 0, false
	}
	ppid, e1 := strconv.Atoi(f[1])
	pgid, e2 := strconv.Atoi(f[2])
	start, e3 := strconv.ParseUint(f[19], 10, 64)
	if e1 != nil || e2 != nil || e3 != nil {
		return 0, 0, 0, false
	}
	return ppid, pgid, start, true
}

// procfsTable reads the process table from root.
func procfsTable(root string) ([]procEntry, error) {
	traceOpen(root)
	f, err := os.OpenFile(root, os.O_RDONLY|unix.O_DIRECTORY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	names, err := f.Readdirnames(maxProcs)
	f.Close()
	if err != nil && len(names) == 0 {
		return nil, err
	}
	var out []procEntry
	for _, n := range names {
		pid, err := strconv.Atoi(n)
		if err != nil || pid <= 0 {
			continue
		}
		if ppid, pgid, _, ok := procfsStat(root, pid); ok {
			out = append(out, procEntry{PID: pid, PPID: ppid, PGID: pgid})
		}
	}
	return out, nil
}

// procfsStart is when process pid started: the boot time (root/stat's
// btime) plus its start time in clock ticks.
func procfsStart(root string, pid int) (time.Time, bool) {
	_, _, ticks, ok := procfsStat(root, pid)
	if !ok {
		return time.Time{}, false
	}
	boot, ok := procfsBoot(root)
	if !ok {
		return time.Time{}, false
	}
	d := time.Duration(ticks/clockTicks)*time.Second + time.Duration(ticks%clockTicks)*time.Second/clockTicks
	return boot.Add(d), true
}

// procfsBoot is the boot time of root/stat's btime line.
func procfsBoot(root string) (time.Time, bool) {
	f, err := openNoFollow(path.Join(root, "stat"))
	if err != nil {
		return time.Time{}, false
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		return time.Time{}, false
	}
	sc := bufio.NewScanner(f)
	// The interrupt counters' line can be long on a large machine.
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "btime "); ok {
			sec, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			if err != nil || sec <= 0 {
				return time.Time{}, false
			}
			return time.Unix(sec, 0), true
		}
	}
	return time.Time{}, false
}

// environKeys are the variables procfsEnviron keeps.
var environKeys = []string{"CLAUDE_CONFIG_DIR", "CLAUDE_CODE_CHILD_SESSION", "CODEX_HOME"}

// procfsEnviron reads the variables of environKeys from root/<pid>/environ
// (readable for the user's own processes only).
func procfsEnviron(root string, pid int) (map[string]string, bool) {
	b, err := readSmall(path.Join(root, strconv.Itoa(pid), "environ"), maxEnviron)
	if err != nil {
		return nil, false
	}
	env := map[string]string{}
	for kv := range bytes.SplitSeq(b, []byte{0}) {
		k, v, ok := bytes.Cut(kv, []byte{'='})
		if !ok {
			continue
		}
		if key := string(k); slices.Contains(environKeys, key) {
			env[key] = string(v)
		}
	}
	return env, true
}

// procfsFDs are the targets of root/<pid>/fd's links: the files process pid
// holds open.
func procfsFDs(root string, pid int) []string {
	dir := path.Join(root, strconv.Itoa(pid), "fd")
	var out []string
	for _, e := range readDir(dir, maxFDs) {
		if t, err := os.Readlink(path.Join(dir, e.Name())); err == nil && path.IsAbs(t) {
			out = append(out, path.Clean(t))
		}
	}
	return out
}
