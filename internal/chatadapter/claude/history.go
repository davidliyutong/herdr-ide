//go:build unix

package claude

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"herdr-ide/internal/agent/sessions"
	"herdr-ide/internal/agent/transcript"
	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

const (
	// maxHistory is the most of a transcript History reads, its end: an
	// earlier part is left out with a notice.
	maxHistory = 256 << 20
	// maxListed bounds the transcripts of a directory Sessions considers.
	maxListed = 4096
	// sessionHead and sessionTail are how much of a transcript's start and
	// end Sessions reads for its directory, its first prompt and its title.
	sessionHead = 1 << 20
	sessionTail = 256 << 10
	// maxHeadLines bounds the lines of the start read.
	maxHeadLines = 256
	// maxTitle bounds a session's title.
	maxTitle = 512
)

// sessionsPage is the most sessions a page of Sessions lists (a variable:
// tests make pages short).
var sessionsPage = 50

// envOf is a lookup in an environment of KEY=value strings.
func envOf(env []string) func(string) string {
	return func(k string) string {
		for i := len(env) - 1; i >= 0; i-- {
			if v, ok := strings.CutPrefix(env[i], k+"="); ok {
				return v
			}
		}
		return ""
	}
}

// resolver finds the agent's user's transcripts, in the home and with the
// CLAUDE_CONFIG_DIR of the agent's environment.
func resolver(env []string) *sessions.Resolver {
	get := envOf(env)
	return &sessions.Resolver{Home: get("HOME"), Getenv: get}
}

// History emits the stored events of a session's conversation, from its
// transcript (internal/agent/transcript's mapping), oldest first; after
// p.After, the item of the last event an earlier History emitted, only
// what came after it (the turns made in a terminal since). Items are named
// as the live session names them: a message's block "<message id>/<index>",
// a tool call by its id. Turns that end without a line saying so end at
// the next prompt, or at the transcript's end; the usage of each response
// is left out (the session states its own once it runs).
func (Adapter) History(ctx context.Context, p chatadapter.HistoryParams, emit func(chatproto.Event)) error {
	if !agentkinds.ValidSessionID(p.SessionID) {
		return badRequest("not a session id")
	}
	r := resolver(p.Env)
	f, _, err := r.OpenLocated(agentkinds.AdapterClaude, p.SessionID)
	if err != nil {
		if errors.Is(err, sessions.ErrNotFound) || errors.Is(err, sessions.ErrCompressed) {
			return &chatproto.Error{Code: chatproto.CodeNotFound, Message: "claude: no transcript of the session"}
		}
		return err
	}
	defer f.Close()
	if info, err := r.Describe(agentkinds.AdapterClaude, p.SessionID); err == nil && info.Cwd != "" && p.Cwd != "" && path.Clean(info.Cwd) != path.Clean(p.Cwd) {
		return badRequest("the session ran in another directory")
	}
	st, err := f.Stat()
	if err != nil {
		return err
	}
	h := &history{f: f, size: st.Size()}
	from := -1
	if p.After != "" {
		last := -1
		if err := h.walk(ctx, func(i int, ev chatproto.Event) {
			if ev.Item == p.After {
				last = i
			}
		}); err != nil {
			return err
		}
		if last < 0 {
			return &chatproto.Error{Code: chatproto.CodeNotFound, Message: "claude: the transcript has no item " + p.After}
		}
		from = last
	}
	// The turn's end the chat has after the item already.
	skipping := from >= 0
	return h.walk(ctx, func(i int, ev chatproto.Event) {
		if i <= from {
			return
		}
		if skipping && ev.T == chatproto.EventTurn && ev.State != chatproto.TurnStart {
			return
		}
		skipping = false
		emit(ev)
	})
}

// history is a read of a transcript into the chat's events.
type history struct {
	f    *os.File
	size int64
}

// walk calls fn with the transcript's events and their index, in order.
func (h *history) walk(ctx context.Context, fn func(int, chatproto.Event)) error {
	start := max(h.size-maxHistory, 0)
	n := 0
	put := func(ev chatproto.Event) {
		fn(n, ev)
		n++
	}
	if start > 0 {
		put(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeSkipped), Params: mustJSON(map[string]int64{"bytes": start})})
	}
	open := false
	blocks := map[string]int{}
	err := transcript.EachClaude(ctx, h.f, start, h.size, transcript.Limits{}, func(_ int64, fr transcript.Frame) bool {
		base := blocks[fr.Message]
		if fr.First >= 0 {
			base = fr.First
		}
		for k, tev := range fr.Events {
			ev := eventOf(tev)
			switch ev.T {
			case chatproto.EventTurn:
				switch {
				case ev.State == chatproto.TurnStart && open:
					// The turn before ended without a line saying so.
					put(chatproto.Event{T: chatproto.EventTurn, At: ev.At, State: chatproto.TurnEnd})
				case ev.State != chatproto.TurnStart && !open:
					// Claude Code records the end twice (the response's stop
					// and turn_duration).
					continue
				}
				open = ev.State == chatproto.TurnStart
			case chatproto.EventUpdate:
				hd := headOf(ev.Update)
				switch {
				case hd.SessionUpdate == "usage_update":
					continue
				case isChunk(hd.SessionUpdate) && fr.Message != "":
					ev.Item = itemOf(fr.Message, base+max(fr.Blocks[k], 0))
				case hd.ToolCallID != "":
					ev.Item = hd.ToolCallID
				}
			}
			put(ev)
		}
		if fr.Message != "" {
			blocks[fr.Message] = max(blocks[fr.Message], base+fr.Count)
		}
		return true
	})
	if err != nil {
		return err
	}
	if open {
		put(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnEnd})
	}
	return nil
}

// Sessions lists Claude Code's sessions of a directory, the most recently
// active first: the transcripts of its projects directory (of every
// configuration directory of the user's: $CLAUDE_CONFIG_DIR, ~/.claude,
// ~/.config/claude) that say they ran in it, each a regular file of the
// user's own reached through no symbolic link. The cursor is where the
// page before ended.
func (Adapter) Sessions(ctx context.Context, p chatadapter.SessionsParams) ([]chatproto.Session, string, error) {
	if !path.IsAbs(p.Cwd) {
		return nil, "", badRequest("the directory is not an absolute path")
	}
	cwd := path.Clean(p.Cwd)
	after, err := parseCursor(p.Cursor)
	if err != nil {
		return nil, "", err
	}
	var found []listed
	seen := map[string]bool{}
	for _, d := range resolver(p.Env).ClaudeDirs() {
		for _, f := range transcriptsOf(d, cwd) {
			if !seen[f.id] && f.after(after) {
				seen[f.id] = true
				found = append(found, f)
			}
		}
	}
	slices.SortFunc(found, func(a, b listed) int {
		if c := b.mod.Compare(a.mod); c != 0 {
			return c
		}
		return strings.Compare(a.id, b.id)
	})
	var out []chatproto.Session
	next := ""
	for i, f := range found {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		if len(out) == sessionsPage {
			next = found[i-1].cursor()
			break
		}
		info, ok := describe(f.path)
		if !ok || info.cwd != cwd {
			continue
		}
		out = append(out, chatproto.Session{SessionID: f.id, Cwd: cwd, Title: info.title, UpdatedAt: f.mod.UTC()})
	}
	return out, next, nil
}

// listed is a transcript Sessions found.
type listed struct {
	id, path string
	mod      time.Time
}

// cursor names the place of f in Sessions' order.
func (f listed) cursor() string { return strconv.FormatInt(f.mod.UnixNano(), 10) + ":" + f.id }

// after tells whether f comes after the cursor c in Sessions' order.
func (f listed) after(c *listed) bool {
	if c == nil {
		return true
	}
	if !f.mod.Equal(c.mod) {
		return f.mod.Before(c.mod)
	}
	return f.id > c.id
}

func parseCursor(s string) (*listed, error) {
	if s == "" {
		return nil, nil
	}
	ns, id, ok := strings.Cut(s, ":")
	n, err := strconv.ParseInt(ns, 10, 64)
	if !ok || err != nil || !agentkinds.ValidSessionID(id) {
		return nil, badRequest("not a cursor")
	}
	return &listed{id: id, mod: time.Unix(0, n)}, nil
}

// transcriptsOf are the transcripts in the projects directories of the
// configuration directory d that may hold cwd's (sessions.ClaudeProjectDirs).
// The projects directory is resolved through symlinks; nothing below it is
// followed.
func transcriptsOf(d, cwd string) []listed {
	root, err := filepath.EvalSymlinks(path.Join(d, "projects"))
	if err != nil || !path.IsAbs(root) {
		return nil
	}
	var out []listed
	for _, dir := range sessions.ClaudeProjectDirs(root, cwd) {
		for _, e := range readDir(dir, maxListed) {
			id, ok := strings.CutSuffix(e.Name(), ".jsonl")
			if !ok || !agentkinds.ValidSessionID(id) || !e.Type().IsRegular() {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			out = append(out, listed{id: id, path: path.Join(dir, e.Name()), mod: info.ModTime()})
		}
	}
	return out
}

// readDir reads at most n entries of a directory that is no symbolic link.
func readDir(dir string, n int) []os.DirEntry {
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		return nil
	}
	f, err := os.Open(dir)
	if err != nil {
		return nil
	}
	defer f.Close()
	ents, _ := f.ReadDir(n)
	return ents
}

// described is what Sessions reads of a transcript: its directory, its
// title, and the title the user or Claude Code gave the session
// (agentTitle; "" for none, title then the first prompt).
type described struct {
	cwd, title, agentTitle string
}

// describe reads a transcript's directory and title from its start and its
// end: the user's own title before one the agent made, the latest of each,
// else the first prompt; false when it cannot be read as a regular file of
// the user's own, or holds no conversation.
func describe(p string) (described, bool) {
	f, err := sessions.Open(p)
	if err != nil {
		return described{}, false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return described{}, false
	}
	var d described
	var title, custom, prompt string
	take := func(line []byte) {
		if d.cwd == "" && bytes.Contains(line, []byte(`"cwd"`)) {
			var v struct {
				Type string `json:"type"`
				Cwd  string `json:"cwd"`
			}
			if json.Unmarshal(line, &v) == nil && v.Cwd != "" && (v.Type == "user" || v.Type == "assistant" || v.Type == "system") {
				d.cwd = path.Clean(v.Cwd)
			}
		}
		fr := transcript.ClaudeFrame(line, transcript.Limits{Text: maxTitle})
		if fr.Title != "" {
			if fr.Custom {
				custom = fr.Title
			} else {
				title = fr.Title
			}
		}
		for _, ev := range fr.Events {
			if prompt == "" && ev.T == agentproto.TranscriptUser {
				prompt = promptText(ev.Content)
			}
		}
	}
	br := bufio.NewReaderSize(io.LimitReader(f, sessionHead), 64<<10)
	for range maxHeadLines {
		line, err := chatproto.ReadLine(br)
		if errors.Is(err, chatproto.ErrTooLarge) {
			if skipLine(br) != nil {
				break
			}
			continue
		}
		if err != nil {
			break
		}
		take(line)
	}
	if st.Size() > sessionHead {
		start := max(st.Size()-sessionTail, sessionHead)
		tr := bufio.NewReaderSize(io.NewSectionReader(f, start, st.Size()-start), 64<<10)
		// The first line read is a part of one.
		_ = skipLine(tr)
		for {
			line, err := chatproto.ReadLine(tr)
			if errors.Is(err, chatproto.ErrTooLarge) {
				if skipLine(tr) != nil {
					break
				}
				continue
			}
			if err != nil {
				break
			}
			take(line)
		}
	}
	if d.cwd == "" {
		return described{}, false
	}
	d.title = cut(strings.TrimSpace(cmp.Or(custom, title, prompt)), maxTitle)
	d.agentTitle = cut(strings.TrimSpace(cmp.Or(custom, title)), maxTitle)
	return d, true
}

// promptText is the text of a prompt's blocks, on one line.
func promptText(blocks []json.RawMessage) string {
	var parts []string
	for _, raw := range blocks {
		var b struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &b) == nil && b.Type == "text" && strings.TrimSpace(b.Text) != "" {
			parts = append(parts, strings.Join(strings.Fields(b.Text), " "))
		}
	}
	return strings.Join(parts, " ")
}
