package codex

import (
	"slices"

	"herdr-ide/internal/chatproto"
)

// The ids of the chat's configuration options, their categories'.
const (
	optModel  = chatproto.CategoryModel
	optEffort = chatproto.CategoryThoughtLevel
	optMode   = chatproto.CategoryMode
)

// modeNames name the permission modes in the mode option.
var modeNames = map[string]string{
	chatproto.ModeDefault:     "Ask",
	chatproto.ModeAcceptEdits: "Accept edits",
	chatproto.ModePlan:        "Plan",
	chatproto.ModeFull:        "Full access",
}

// settings are what a turn runs with: the model, the effort and the
// permission mode.
type settings struct {
	model, effort, mode string
}

// policy is how a permission mode runs a turn: Codex's approval policy and
// sandbox policy, and whether it plans (collaboration mode plan). Threads
// start and resume read-only (a thread started workspace-write writes its
// directory into ~/.codex/config.toml as trusted); each turn carries the
// mode's policies, which write nothing.
func policy(mode, cwd string) (approval string, sandbox map[string]any, plan bool) {
	readOnly := map[string]any{"type": "readOnly", "networkAccess": false}
	switch mode {
	case chatproto.ModeAcceptEdits:
		// excludeTmpdirEnvVar would break zsh's here-documents.
		return "on-request", map[string]any{"type": "workspaceWrite", "writableRoots": []string{cwd}, "networkAccess": false,
			"excludeTmpdirEnvVar": false, "excludeSlashTmp": false}, false
	case chatproto.ModePlan:
		return "on-request", readOnly, true
	case chatproto.ModeFull:
		return "never", map[string]any{"type": "dangerFullAccess"}, false
	}
	return "on-request", readOnly, false
}

// turnParams are turn/start's parameters for input under st.
func turnParams(thread, cwd, clientMessage string, input []userInput, st settings) map[string]any {
	approval, sandbox, plan := policy(st.mode, cwd)
	collab := "default"
	if plan {
		collab = "plan"
	}
	var effort any
	if st.effort != "" {
		effort = st.effort
	}
	p := map[string]any{
		"threadId":          thread,
		"input":             input,
		"approvalPolicy":    approval,
		"approvalsReviewer": "user",
		"sandboxPolicy":     sandbox,
		// Null instructions: the mode's own.
		"collaborationMode": map[string]any{"mode": collab, "settings": map[string]any{
			"model": st.model, "reasoning_effort": effort, "developer_instructions": nil}},
	}
	if clientMessage != "" {
		p["clientUserMessageId"] = clientMessage
	}
	if st.model != "" {
		p["model"] = st.model
	}
	if st.effort != "" {
		p["effort"] = st.effort
	}
	return p
}

// threadParams are thread/start's (resume "") or thread/resume's
// parameters: always read-only, asking the user (the real policy goes with
// each turn).
func threadParams(resume, cwd, model string) map[string]any {
	p := map[string]any{
		"cwd":               cwd,
		"approvalPolicy":    "on-request",
		"approvalsReviewer": "user",
		"sandbox":           "read-only",
	}
	if model != "" {
		p["model"] = model
	}
	if resume != "" {
		p["threadId"] = resume
		p["excludeTurns"] = true
	}
	return p
}

// models are the models model/list gave, the hidden ones left out.
type models []modelInfo

func (ms models) find(slug string) *modelInfo {
	for i := range ms {
		if ms[i].slug() == slug || ms[i].ID == slug {
			return &ms[i]
		}
	}
	return nil
}

// efforts are the efforts of a model; nil when it is not known.
func (ms models) efforts(slug string) []effortOption {
	if m := ms.find(slug); m != nil {
		return m.SupportedReasoningEfforts
	}
	return nil
}

func hasEffort(efforts []effortOption, e string) bool {
	return slices.ContainsFunc(efforts, func(o effortOption) bool { return o.ReasoningEffort == e })
}

// effortFor is the effort to run model with: want when the model has it,
// else the thread's (from the user's configuration) when it has that, else
// the model's default.
func (ms models) effortFor(model, want, thread string) string {
	efforts := ms.efforts(model)
	if efforts == nil {
		// A model model/list does not list: the effort asked for, or none.
		if want != "" {
			return want
		}
		return thread
	}
	for _, e := range []string{want, thread} {
		if e != "" && hasEffort(efforts, e) {
			return e
		}
	}
	if m := ms.find(model); m != nil && m.DefaultReasoningEffort != "" {
		return m.DefaultReasoningEffort
	}
	return efforts[0].ReasoningEffort
}

// images tells whether a model takes images; true when it is not known.
func (ms models) images(slug string) bool {
	m := ms.find(slug)
	return m == nil || len(m.InputModalities) == 0 || slices.Contains(m.InputModalities, "image")
}

// configOptions are the chat's configuration options under st.
func (ms models) configOptions(st settings) []chatproto.ConfigOption {
	var out []chatproto.ConfigOption
	model := chatproto.ConfigOption{ID: optModel, Name: "Model", Category: chatproto.CategoryModel, Type: chatproto.ConfigSelect, CurrentValue: st.model}
	for _, m := range ms {
		name := m.DisplayName
		if name == "" {
			name = m.slug()
		}
		model.Options = append(model.Options, chatproto.ConfigValue{Value: m.slug(), Name: name, Description: m.Description})
	}
	if st.model != "" && ms.find(st.model) == nil {
		model.Options = append(model.Options, chatproto.ConfigValue{Value: st.model, Name: st.model})
	}
	if len(model.Options) > 0 {
		out = append(out, model)
	}
	if efforts := ms.efforts(st.model); len(efforts) > 0 {
		effort := chatproto.ConfigOption{ID: optEffort, Name: "Effort", Category: chatproto.CategoryThoughtLevel, Type: chatproto.ConfigSelect, CurrentValue: st.effort}
		for _, e := range efforts {
			effort.Options = append(effort.Options, chatproto.ConfigValue{Value: e.ReasoningEffort, Name: e.ReasoningEffort, Description: e.Description})
		}
		out = append(out, effort)
	}
	mode := chatproto.ConfigOption{ID: optMode, Name: "Mode", Category: chatproto.CategoryMode, Type: chatproto.ConfigSelect, CurrentValue: st.mode}
	for _, m := range chatproto.Modes {
		// Full access: the host refuses it unless its settings allow it.
		mode.Options = append(mode.Options, chatproto.ConfigValue{Value: m, Name: modeNames[m], Full: m == chatproto.ModeFull})
	}
	return append(out, mode)
}

// capabilities are what a chat with model can do.
func (ms models) capabilities(st settings) chatproto.Capabilities {
	return chatproto.Capabilities{
		Images: ms.images(st.model), Compact: true, Queue: true, Plan: true, Questions: true,
		Effort: len(ms.efforts(st.model)) > 0, Model: len(ms) > 0,
	}
}

// commands are the slash commands a Codex chat takes as prompts.
var commands = []chatproto.SlashCommand{{Name: "compact", Description: "Summarize the conversation to free context"}}
