//go:build unix

// Package agents is the machine side of the agents plugin
// (internal/plugins/agents): it reads the session transcripts of the coding
// agents of this machine for the native view of their conversations. A
// request names a transcript by its agent's kind and session id, never by
// a path: the id is checked before it reaches one, the transcript is found
// inside the kind's own session root (internal/agent/sessions) and opened
// as a regular file only, and it is read a page at a time
// (internal/agent/transcript). Both actions only read; the plugin keeps
// nothing between requests but where it found transcripts:
//
//   - tail (agentproto.TailRequest → agentproto.TailReply): a page of each
//     of up to agentproto.MaxTailRefs transcripts, together at most
//     MaxReplyBytes; when none has anything new it waits up to WaitMS (at
//     most agentproto.MaxTailWait) for one to grow or to appear, and the
//     wait ends with the core's request. At most MaxReads transcripts are
//     read at once on the machine; the others wait their turn, until their
//     request ends;
//   - resolve (agentproto.ResolveRequest → agentproto.ResolveReply): whether
//     a session's transcript exists and ran in a directory, which is only
//     compared with the one the transcript records, never opened.
//
// Replies carry codes, never an error's text: that would name a path of
// the machine.
package agents

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"path"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agent/sessions"
	"herdr-ide/internal/agent/transcript"
	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/agentproto"
)

// ID names the plugin on every side.
const ID = "agents"

// The plugin's actions.
const (
	ActionTail    = "tail"
	ActionResolve = "resolve"
)

const (
	// MaxReplyBytes bounds the pages of one tail together: the refs share
	// it, each page taking at most agentproto.MaxTailBytes (8 refs take
	// 512 KiB each). A reply above agentproto.MaxInline travels as a body
	// after its line (plugin.Reply).
	MaxReplyBytes = 4 << 20
	// MaxCwd bounds the directory a resolve compares.
	MaxCwd = 4096
	// MaxReads is how many transcript reads run at once on a machine: each
	// may read tens of megabytes of its file (transcript.Tail), and the
	// machine's agent carries its terminals.
	MaxReads = 2
)

// reads holds a token of each transcript read that runs.
var reads = make(chan struct{}, MaxReads)

// acquire waits for a read's turn (release ends it); false when ctx ended
// first.
func acquire(ctx context.Context) (release func(), ok bool) {
	if ctx.Err() != nil {
		return nil, false
	}
	select {
	case reads <- struct{}{}:
		return func() { <-reads }, true
	case <-ctx.Done():
		return nil, false
	}
}

var (
	// tailFile reads a page of a transcript (transcript.Tail); tests count
	// the reads.
	tailFile = transcript.Tail
	// pollEvery is how often a waiting tail looks at the transcripts it
	// waits on (a stat and, when the file grew, a read of its last line).
	pollEvery = 250 * time.Millisecond
	// relocateEvery is how often a waiting tail looks again for transcripts
	// that were not found: an agent writes its transcript at the first
	// prompt, not when it starts.
	relocateEvery = time.Second
)

func init() { plugin.Register(ID, handle) }

func handle(ctx context.Context, st net.Conn, action string, params json.RawMessage, env *plugin.Env) error {
	switch action {
	case ActionTail:
		var req agentproto.TailRequest
		if err := plugin.Decode(params, &req); err != nil {
			return plugin.Reply(st, nil, err)
		}
		if n := len(req.Refs); n == 0 || n > agentproto.MaxTailRefs {
			return plugin.Reply(st, nil, plugin.Errorf("bad_params", "agents: %d refs, not 1 to %d", n, agentproto.MaxTailRefs))
		}
		// The core sends nothing after the header: a wait ends when it
		// gives up on the request.
		ctx, cancel := plugin.UntilClosed(ctx, st)
		defer cancel()
		return plugin.Reply(st, tail(ctx, resolver(env), req), nil)
	case ActionResolve:
		var req agentproto.ResolveRequest
		if err := plugin.Decode(params, &req); err != nil {
			return plugin.Reply(st, nil, err)
		}
		return plugin.Reply(st, resolve(resolver(env), req), nil)
	}
	return plugin.Reply(st, nil, plugin.Errorf("bad_params", "agents: unknown action %q", action))
}

var (
	resolverMu sync.Mutex
	shared     *sessions.Resolver
)

// resolver is the plugin's sessions.Resolver, one for every request, so
// that the places of the transcripts it found are kept between them; a
// different home (an agent's tests) gets a new one.
func resolver(env *plugin.Env) *sessions.Resolver {
	home := ""
	if env != nil {
		home = env.Home
	}
	resolverMu.Lock()
	defer resolverMu.Unlock()
	if shared == nil || shared.Home != home {
		shared = &sessions.Resolver{Home: home}
	}
	return shared
}

// parser is the transcript parser of an agent's kind
// (agentkinds.Kind.Transcript); "" for a kind without transcripts.
func parser(kind string) string {
	k, ok := agentkinds.ByID(kind)
	if !ok {
		return ""
	}
	return k.Transcript
}

// validCwd reports whether s can be the directory of a resolve: an
// absolute POSIX path of at most MaxCwd bytes of UTF-8 without NUL.
func validCwd(s string) bool {
	return s != "" && len(s) <= MaxCwd && s[0] == '/' && utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}

// resolve answers whether the session's transcript exists and records the
// request's directory. A transcript that records none yet is answered as
// not found: it holds no conversation to resume.
func resolve(res *sessions.Resolver, req agentproto.ResolveRequest) agentproto.ResolveReply {
	if parser(req.Kind) == "" || !agentkinds.ValidSessionID(req.Session) || !validCwd(req.Cwd) {
		return agentproto.ResolveReply{Code: agentproto.TranscriptBadRequest}
	}
	info, err := res.Describe(req.Kind, req.Session)
	switch {
	case errors.Is(err, sessions.ErrCompressed):
		return agentproto.ResolveReply{Code: agentproto.TranscriptCompressed}
	case err != nil, info.Cwd == "":
		return agentproto.ResolveReply{Code: agentproto.TranscriptNotFound}
	case path.Clean(info.Cwd) != path.Clean(req.Cwd):
		return agentproto.ResolveReply{Code: agentproto.ResolveOtherCwd}
	}
	return agentproto.ResolveReply{OK: true}
}

// readRef reads a page of one ref's transcript, and gives the transcript's
// path while it is found. A transcript that cannot be opened or read is
// answered as one not found: the error would name its path. A read whose
// ctx ends before or while it runs gives the cursor back (nobody reads its
// reply).
func readRef(ctx context.Context, res *sessions.Resolver, ref agentproto.TranscriptRef, lim transcript.Limits) (agentproto.TranscriptTail, string) {
	fail := func(code string) (agentproto.TranscriptTail, string) {
		return agentproto.TranscriptTail{Kind: ref.Kind, Session: ref.Session, First: ref.From, Next: ref.From, Code: code}, ""
	}
	p := parser(ref.Kind)
	if p == "" || !agentkinds.ValidSessionID(ref.Session) {
		return fail(agentproto.TranscriptBadRequest)
	}
	release, ok := acquire(ctx)
	if !ok {
		return fail("")
	}
	defer release()
	// Found and opened as one step: the file read is the one that was
	// found, whatever its directories became in between.
	f, file, err := res.OpenLocated(ref.Kind, ref.Session)
	switch {
	case errors.Is(err, sessions.ErrCompressed):
		return fail(agentproto.TranscriptCompressed)
	case err != nil:
		return fail(agentproto.TranscriptNotFound)
	}
	defer f.Close()
	t, err := tailFile(ctx, p, f, ref, lim)
	switch {
	case ctx.Err() != nil:
		return fail("")
	case err != nil:
		return fail(agentproto.TranscriptNotFound)
	}
	return t, file.Path
}

// waitOf is the wait of a request's WaitMS: none for 0 or less, at most
// agentproto.MaxTailWait.
func waitOf(ms int) time.Duration {
	return time.Duration(min(max(ms, 0), int(agentproto.MaxTailWait/time.Millisecond))) * time.Millisecond
}

// readAll reads every ref, one file open at a time.
func readAll(ctx context.Context, res *sessions.Resolver, refs []agentproto.TranscriptRef, lim transcript.Limits) ([]agentproto.TranscriptTail, []string) {
	tails := make([]agentproto.TranscriptTail, len(refs))
	paths := make([]string, len(refs))
	for i, ref := range refs {
		tails[i], paths[i] = readRef(ctx, res, ref, lim)
	}
	return tails, paths
}

// news tells whether tails are answered at once: one has events, a forward
// read moved its cursor (over lines that made none) or stopped at a limit,
// or a page before a cursor was read (waiting changes nothing of it); and,
// against base, the tails the wait read last, a transcript was found,
// replaced or lost.
func news(refs []agentproto.TranscriptRef, tails, base []agentproto.TranscriptTail) bool {
	for i, t := range tails {
		ref := refs[i]
		switch {
		case len(t.Events) > 0,
			!ref.Back && (t.Next != ref.From || t.More),
			ref.Back && ref.From != 0,
			base != nil && (t.Code != base[i].Code || t.File != base[i].File):
			return true
		}
	}
	return false
}

// tail reads the refs' pages and, when none has anything new and the
// request waits, waits until one has or the wait is over (ctx ending
// too): it looks at the files of the refs that read on from their end (a
// forward read, a view's first read) every pollEvery, and for the
// transcripts not found every relocateEvery, holding no file open in
// between, and reads every ref again on a change. A read again that has
// nothing new (lines were appended that make no event) is where the wait
// goes on from: the next look compares with its ends, and the lines are
// not read again until more are appended.
func tail(ctx context.Context, res *sessions.Resolver, req agentproto.TailRequest) agentproto.TailReply {
	refs := req.Refs
	lim := transcript.Limits{Bytes: min(agentproto.MaxTailBytes, MaxReplyBytes/len(refs))}
	first, paths := readAll(ctx, res, refs, lim)
	wait := waitOf(req.WaitMS)
	if wait <= 0 || ctx.Err() != nil || news(refs, first, nil) {
		return agentproto.TailReply{Tails: first}
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	tick := time.NewTicker(pollEvery)
	defer tick.Stop()
	looked := time.Now()
	for {
		select {
		case <-ctx.Done():
			return agentproto.TailReply{Tails: first}
		case <-timer.C:
			return agentproto.TailReply{Tails: first}
		case <-tick.C:
		}
		relocate := time.Since(looked) >= relocateEvery
		if relocate {
			looked = time.Now()
		}
		if !grown(res, refs, first, paths, relocate) {
			continue
		}
		again, found := readAll(ctx, res, refs, lim)
		if ctx.Err() != nil {
			return agentproto.TailReply{Tails: first}
		}
		if news(refs, again, first) {
			return agentproto.TailReply{Tails: again}
		}
		first, paths = again, found
	}
}

// grown tells whether a waiting tail reads again: a transcript it watches
// has a line after where its read ended, or was replaced, truncated or
// lost; or, with relocate, a transcript that was not found now is.
func grown(res *sessions.Resolver, refs []agentproto.TranscriptRef, first []agentproto.TranscriptTail, paths []string, relocate bool) bool {
	for i, ref := range refs {
		t := first[i]
		switch {
		case paths[i] != "" && t.Code == "" && (!ref.Back || ref.From == 0):
			f, err := sessions.Open(paths[i])
			if err != nil {
				return true
			}
			changed := transcript.Changed(f, t.Next)
			f.Close()
			if changed {
				return true
			}
		case relocate && t.Code == agentproto.TranscriptNotFound:
			if _, err := res.Locate(ref.Kind, ref.Session); !errors.Is(err, sessions.ErrNotFound) {
				return true
			}
		}
	}
	return false
}
