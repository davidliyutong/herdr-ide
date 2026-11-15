//go:build unix

// Package usage is the machine side of the AI usage plugin
// (internal/plugins/usage): it reads the subscriptions' limits and the
// logs' cost on the machine with internal/usage and answers with numbers
// only. Actions:
//
//   - limits {providers, codexHomes, claudeKeychain, skip}: the accounts
//     the CLIs are signed in to, with their windows and balances;
//   - cost {since, tzOffset, codexHomes, providers}: the logs' tokens and
//     cost by day, model and project;
//   - setDeepseekKey {key}: writes (or with "" removes) the DeepSeek key
//     file; the key is never read back.
package usage

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/usage"
)

// limitsTimeout bounds one limits action: the providers run in parallel,
// each request within usage.Timeout, agy within usage.AgyTimeout.
const limitsTimeout = 45 * time.Second

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
		ctx, cancel := context.WithTimeout(ctx, limitsTimeout)
		defer cancel()
		return plugin.Reply(st, map[string]any{"accounts": usage.Limits(ctx, env(e), o)}, nil)
	case "cost":
		var o usage.CostOptions
		if err := plugin.Decode(params, &o); err != nil {
			return plugin.Reply(st, nil, err)
		}
		rep, err := usage.Cost(env(e), o)
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
	}
	return plugin.Reply(st, nil, plugin.Errorf("bad_params", "usage: unknown action %q", action))
}
