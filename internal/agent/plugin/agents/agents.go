//go:build unix

// Package agents is the machine side of the agents plugin
// (backend/features/agents): it answers questions about the sessions of
// the coding agents of this machine. A request names a session by its
// agent's kind and session id, never by a path: the id is checked before
// it reaches one, and the transcript is found inside the kind's own
// session root (internal/agent/sessions). Its action only reads; the
// plugin keeps nothing between requests but where it found transcripts:
//
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
	"unicode/utf8"

	"veldr/internal/agent/plugin"
	"veldr/internal/agent/sessions"
	"veldr/internal/agentkinds"
	"veldr/internal/agentproto"
)

// ID names the plugin on every side.
const ID = "agents"

// ActionResolve is the plugin's action.
const ActionResolve = "resolve"

// MaxCwd bounds the directory a resolve compares.
const MaxCwd = 4096

func init() { plugin.Register(ID, handle) }

func handle(_ context.Context, st net.Conn, action string, params json.RawMessage, env *plugin.Env) error {
	if action != ActionResolve {
		return plugin.Reply(st, nil, plugin.Errorf("bad_params", "agents: unknown action %q", action))
	}
	var req agentproto.ResolveRequest
	if err := plugin.Decode(params, &req); err != nil {
		return plugin.Reply(st, nil, err)
	}
	return plugin.Reply(st, resolve(resolver(env), req), nil)
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

// parser is the transcript format of an agent's kind
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
