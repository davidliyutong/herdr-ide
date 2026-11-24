//go:build unix

// Package usage is the machine side of the AI usage plugin
// (internal/plugins/usage): it reads the subscriptions' limits and the
// logs' cost on the machine with internal/usage and answers with numbers
// only. Actions:
//
//   - limits {providers, codexHomes, claudeKeychain, kimiRefresh, skip,
//     skipLocal}: the accounts the CLIs are signed in to, with their windows
//     and balances, until the core stops waiting (an ended Kimi Code token
//     is renewed first with kimiRefresh);
//   - cost {since, tzOffset, codexHomes, providers}: the logs' tokens and
//     cost by day, model and project (Antigravity's conversation databases
//     and OpenCode's sessions from their databases, read-only), until the
//     core stops waiting;
//   - setDeepseekKey {key}: writes (or with "" removes) the DeepSeek key
//     file; the key is never read back;
//   - session {kind, session, prices}: what one session of a coding agent
//     used (agentproto.SessionUsage), from its transcripts, which the agent
//     finds by the kind and the session id (internal/agent/sessions) and
//     opens as the files it found, through no symbolic link.
package usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agent/sessions"
	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/usage"
)

// limitsShare is how long the limits one core fetched answer the same
// request of the other cores its node serves, so the cores of a machine
// ask the providers about once between them.
var limitsShare = time.Minute

type sharedResult struct {
	client, params string
	at             time.Time
	accounts       any
}

var (
	limitsMu   sync.Mutex
	lastLimits = map[string]sharedResult{}
)

// sharedLimits returns the limits another core fetched with the same params
// for e's data directory less than limitsShare ago.
func sharedLimits(e *plugin.Env, params json.RawMessage) (any, bool) {
	if e.Client == "" {
		return nil, false
	}
	limitsMu.Lock()
	defer limitsMu.Unlock()
	last, ok := lastLimits[e.Base]
	if !ok || last.client == e.Client || last.params != string(params) || time.Since(last.at) >= limitsShare {
		return nil, false
	}
	return last.accounts, true
}

// limitsBy records the limits e's core fetched with params.
func limitsBy(e *plugin.Env, params json.RawMessage, accounts any) {
	if e.Client == "" {
		return
	}
	limitsMu.Lock()
	defer limitsMu.Unlock()
	lastLimits[e.Base] = sharedResult{client: e.Client, params: string(params), at: time.Now(), accounts: accounts}
}

// limitsTimeout bounds one limits action: the providers run in parallel,
// each request within usage.Timeout, agy within usage.AgyTimeout.
const limitsTimeout = 45 * time.Second

// costTimeout bounds a cost scan (the core waits 2 minutes).
const costTimeout = 150 * time.Second

// sessionTimeout bounds a session action (the core waits 30 seconds).
const sessionTimeout = 40 * time.Second

func init() { plugin.Register("usage", handle) }

func env(e *plugin.Env) *usage.Env {
	return usage.NewEnv(e.Home, e.Base, e.Environ)
}

func handle(ctx context.Context, st net.Conn, action string, params json.RawMessage, e *plugin.Env) error {
	switch action {
	case "limits":
		var o usage.Options
		if err := plugin.Decode(params, &o); err != nil {
			return plugin.Reply(st, nil, err)
		}
		if acc, ok := sharedLimits(e, params); ok {
			return plugin.Reply(st, map[string]any{"accounts": acc}, nil)
		}
		ctx, cancel := untilClosed(ctx, st, limitsTimeout)
		defer cancel()
		acc := usage.Limits(ctx, env(e), o)
		if ctx.Err() == nil {
			limitsBy(e, params, acc)
		}
		return plugin.Reply(st, map[string]any{"accounts": acc}, nil)
	case "cost":
		var o usage.CostOptions
		if err := plugin.Decode(params, &o); err != nil {
			return plugin.Reply(st, nil, err)
		}
		if err := usage.ValidPrices(o.Prices); err != nil {
			return plugin.Reply(st, nil, plugin.Errorf("bad_params", "usage: %v", err))
		}
		ctx, cancel := untilClosed(ctx, st, costTimeout)
		defer cancel()
		rep, err := usage.Cost(ctx, env(e), o)
		return plugin.Reply(st, rep, err)
	case "setDeepseekKey":
		var p struct {
			Key string `json:"key"`
		}
		if err := plugin.Decode(params, &p); err != nil {
			return plugin.Reply(st, nil, err)
		}
		err := usage.SetDeepSeekKey(e.Base, p.Key)
		if errors.Is(err, usage.ErrBadKey) {
			err = plugin.Errorf("bad_key", "not an API key")
		}
		return plugin.Reply(st, map[string]bool{"set": p.Key != ""}, err)
	case "session":
		var q usage.SessionRequest
		if err := plugin.Decode(params, &q); err != nil {
			return plugin.Reply(st, nil, err)
		}
		if err := usage.ValidPrices(q.Prices); err != nil {
			return plugin.Reply(st, nil, plugin.Errorf("bad_params", "usage: %v", err))
		}
		// Only a known kind and a session id reach the search for a file.
		prov, ok := usage.SessionProvider(q.Kind)
		if !ok || !agentkinds.ValidSessionID(q.Session) {
			return plugin.Reply(st, nil, plugin.Errorf("bad_params", "usage: not a session of an agent whose sessions are priced"))
		}
		f, err := resolver(e.Home).Locate(q.Kind, q.Session)
		if err != nil {
			return plugin.Reply(st, nil, sessionError(err))
		}
		ctx, cancel := untilClosed(ctx, st, sessionTimeout)
		defer cancel()
		u, err := usage.SessionCost(ctx, env(e), prov, sessionFiles(f), q.SessionOptions)
		if err != nil {
			return plugin.Reply(st, nil, sessionError(err))
		}
		return plugin.Reply(st, u, nil)
	}
	return plugin.Reply(st, nil, plugin.Errorf("bad_params", "usage: unknown action %q", action))
}

var (
	resolverMu sync.Mutex
	resolved   *sessions.Resolver
)

// resolver is the agent's finder of sessions' transcripts in home, kept
// across actions for what it remembers of where they are.
func resolver(home string) *sessions.Resolver {
	resolverMu.Lock()
	defer resolverMu.Unlock()
	if resolved == nil || resolved.Home != home {
		resolved = &sessions.Resolver{Home: home}
	}
	return resolved
}

// sessionFiles are a located session's transcripts as usage.SessionCost
// reads them: each opened as the file Locate found, through no symbolic
// link (sessions.File.Open, OpenSubagent); a subagent's that is not that
// file any more is gone (os.ErrNotExist) and left out.
func sessionFiles(f sessions.File) []usage.SessionFile {
	out := []usage.SessionFile{{Name: f.Path, Open: f.Open}}
	for i, p := range f.Subagents {
		out = append(out, usage.SessionFile{Name: p, Open: func() (*os.File, error) {
			fh, err := f.OpenSubagent(i)
			if errors.Is(err, sessions.ErrNotFound) {
				return nil, fmt.Errorf("usage: subagent transcript %d: %w", i, os.ErrNotExist)
			}
			return fh, err
		}})
	}
	return out
}

// sessionError is the code of a session that could not be read: not_found
// (no transcript of it), compressed, too_large, bad_params, else failed.
// Its message names no path.
func sessionError(err error) error {
	switch {
	case errors.Is(err, sessions.ErrNotFound) || errors.Is(err, os.ErrNotExist):
		return plugin.Errorf(agentproto.TranscriptNotFound, "usage: no transcript of the session")
	case errors.Is(err, sessions.ErrCompressed):
		return plugin.Errorf(agentproto.TranscriptCompressed, "usage: the session's transcript is compressed")
	case errors.Is(err, usage.ErrSessionTooLarge):
		return plugin.Errorf(agentproto.TranscriptTooLarge, "usage: a transcript of the session is too large")
	case errors.Is(err, sessions.ErrBadID) || errors.Is(err, sessions.ErrUnknownKind) || errors.Is(err, usage.ErrSessionProvider):
		return plugin.Errorf("bad_params", "usage: not a session of an agent whose sessions are priced")
	}
	return plugin.Errorf("failed", "usage: the session's transcripts could not be read")
}

// untilClosed is ctx ended after d or when the core closes st (it stopped
// waiting, plugin.UntilClosed).
func untilClosed(ctx context.Context, st net.Conn, d time.Duration) (context.Context, context.CancelFunc) {
	ctx, closed := plugin.UntilClosed(ctx, st)
	ctx, cancel := context.WithTimeout(ctx, d)
	return ctx, func() {
		cancel()
		closed()
	}
}
