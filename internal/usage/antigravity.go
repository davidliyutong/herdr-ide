package usage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

// AgyTimeout bounds the agy CLI, the fallback when no language server runs.
const AgyTimeout = 20 * time.Second

const (
	// AgyEvery is the least time between two runs of agy that answered
	// with numbers: it takes seconds and a few hundred MB, so the polls in
	// between get its last answer.
	AgyEvery = 10 * time.Minute
	// AgyBackoff is how long agy is not run again after it failed or
	// timed out.
	AgyBackoff = 30 * time.Minute
)

// lsProcess is a running Antigravity language server.
type lsProcess struct {
	PID  int
	CSRF string
}

// antigravityAccounts reads Antigravity's model quotas from its local
// language server (GetUserStatus on 127.0.0.1, with the CSRF token of its
// command line), else from `agy -p /usage --output-format json`.
// An account the core names in Options.Skip (by the email's hash, known
// once the language server answered) or this machine's account without an
// id in SkipLocal is answered skipped.
func antigravityAccounts(ctx context.Context, e *Env, o *Options) []Account {
	if e.Command == nil {
		return []Account{{Provider: Antigravity, Status: StatusMissing}}
	}
	if o.skips(Antigravity, "", "") {
		return []Account{skipped(Account{Provider: Antigravity})}
	}
	procs := findLanguageServers(ctx, e)
	for _, p := range procs {
		for _, port := range listeningPorts(ctx, e, p.PID) {
			if m := getUserStatus(ctx, e, port, p.CSRF); m != nil {
				a := Account{Provider: Antigravity, Source: "ls"}
				if parseAntigravity(&a, m) {
					if o.skips(Antigravity, a.ID, "") {
						return []Account{skipped(a)}
					}
					a.Status, a.AsOf = StatusOK, e.now().Unix()
					return []Account{a}
				}
			}
		}
	}
	if a, ok := agyUsage(ctx, e); ok {
		if a.ID != "" && o.skips(Antigravity, a.ID, "") {
			return []Account{skipped(a)}
		}
		return []Account{a}
	}
	if len(procs) > 0 {
		return []Account{{Provider: Antigravity, Status: StatusError, Code: "no_answer"}}
	}
	return []Account{{Provider: Antigravity, Status: StatusMissing, Code: "not_running"}}
}

// findLanguageServers lists the agent's user's Antigravity language
// servers from ps (/bin/ps, else ps on the PATH).
func findLanguageServers(ctx context.Context, e *Env) []lsProcess {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := e.Command(ctx, e.Environ(), systemTool("/bin/ps"), "-ax", "-o", "uid=,pid=,command=")
	if err != nil && len(out) == 0 {
		return nil
	}
	return parsePS(out, e.UID)
}

// parsePS reads ps's uid, pid and command lines: the language servers of
// user uid with their CSRF token (other users' are never asked).
func parsePS(out []byte, uid int) []lsProcess {
	var ps []lsProcess
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		if u, err := strconv.Atoi(f[0]); err != nil || u != uid {
			continue
		}
		pid, err := strconv.Atoi(f[1])
		if err != nil {
			continue
		}
		low := strings.ToLower(strings.Join(f[2:], " "))
		if !strings.Contains(low, "language_server") || !strings.Contains(low, "antigravity") {
			continue
		}
		f = f[2:]
		csrf := ""
		for i, a := range f {
			if v, ok := strings.CutPrefix(a, "--csrf_token="); ok {
				csrf = v
			} else if a == "--csrf_token" && i+1 < len(f) {
				csrf = f[i+1]
			}
		}
		if csrf != "" {
			ps = append(ps, lsProcess{PID: pid, CSRF: csrf})
		}
	}
	return ps
}

// listeningPorts are the loopback TCP ports pid listens on: from /proc on
// Linux, from lsof (/usr/sbin/lsof, else on the PATH) elsewhere.
func listeningPorts(ctx context.Context, e *Env, pid int) []int {
	if e.GOOS == "linux" {
		return procPorts(e.ProcRoot, pid)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, _ := e.Command(ctx, e.Environ(), systemTool("/usr/sbin/lsof"), "-nP", "-a", "-p", strconv.Itoa(pid), "-iTCP", "-sTCP:LISTEN", "-Fn")
	return parseLsof(out)
}

func parseLsof(out []byte) []int {
	var ports []int
	for _, line := range strings.Split(string(out), "\n") {
		addr, ok := strings.CutPrefix(strings.TrimSpace(line), "n")
		if !ok {
			continue
		}
		i := strings.LastIndex(addr, ":")
		if i < 0 {
			continue
		}
		host := addr[:i]
		if host != "127.0.0.1" && host != "localhost" && host != "*" && host != "[::1]" {
			continue
		}
		if p, err := strconv.Atoi(addr[i+1:]); err == nil && p > 0 {
			ports = append(ports, p)
		}
	}
	return ports
}

// procPorts reads the sockets of pid (root/<pid>/fd) and the listening
// loopback ones among them (root/net/tcp, tcp6).
func procPorts(root string, pid int) []int {
	fds, err := os.ReadDir(path.Join(root, strconv.Itoa(pid), "fd"))
	if err != nil {
		return nil
	}
	inodes := map[string]bool{}
	for _, fd := range fds {
		l, err := os.Readlink(path.Join(root, strconv.Itoa(pid), "fd", fd.Name()))
		if err == nil && strings.HasPrefix(l, "socket:[") {
			inodes[strings.TrimSuffix(strings.TrimPrefix(l, "socket:["), "]")] = true
		}
	}
	var ports []int
	for _, f := range []string{"net/tcp", "net/tcp6"} {
		b, err := os.ReadFile(path.Join(root, f))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n")[1:] {
			fs := strings.Fields(line)
			if len(fs) < 10 || fs[3] != "0A" || !inodes[fs[9]] {
				continue
			}
			host, port, ok := strings.Cut(fs[1], ":")
			if !ok {
				continue
			}
			// Loopback (127.0.0.1 is 0100007F; ::1 and v4-mapped
			// loopback end the same way) or any address.
			if host != "0100007F" && host != "00000000" && !strings.HasSuffix(host, "01000000") && !strings.HasSuffix(host, "0100007F") && strings.Trim(host, "0") != "" {
				continue
			}
			if p, err := strconv.ParseInt(port, 16, 32); err == nil && p > 0 {
				ports = append(ports, int(p))
			}
		}
	}
	return ports
}

// getUserStatus asks the language server on port, over HTTPS and then
// HTTP; nil when it does not answer with an object.
func getUserStatus(ctx context.Context, e *Env, port int, csrf string) map[string]any {
	if e.LocalClient == nil {
		return nil
	}
	c := e.LocalClient(port)
	defer c.CloseIdleConnections()
	headers := map[string]string{"X-Codeium-Csrf-Token": csrf, "Connect-Protocol-Version": "1", "Content-Type": "application/json"}
	bodies := [][]byte{
		[]byte(`{"metadata":{"ideName":"antigravity","extensionName":"antigravity","locale":"en"}}`),
		[]byte(`{}`),
	}
	for _, scheme := range []string{"https", "http"} {
		url := scheme + "://127.0.0.1:" + strconv.Itoa(port) + "/exa.language_server_pb.LanguageServerService/GetUserStatus"
		for _, body := range bodies {
			m, err := getMap(ctx, c, "POST", url, headers, body)
			if err == nil {
				return m
			}
			if he, ok := err.(*httpError); ok && he.Code == "network" {
				break // try the other scheme
			}
		}
	}
	return nil
}

// parseAntigravity reads userStatus{email, name, planStatus.planInfo.planName,
// cascadeModelConfigData.clientModelConfigs[{label, quotaInfo{remainingFraction,
// resetTime}}]}; false when there are no quotas.
func parseAntigravity(a *Account, m map[string]any) bool {
	us := obj(m["userStatus"])
	if us == nil {
		us = m
	}
	a.Email = str(us["email"])
	a.ID = HashID(strings.ToLower(a.Email))
	a.Plan = str(obj(obj(us["planStatus"])["planInfo"])["planName"])
	cfgs := arr(obj(us["cascadeModelConfigData"])["clientModelConfigs"])
	for _, x := range cfgs {
		x := obj(x)
		q := obj(x["quotaInfo"])
		if q == nil {
			continue
		}
		rem, ok := num(q["remainingFraction"])
		if !ok {
			// A model with quota info but no fraction is exhausted.
			if _, has := q["resetTime"]; !has {
				continue
			}
			rem = 0
		}
		label := str(first(x, "label", "modelName", "model"))
		a.Windows = append(a.Windows, Window{Kind: KindModel, Label: label, UsedPct: clampPct((1 - rem) * 100), ResetsAt: timeOf(q["resetTime"])})
	}
	return len(a.Windows) > 0 || a.Email != ""
}

// agyUsage runs `agy -p /usage --output-format json` (no update, 20 s) and
// reads what it prints: the language server's shape, or a list of models
// with their remaining fraction or used percent. Within AgyEvery of a run
// that answered, or AgyBackoff of one that failed, it gives that run's
// answer again (Env.Memo) instead of running agy.
func agyUsage(ctx context.Context, e *Env) (Account, bool) {
	if e.LookPath == nil {
		return Account{}, false
	}
	bin, err := e.LookPath("agy")
	if err != nil {
		return Account{}, false
	}
	if a, ok := e.Memo.lastAgy(bin, e.now()); ok {
		return a, true
	}
	actx, cancel := context.WithTimeout(ctx, AgyTimeout)
	defer cancel()
	env := append(e.Environ(), "AGY_CLI_DISABLE_AUTO_UPDATE=true", "NO_COLOR=1")
	out, err := e.Command(actx, env, bin, "-p", "/usage", "--output-format", "json")
	a := Account{Provider: Antigravity, Source: "cli"}
	if ok := parseAgy(&a, out); !ok {
		a = Account{Provider: Antigravity, Status: StatusError, Code: "bad_response", Source: "cli"}
		if err != nil || len(out) == 0 {
			a.Code = "agy_failed"
		}
	} else {
		a.Status, a.AsOf = StatusOK, e.now().Unix()
	}
	// A run the caller cut short says nothing about agy.
	if ctx.Err() == nil {
		e.Memo.keepAgy(bin, a, e.now())
	}
	return a, true
}

// parseAgy reads agy's JSON output (the last JSON value it prints).
func parseAgy(a *Account, out []byte) bool {
	out = bytes.TrimSpace(out)
	if i := bytes.IndexAny(out, "{["); i > 0 {
		out = out[i:]
	}
	var v any
	dec := json.NewDecoder(bytes.NewReader(out))
	dec.UseNumber()
	if dec.Decode(&v) != nil {
		return false
	}
	v = normalizeJSON(v)
	// agy 1.5: {status, response (a table), command: {name: "usage", data:
	// {groups: [{name, buckets: [{name, window: weekly|5h,
	// remaining_fraction, reset_time}]}]}}}.
	if groups := arr(obj(obj(obj(v)["command"])["data"])["groups"]); len(groups) > 0 {
		for _, g := range groups {
			g := obj(g)
			group := str(g["name"])
			for _, b := range arr(g["buckets"]) {
				b := obj(b)
				r, ok := num(b["remaining_fraction"])
				if !ok {
					continue
				}
				kind, sec := KindModel, int64(0)
				switch str(b["window"]) {
				case "5h":
					kind, sec = KindSession, 5*3600
				case "weekly":
					kind, sec = KindWeekly, 7*86400
				}
				label := group
				if kind == KindModel {
					label = str(first(b, "name", "id"))
				}
				a.Windows = append(a.Windows, Window{Kind: kind, Label: label, UsedPct: clampPct((1 - r) * 100), ResetsAt: timeOf(b["reset_time"]), WindowSec: sec})
			}
		}
		if len(a.Windows) > 0 {
			return true
		}
	}
	if m := obj(v); m != nil {
		if r := obj(first(m, "result", "usage", "data")); r != nil {
			m = r
		}
		if parseAntigravity(a, m) && len(a.Windows) > 0 {
			return true
		}
		if email := str(first(m, "email", "account")); email != "" {
			a.Email, a.ID = email, HashID(strings.ToLower(email))
		}
		if a.Plan == "" {
			a.Plan = str(first(m, "plan", "planName", "tier"))
		}
		v = first(m, "models", "quotas", "limits")
	}
	for _, x := range arr(v) {
		x := obj(x)
		label := str(first(x, "label", "model", "name", "modelName"))
		var used float64
		if r, ok := num(first(x, "remainingFraction", "remaining_fraction")); ok {
			used = (1 - r) * 100
		} else if p, ok := num(first(x, "usedPercent", "used_percent", "usage_percent")); ok {
			used = p
		} else if r, ok := num(first(x, "remainingPercent", "remaining_percent")); ok {
			used = 100 - r
		} else {
			continue
		}
		a.Windows = append(a.Windows, Window{Kind: KindModel, Label: label, UsedPct: clampPct(used), ResetsAt: timeOf(first(x, "resetTime", "reset_time", "resetsAt", "resets_at"))})
	}
	return len(a.Windows) > 0
}
