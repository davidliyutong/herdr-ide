//go:build unix

package acp

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"unicode/utf8"

	"herdr-ide/internal/chatproto"
)

// Bounds of what a chat keeps of its agent's state.
const (
	maxConfigOptions = 64
	maxConfigValues  = 1000
	maxCommands      = 1000
	// maxName and maxText are the most characters of a name and of a
	// description kept.
	maxName = 200
	maxText = 2000
)

// legacyModeID and legacyModeIDAlt name the configuration option a chat
// makes of an agent's session modes (session/set_mode) when the agent has
// no option of category mode: the first unless the agent has an option of
// that id.
const (
	legacyModeID    = "mode"
	legacyModeIDAlt = "_mode"
)

// clip is s cut to n characters.
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// wireOption is a session configuration option as an agent sends it.
type wireOption struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	Category     string            `json:"category"`
	Type         string            `json:"type"`
	CurrentValue json.RawMessage   `json:"currentValue"`
	Options      []json.RawMessage `json:"options"`
}

// wireValue is a value of an option, or a group of them.
type wireValue struct {
	Value       *string           `json:"value"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Group       string            `json:"group"`
	Options     []json.RawMessage `json:"options"`
}

// configOptions are an agent's configuration options as a chat states
// them: the options of type select, their grouped values one after the
// other; nil for what is no array of them.
func configOptions(raw json.RawMessage) []chatproto.ConfigOption {
	var wire []json.RawMessage
	if json.Unmarshal(raw, &wire) != nil {
		return nil
	}
	out := []chatproto.ConfigOption{}
	for _, r := range wire {
		var w wireOption
		if json.Unmarshal(r, &w) != nil || w.ID == "" || w.Type != chatproto.ConfigSelect {
			continue // boolean options need a capability this client does not state
		}
		var current string
		if json.Unmarshal(w.CurrentValue, &current) != nil {
			continue
		}
		o := chatproto.ConfigOption{
			ID: clip(w.ID, maxName), Name: clip(w.Name, maxName), Description: clip(w.Description, maxText),
			Category: clip(w.Category, maxName), Type: chatproto.ConfigSelect, CurrentValue: current,
			Options: []chatproto.ConfigValue{},
		}
		addValues(&o, w.Options, 0)
		out = append(out, o)
		if len(out) == maxConfigOptions {
			break
		}
	}
	return out
}

// addValues adds an option's values, and those of its groups.
func addValues(o *chatproto.ConfigOption, raw []json.RawMessage, depth int) {
	for _, r := range raw {
		if len(o.Options) == maxConfigValues {
			return
		}
		var v wireValue
		if json.Unmarshal(r, &v) != nil {
			continue
		}
		switch {
		case v.Value != nil:
			o.Options = append(o.Options, chatproto.ConfigValue{Value: *v.Value, Name: clip(v.Name, maxName), Description: clip(v.Description, maxText)})
		case v.Options != nil && depth == 0:
			addValues(o, v.Options, depth+1)
		}
	}
}

// wireModes are an agent's session modes (the protocol's older way).
type wireModes struct {
	CurrentModeID  string `json:"currentModeId"`
	AvailableModes []struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
	} `json:"availableModes"`
}

// modesOption is the configuration option a chat makes of an agent's
// session modes, under id; ok is false for what are no modes.
func modesOption(raw json.RawMessage, id string) (chatproto.ConfigOption, bool) {
	var m wireModes
	if json.Unmarshal(raw, &m) != nil || len(m.AvailableModes) == 0 {
		return chatproto.ConfigOption{}, false
	}
	o := chatproto.ConfigOption{
		ID: id, Name: "Mode", Category: chatproto.CategoryMode, Type: chatproto.ConfigSelect,
		CurrentValue: m.CurrentModeID, Options: []chatproto.ConfigValue{},
	}
	for _, v := range m.AvailableModes {
		if v.ID != "" && len(o.Options) < maxConfigValues {
			o.Options = append(o.Options, chatproto.ConfigValue{Value: v.ID, Name: clip(v.Name, maxName), Description: clip(v.Description, maxText)})
		}
	}
	return o, true
}

// optionOf is the first option of a category; nil for none.
func optionOf(opts []chatproto.ConfigOption, category string) *chatproto.ConfigOption {
	for i := range opts {
		if opts[i].Category == category {
			return &opts[i]
		}
	}
	return nil
}

// optionByID is the option of an id; nil for none.
func optionByID(opts []chatproto.ConfigOption, id string) *chatproto.ConfigOption {
	for i := range opts {
		if opts[i].ID == id {
			return &opts[i]
		}
	}
	return nil
}

// hasValue tells whether value is one of the option's.
func hasValue(o *chatproto.ConfigOption, value string) bool {
	return slices.ContainsFunc(o.Options, func(v chatproto.ConfigValue) bool { return v.Value == value })
}

// cloneConfig is a copy of opts that shares nothing with it.
func cloneConfig(opts []chatproto.ConfigOption) []chatproto.ConfigOption {
	if opts == nil {
		return nil
	}
	out := make([]chatproto.ConfigOption, len(opts))
	for i, o := range opts {
		o.Options = slices.Clone(o.Options)
		out[i] = o
	}
	return out
}

// modeCandidates are, for each of the host's permission modes
// (chatproto.Modes), the ids an agent's mode of that meaning has, as the
// agents name them. A mode the agent has none of is left at the agent's
// default: Kimi Code's "auto" approves what it deems safe, which is not
// acceptEdits, and an agent without a full-access mode keeps asking.
var modeCandidates = map[string][]string{
	chatproto.ModeDefault:     {"default", "ask"},
	chatproto.ModeAcceptEdits: {"acceptEdits", "accept_edits", "accept-edits"},
	chatproto.ModePlan:        {"plan"},
	chatproto.ModeFull:        {"yolo", "bypassPermissions", "full", "full-access", "full_access"},
}

// markFull marks the values of the mode options that give the agent full
// access (modeCandidates of chatproto.ModeFull), which the host refuses
// unless its settings allow full access.
func markFull(opts []chatproto.ConfigOption) {
	for i := range opts {
		if opts[i].Category != chatproto.CategoryMode {
			continue
		}
		for j := range opts[i].Options {
			opts[i].Options[j].Full = slices.Contains(modeCandidates[chatproto.ModeFull], opts[i].Options[j].Value)
		}
	}
}

// modeValue is the value of the mode option that a chat's mode stands for:
// the agent's own value when it is one, else the agent's value of the
// host's mode of that name; "" when the agent has none.
func modeValue(o *chatproto.ConfigOption, mode string) string {
	if hasValue(o, mode) {
		return mode
	}
	for _, c := range modeCandidates[mode] {
		if hasValue(o, c) {
			return c
		}
	}
	return ""
}

// wireCommand is a slash command as an agent sends it.
type wireCommand struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Input       *struct {
		Hint string `json:"hint"`
	} `json:"input"`
}

// slashCommands are an available_commands_update's commands.
func slashCommands(raw json.RawMessage) ([]chatproto.SlashCommand, bool) {
	var u struct {
		Commands []json.RawMessage `json:"availableCommands"`
	}
	if json.Unmarshal(raw, &u) != nil || u.Commands == nil {
		return nil, false
	}
	out := []chatproto.SlashCommand{}
	for _, r := range u.Commands {
		var c wireCommand
		if json.Unmarshal(r, &c) != nil || strings.TrimSpace(c.Name) == "" {
			continue
		}
		sc := chatproto.SlashCommand{Name: clip(c.Name, maxName), Description: clip(c.Description, maxText)}
		if c.Input != nil {
			sc.ArgumentHint = clip(c.Input.Hint, maxName)
		}
		out = append(out, sc)
		if len(out) == maxCommands {
			break
		}
	}
	return out, true
}

// wireUsage is a usage_update.
type wireUsage struct {
	Used *int64 `json:"used"`
	Size *int64 `json:"size"`
	Cost *struct {
		Amount   float64 `json:"amount"`
		Currency string  `json:"currency"`
	} `json:"cost"`
}

// withContext sets u's context window: used of size tokens (size 0 when
// unknown), the percentage from them.
func withContext(u *chatproto.Usage, used, size int64) {
	u.Used, u.Size, u.Percentage = used, size, 0
	if size > 0 {
		u.Percentage = float64(used) * 100 / float64(size)
	}
}

// cloneUsage is a copy of u to change; a new one for nil.
func cloneUsage(u *chatproto.Usage) *chatproto.Usage {
	if u == nil {
		return &chatproto.Usage{}
	}
	c := *u
	if u.Cost != nil {
		cost := *u.Cost
		c.Cost = &cost
	}
	c.Limits = slices.Clone(u.Limits)
	return &c
}

// usdPerTick is what a tick of Grok's costUsdTicks is worth: 10^10 ticks
// make a US dollar, as Grok's own documentation states.
const usdPerTick = 1e-10

// turnMeta is what a session/prompt answer's _meta tells of the turn, as
// Grok sends it: the tokens of its last model call, which are the context
// in use, its model and its cost.
type turnMeta struct {
	TotalTokens int64  `json:"totalTokens"`
	ModelID     string `json:"modelId"`
	Usage       struct {
		CostUsdTicks int64 `json:"costUsdTicks"`
	} `json:"usage"`
}

// contextSizes are the context windows of the models of a session's model
// state, by model id, as Grok gives them (_meta.totalContextTokens).
func contextSizes(raw json.RawMessage) map[string]int64 {
	var m struct {
		Available []struct {
			ModelID string `json:"modelId"`
			Meta    struct {
				TotalContextTokens int64 `json:"totalContextTokens"`
			} `json:"_meta"`
		} `json:"availableModels"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	out := map[string]int64{}
	for _, a := range m.Available {
		if a.ModelID != "" && a.Meta.TotalContextTokens > 0 && len(out) < maxConfigValues {
			out[a.ModelID] = a.Meta.TotalContextTokens
		}
	}
	return out
}

// present tells whether a raw JSON value is there and not null.
func present(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) > 0 && string(raw) != "null"
}
