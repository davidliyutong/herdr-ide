//go:build unix

package claude

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

// session is a chat's Claude Code session and its program.
//
// emu orders what changes the state with the events it makes: a goroutine
// that changes the state takes emu, then mu for the change, and hands the
// events to the sink after letting go of mu but before letting go of emu.
// Nothing waits for the program while holding either.
type session struct {
	p    chatadapter.StartParams
	sink chatadapter.Sink
	id   string
	// ctx ends with the session: the answers to the program's requests
	// that wait for the user end with it.
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}

	emu sync.Mutex
	mu  sync.Mutex
	// proc is the program running now; restarting: it is being replaced.
	proc       *proc
	restarting bool
	closing    bool
	ended      bool
	err        error

	// inTurn: a turn runs; authFailed: an assistant frame of the turn said
	// that the program is not signed in.
	inTurn     bool
	authFailed bool
	// sent are the user's messages the program has not completed, by the
	// uuid they were sent with; byMessage maps the host's message ids to
	// them.
	sent      map[string]*sentMessage
	byMessage map[string]string
	// stream is the main agent's response being streamed.
	stream streamState
	// blocks counts the content blocks seen of each assistant message, for
	// the items of frames without a stream (subagents').
	blocks map[string]int
	// tasks maps the program's tasks (a subagent's agent_id is its task
	// id) to the tool call that started them; toolParent maps tool calls
	// to the subagent's tool call they belong to ("" for the main agent).
	tasks      map[string]string
	toolParent map[string]string
	// waiting counts the program's requests that wait for the user.
	waiting int

	// The chat's configuration: models and their current value (model,
	// the option's value; modelArg what the program is started with), the
	// effort and the mode; launchedFull: the program was started allowed
	// to skip permissions.
	// running is the model the program said it runs (system/init).
	running      string
	models       []model
	model        string
	modelArg     string
	launchModel  string
	effort       string
	mode         string
	launchedFull bool
	usage        chatproto.Usage

	// unknown counts the frames, members and requests passed over;
	// echoes the answers to requests of no pending one's (the program's
	// echoes); seen the kinds logged once.
	unknown, echoes int
	seen            map[string]bool
	// lines counts the lines read and handled (tests wait on it).
	lines atomic.Int64
}

// sentMessage is a message of the user's sent to the program.
type sentMessage struct {
	uuid, message, clientID string
	content                 []json.RawMessage
	// queued: it was sent while a turn ran; taken: the program took it.
	queued, taken bool
}

// streamState is a response of the main agent being streamed.
type streamState struct {
	message string
	// open is the index of the content block being streamed, -1 for none;
	// kind is its type, tool its tool call's id.
	open       int
	kind, tool string
	// estimated is the thinking's estimated tokens.
	estimated int64
}

func newSession(p chatadapter.StartParams, sink chatadapter.Sink, id string) *session {
	ctx, cancel := context.WithCancel(context.Background())
	mode := p.Options.Mode
	if mode == "" {
		mode = chatproto.ModeDefault
	}
	effort := p.Options.Effort
	if effort == "" {
		effort = effortDefault
	}
	return &session{
		p: p, sink: sink, id: id, ctx: ctx, cancel: cancel, done: make(chan struct{}),
		sent: map[string]*sentMessage{}, byMessage: map[string]string{}, blocks: map[string]int{},
		tasks: map[string]string{}, seen: map[string]bool{},
		stream:   streamState{open: -1},
		modelArg: p.Options.Model, effort: effort, mode: mode,
	}
}

// out is what a change makes: events, changes of the chat, and what to do
// once the locks are let go of (write to the program).
type out struct {
	evs   []chatproto.Event
	upd   []func(*chatproto.Chat)
	after []func()
}

func (o *out) event(ev chatproto.Event)          { o.evs = append(o.evs, ev) }
func (o *out) update(fn func(c *chatproto.Chat)) { o.upd = append(o.upd, fn) }

// flush hands o to the sink; the caller holds emu, not mu.
func (s *session) flush(o *out) {
	for _, ev := range o.evs {
		s.sink.Event(ev)
	}
	for _, fn := range o.upd {
		s.sink.Update(fn)
	}
}

// change runs fn under emu and mu, hands what it made to the sink, and
// runs its afters.
func (s *session) change(fn func(o *out)) {
	var o out
	s.emu.Lock()
	s.mu.Lock()
	fn(&o)
	s.mu.Unlock()
	s.flush(&o)
	s.emu.Unlock()
	for _, f := range o.after {
		f()
	}
}

// pass counts something passed over, and logs its kind once.
func (s *session) pass(kind string) {
	s.unknown++
	if !s.seen[kind] {
		s.seen[kind] = true
		s.p.Logger.Printf("claude: passing over %s", kind)
	}
}

// begin starts the program, initializes it and applies the chat's
// options; on an error the program is ended.
func (s *session) begin(ctx context.Context) error {
	full := s.mode == chatproto.ModeFull
	pr, ini, err := s.launch(ctx, s.p.Resume != "", full)
	if err != nil {
		return err
	}
	if err := s.setup(ctx, pr, ini, full); err != nil {
		s.mu.Lock()
		s.closing = true
		s.mu.Unlock()
		pr.kill()
		<-s.done
		return err
	}
	return nil
}

// launch starts a run of the program and initializes it; the run is the
// session's (s.proc) from its start unless the session is restarting.
func (s *session) launch(ctx context.Context, resume, full bool) (*proc, *initResponse, error) {
	pr, err := startProc(s.argv(resume, full), s.env(), s.p.Cwd)
	if err != nil {
		return nil, nil, &chatproto.Error{Code: chatproto.CodeStartFailed, Message: "claude: " + err.Error()}
	}
	s.mu.Lock()
	if !s.restarting {
		s.proc = pr
	}
	s.launchedFull = full
	s.mu.Unlock()
	go s.read(pr)
	raw, err := pr.request(ctx, "initialize", nil, initTimeout)
	var ini initResponse
	if err == nil {
		err = decode(raw, &ini)
	}
	if err != nil {
		pr.kill()
		<-pr.exited
		e := pr.exitError(chatproto.CodeStartFailed)
		e.Message = "claude: initialize: " + err.Error() + "; " + e.Message
		return nil, nil, e
	}
	return pr, &ini, nil
}

// setup takes what initialize said and applies the chat's options: the
// model (pinned to the id an alias resolves to, which plan mode would
// otherwise map to another model), the effort; then it reads the context's
// usage.
func (s *session) setup(ctx context.Context, pr *proc, ini *initResponse, full bool) error {
	s.mu.Lock()
	s.models = ini.Models[:min(len(ini.Models), maxModels)]
	version := ini.Version
	commands := slashCommands(ini.Commands)
	want := s.model
	if want == "" {
		want = s.p.Options.Model
	}
	s.mu.Unlock()
	if want != "" {
		m, ok := s.findModel(want)
		if !ok {
			return badRequest("unknown model " + want)
		}
		s.mu.Lock()
		s.model = m.Value
		launched := s.launchModel
		s.mu.Unlock()
		if m.Resolved != "" && m.Resolved != launched {
			if _, err := pr.request(ctx, "set_model", map[string]string{"model": m.Resolved}, requestTimeout); err != nil {
				return err
			}
		}
		s.mu.Lock()
		s.modelArg = firstNonEmpty(m.Resolved, m.Value)
		s.mu.Unlock()
	}
	s.mu.Lock()
	effort := s.effort
	levels := s.effortLevels()
	s.mu.Unlock()
	if effort != effortDefault {
		if !slices.Contains(levels, effort) {
			return badRequest("the model has no effort " + effort)
		}
		if _, err := pr.request(ctx, "apply_flag_settings", map[string]any{"settings": map[string]any{"effortLevel": effort}}, requestTimeout); err != nil {
			return err
		}
	}
	raw, err := pr.request(ctx, "get_context_usage", map[string]string{"detail": "summary"}, requestTimeout)
	var cu contextUsage
	if err == nil && decode(raw, &cu) == nil {
		s.change(func(o *out) { s.takeContextUsage(&cu, o) })
	}
	s.change(func(o *out) {
		if m := chatMode(ini.CurrentPermissionMode); m != "" {
			s.mode = m
		}
		if full {
			s.mode = chatproto.ModeFull
		}
		id := s.id
		o.update(func(c *chatproto.Chat) {
			c.SessionID = id
			if version != "" {
				c.AgentVersion = version
			}
			c.Commands = commands
		})
		s.configChanged(o)
	})
	return nil
}

func firstNonEmpty(s ...string) string {
	for _, x := range s {
		if x != "" {
			return x
		}
	}
	return ""
}

// findModel is the model of the list whose value is v, else the one v
// resolves to (a full id given for an alias).
func (s *session) findModel(v string) (model, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.models {
		if m.Value == v {
			return m, true
		}
	}
	for _, m := range s.models {
		if m.Resolved == v {
			return m, true
		}
	}
	return model{}, false
}

// currentModel is the model of the list the chat uses; mu held.
func (s *session) currentModel() (model, bool) {
	for _, m := range s.models {
		if m.Value == s.model {
			return m, true
		}
	}
	return model{}, false
}

// effortLevels are the efforts of the chat's model, "default" first; none
// for a model without; mu held.
func (s *session) effortLevels() []string {
	m, ok := s.currentModel()
	if !ok && s.model == "" {
		// The model is the program's default, not known yet: the levels of
		// the list's default.
		for _, x := range s.models {
			if x.Value == "default" {
				m, ok = x, true
			}
		}
	}
	if !ok || !m.SupportsEffort || len(m.SupportedEffortLevels) == 0 {
		return nil
	}
	return append([]string{effortDefault}, m.SupportedEffortLevels...)
}

// configChanged states the chat's configuration options and capabilities
// as they are now; mu held.
func (s *session) configChanged(o *out) {
	config := []chatproto.ConfigOption{{
		ID: optionMode, Name: "Mode", Category: chatproto.CategoryMode, Type: chatproto.ConfigSelect, CurrentValue: s.mode,
		Options: []chatproto.ConfigValue{
			{Value: chatproto.ModeDefault, Name: "Ask"},
			{Value: chatproto.ModeAcceptEdits, Name: "Accept edits"},
			{Value: chatproto.ModePlan, Name: "Plan"},
			{Value: chatproto.ModeFull, Name: "Full access"},
		},
	}}
	if len(s.models) > 0 {
		opt := chatproto.ConfigOption{ID: optionModel, Name: "Model", Category: chatproto.CategoryModel, Type: chatproto.ConfigSelect, CurrentValue: s.model}
		for _, m := range s.models {
			opt.Options = append(opt.Options, chatproto.ConfigValue{Value: m.Value, Name: cut(firstNonEmpty(m.DisplayName, m.Value), maxText), Description: cut(m.Description, maxText)})
		}
		config = append(config, opt)
	}
	levels := s.effortLevels()
	if len(levels) > 0 {
		opt := chatproto.ConfigOption{ID: optionEffort, Name: "Effort", Category: chatproto.CategoryThoughtLevel, Type: chatproto.ConfigSelect, CurrentValue: s.effort}
		for _, l := range levels {
			opt.Options = append(opt.Options, chatproto.ConfigValue{Value: l, Name: l})
		}
		config = append(config, opt)
	}
	caps := chatproto.Capabilities{Images: true, Compact: true, Queue: true, Plan: true, Questions: true,
		Effort: len(levels) > 0, Model: len(s.models) > 0, CancelQueued: true}
	o.update(func(c *chatproto.Chat) {
		c.Config = config
		c.Capabilities = caps
	})
}

// slashCommands are initialize's commands as the chat states them.
func slashCommands(in []struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	ArgumentHint string `json:"argumentHint"`
}) []chatproto.SlashCommand {
	var out []chatproto.SlashCommand
	for _, c := range in[:min(len(in), maxCommands)] {
		if c.Name == "" {
			continue
		}
		out = append(out, chatproto.SlashCommand{Name: cut(c.Name, maxText), Description: cut(c.Description, maxText), ArgumentHint: cut(c.ArgumentHint, maxText)})
	}
	return out
}

// takeContextUsage states what get_context_usage answered; mu held.
func (s *session) takeContextUsage(cu *contextUsage, o *out) {
	if cu.MaxTokens > 0 {
		s.usage.Used, s.usage.Size, s.usage.Percentage = cu.TotalTokens, cu.MaxTokens, cu.Percentage
	}
	if cu.Model != "" && s.running == "" {
		s.running = cu.Model
	}
	if cu.Model != "" && s.model == "" {
		// The program's own default model: the list's value of it, the
		// model itself, else the default that resolves to it, else an
		// alias of it.
		s.model = valueOf(s.models, cu.Model)
		if s.model != "" {
			s.configChanged(o)
		}
	}
	s.usageChanged(o)
}

// valueOf is the value of the list's model that is id, or resolves to it
// ("default" first); "" for none.
func valueOf(models []model, id string) string {
	for _, m := range models {
		if m.Value == id {
			return m.Value
		}
	}
	found := ""
	for _, m := range models {
		if m.Resolved == id && (found == "" || m.Value == "default") {
			found = m.Value
		}
	}
	return found
}

// usageChanged states the chat's usage; mu held.
func (s *session) usageChanged(o *out) {
	u := s.usage
	u.Limits = slices.Clone(u.Limits)
	if u.Cost != nil {
		c := *u.Cost
		u.Cost = &c
	}
	o.update(func(c *chatproto.Chat) { c.Usage = &u })
}

// ---- the Session ----

func (s *session) ID() string            { return s.id }
func (s *session) Done() <-chan struct{} { return s.done }

// PID is the process id of the program running now, the leader of its
// process group (the host signals the group on its shutdown); 0 when none
// runs.
func (s *session) PID() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc == nil || s.proc.cmd.Process == nil || s.ended {
		return 0
	}
	return s.proc.cmd.Process.Pid
}

func (s *session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// current is the program running now; an error when the session ended or
// is being restarted.
func (s *session) current() (*proc, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.ended:
		return nil, errGone
	case s.restarting:
		return nil, &chatproto.Error{Code: chatproto.CodeBusy, Message: "claude: the agent is being restarted"}
	}
	return s.proc, nil
}

// newUUID is a random UUID (version 4), as the SDK names messages.
func newUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// userMessage is a message of the user's as the program takes it.
type userMessage struct {
	Type            string         `json:"type"`
	Message         messageParam   `json:"message"`
	ParentToolUseID *string        `json:"parent_tool_use_id"`
	SessionID       string         `json:"session_id"`
	UUID            string         `json:"uuid"`
	Origin          map[string]any `json:"origin"`
}

type messageParam struct {
	Role    string `json:"role"`
	Content []any  `json:"content"`
}

func (s *session) userLine(uuid string, content []any) userMessage {
	return userMessage{Type: "user", Message: messageParam{Role: "user", Content: content}, SessionID: s.id, UUID: uuid,
		// A message the user typed: Claude Code treats one of no origin as
		// unattributed.
		Origin: map[string]any{"kind": "human"}}
}

// Prompt sends the user's message: a turn (an EventTurn starts it; the
// prompt's EventUser is the host's when it recorded it, else told here
// first), or while one runs a queued message (EventQueued; the program
// takes it into the running turn after a tool's result, or as the next
// turn).
func (s *session) Prompt(ctx context.Context, p chatadapter.PromptParams) error {
	content, err := claudeContent(p.Content, s.p.Cwd)
	if err != nil {
		return err
	}
	pr, err := s.current()
	if err != nil {
		return err
	}
	m := &sentMessage{uuid: newUUID(), message: p.Message, clientID: p.ClientID, content: p.Content}
	s.change(func(o *out) {
		s.sent[m.uuid] = m
		if p.Message != "" {
			s.byMessage[p.Message] = m.uuid
		}
		if s.inTurn {
			m.queued = true
			o.event(chatproto.Event{T: chatproto.EventQueued, State: chatproto.QueuedWaiting, Message: p.Message, Content: p.Content, ClientID: p.ClientID})
			return
		}
		if !p.Recorded {
			// The host saw a turn run, which ended meanwhile.
			o.event(chatproto.Event{T: chatproto.EventUser, Content: p.Content, ClientID: p.ClientID})
		}
		s.startTurn(o)
	})
	if err := pr.write(s.userLine(m.uuid, content)); err != nil {
		s.change(func(o *out) {
			delete(s.sent, m.uuid)
			delete(s.byMessage, p.Message)
			if m.queued {
				o.event(chatproto.Event{T: chatproto.EventQueued, State: chatproto.QueuedCancelled, Message: p.Message, ClientID: p.ClientID})
			} else if s.inTurn {
				s.endTurn(o, chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnError, Error: asError(err, chatproto.CodeEnded)})
			}
		})
		return err
	}
	return nil
}

// startTurn starts a turn; mu held.
func (s *session) startTurn(o *out) {
	s.inTurn, s.authFailed = true, false
	o.event(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnStart})
}

// endTurn ends the turn with ev; mu held.
func (s *session) endTurn(o *out, ev chatproto.Event) {
	if !s.inTurn {
		return
	}
	s.inTurn = false
	s.stream = streamState{open: -1}
	o.event(ev)
}

// asError is err as a chatproto.Error, of code when it is none.
func asError(err error, code string) *chatproto.Error {
	var e *chatproto.Error
	if errors.As(err, &e) {
		return e
	}
	return &chatproto.Error{Code: code, Message: err.Error()}
}

// Cancel interrupts the running turn, withdrawing the queued messages
// first; the program cancels the permissions it waits for.
func (s *session) Cancel(ctx context.Context) error {
	pr, err := s.current()
	if err != nil {
		return err
	}
	s.mu.Lock()
	running := s.inTurn
	var queued []string
	for _, m := range s.sent {
		if m.queued && !m.taken {
			queued = append(queued, m.uuid)
		}
	}
	s.mu.Unlock()
	if !running {
		return nil
	}
	slices.Sort(queued)
	for _, u := range queued {
		s.cancelQueued(ctx, pr, u)
	}
	raw, err := pr.request(ctx, "interrupt", nil, requestTimeout)
	if err != nil {
		return err
	}
	var r struct {
		StillQueued []string `json:"still_queued"`
	}
	if decode(raw, &r) == nil {
		for _, u := range r.StillQueued {
			s.mu.Lock()
			m := s.sent[u]
			s.mu.Unlock()
			if m != nil && m.queued && !m.taken {
				s.cancelQueued(ctx, pr, u)
			}
		}
	}
	return nil
}

// cancelQueued withdraws the queued message uuid; false when the program
// had taken it.
func (s *session) cancelQueued(ctx context.Context, pr *proc, uuid string) (bool, error) {
	raw, err := pr.request(ctx, "cancel_async_message", map[string]string{"message_uuid": uuid}, requestTimeout)
	if err != nil {
		return false, err
	}
	var r struct {
		Cancelled bool `json:"cancelled"`
	}
	if err := decode(raw, &r); err != nil || !r.Cancelled {
		return false, err
	}
	s.change(func(o *out) { s.withdrawn(o, uuid) })
	return true, nil
}

// withdrawn tells that the queued message uuid will not run; mu held.
func (s *session) withdrawn(o *out, uuid string) {
	m := s.sent[uuid]
	if m == nil || !m.queued || m.taken {
		return
	}
	delete(s.sent, uuid)
	delete(s.byMessage, m.message)
	o.event(chatproto.Event{T: chatproto.EventQueued, State: chatproto.QueuedCancelled, Message: m.message, ClientID: m.clientID})
}

// CancelQueued withdraws a queued message before the program takes it.
func (s *session) CancelQueued(ctx context.Context, message string) error {
	pr, err := s.current()
	if err != nil {
		return err
	}
	s.mu.Lock()
	uuid := s.byMessage[message]
	m := s.sent[uuid]
	s.mu.Unlock()
	notFound := &chatproto.Error{Code: chatproto.CodeNotFound, Message: "claude: no such queued message"}
	if m == nil || !m.queued || m.taken {
		return notFound
	}
	ok, err := s.cancelQueued(ctx, pr, uuid)
	if err != nil {
		return err
	}
	if !ok {
		return notFound
	}
	return nil
}

// SetConfig sets the model, the effort or the mode.
func (s *session) SetConfig(ctx context.Context, id, value string) error {
	switch id {
	case optionModel:
		return s.setModel(ctx, value)
	case optionEffort:
		return s.setEffort(ctx, value)
	case optionMode:
		return s.setMode(ctx, value)
	}
	return badRequest("no option " + id)
}

func (s *session) setModel(ctx context.Context, value string) error {
	m, ok := s.findModel(value)
	if !ok || m.Value != value {
		return badRequest("unknown model " + value)
	}
	pr, err := s.current()
	if err != nil {
		return err
	}
	if _, err := pr.request(ctx, "set_model", map[string]string{"model": firstNonEmpty(m.Resolved, m.Value)}, requestTimeout); err != nil {
		return err
	}
	var reset bool
	s.change(func(o *out) {
		s.model, s.modelArg = m.Value, firstNonEmpty(m.Resolved, m.Value)
		if s.effort != effortDefault && !slices.Contains(s.effortLevels(), s.effort) {
			s.effort, reset = effortDefault, true
		}
		s.configChanged(o)
	})
	if reset {
		// The new model has no such effort: its default.
		_, err = pr.request(ctx, "apply_flag_settings", map[string]any{"settings": map[string]any{"effortLevel": nil}}, requestTimeout)
	}
	return err
}

func (s *session) setEffort(ctx context.Context, value string) error {
	s.mu.Lock()
	levels := s.effortLevels()
	s.mu.Unlock()
	if !slices.Contains(levels, value) {
		return badRequest("the model has no effort " + value)
	}
	pr, err := s.current()
	if err != nil {
		return err
	}
	var level any = value
	if value == effortDefault {
		level = nil
	}
	if _, err := pr.request(ctx, "apply_flag_settings", map[string]any{"settings": map[string]any{"effortLevel": level}}, requestTimeout); err != nil {
		return err
	}
	s.change(func(o *out) {
		s.effort = value
		s.configChanged(o)
	})
	return nil
}

func (s *session) setMode(ctx context.Context, value string) error {
	if !slices.Contains(chatproto.Modes, value) {
		return badRequest("unknown mode " + value)
	}
	s.mu.Lock()
	full := s.launchedFull
	s.mu.Unlock()
	if value == chatproto.ModeFull && !full {
		return s.restartFull(ctx)
	}
	pr, err := s.current()
	if err != nil {
		return err
	}
	return s.applyMode(ctx, pr, value)
}

// applyMode sets the program's permission mode.
func (s *session) applyMode(ctx context.Context, pr *proc, mode string) error {
	raw, err := pr.request(ctx, "set_permission_mode", map[string]string{"mode": claudeMode(mode)}, requestTimeout)
	if err != nil {
		return err
	}
	var r struct {
		Mode string `json:"mode"`
	}
	_ = decode(raw, &r)
	s.change(func(o *out) {
		if m := chatMode(r.Mode); m != "" {
			mode = m
		}
		s.mode = mode
		s.configChanged(o)
	})
	return nil
}

// restartFull starts the program again, resuming the session, allowed to
// skip permissions: Claude Code takes bypassPermissions only from a
// program started with --allow-dangerously-skip-permissions. Refused while
// a turn runs or the program waits for the user.
func (s *session) restartFull(ctx context.Context) error {
	busy := &chatproto.Error{Code: chatproto.CodeBusy, Message: "claude: a turn runs"}
	s.emu.Lock()
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		s.emu.Unlock()
		return errGone
	}
	if s.inTurn || s.waiting > 0 || s.restarting {
		s.mu.Unlock()
		s.emu.Unlock()
		return busy
	}
	s.restarting = true
	old := s.proc
	s.mu.Unlock()
	s.flush(&out{evs: []chatproto.Event{{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeRestarted), Params: mustJSON(map[string]string{"mode": chatproto.ModeFull})}}})
	s.emu.Unlock()

	old.stop()
	select {
	case <-old.exited:
	case <-ctx.Done():
		old.kill()
		<-old.exited
	}
	pr, ini, err := s.launch(ctx, true, true)
	if err == nil {
		s.mu.Lock()
		s.proc, s.restarting = pr, false
		s.mu.Unlock()
		err = s.setup(ctx, pr, ini, true)
		if err != nil {
			pr.kill()
		}
		return err
	}
	// No program: the session ends.
	s.mu.Lock()
	s.restarting = false
	s.mu.Unlock()
	s.finish(old, err)
	return err
}

// Compact compacts the conversation: the /compact command, a turn of its
// own. Refused while a turn runs.
func (s *session) Compact(ctx context.Context) error {
	pr, err := s.current()
	if err != nil {
		return err
	}
	m := &sentMessage{uuid: newUUID()}
	busy := false
	s.change(func(o *out) {
		if s.inTurn {
			busy = true
			return
		}
		s.sent[m.uuid] = m
		s.startTurn(o)
		o.event(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeCommand), Params: mustJSON(map[string]string{"name": "/compact"})})
	})
	if busy {
		return &chatproto.Error{Code: chatproto.CodeBusy, Message: "claude: a turn runs"}
	}
	if err := pr.write(s.userLine(m.uuid, []any{textBlock("/compact")})); err != nil {
		s.change(func(o *out) {
			delete(s.sent, m.uuid)
			s.endTurn(o, chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnError, Error: asError(err, chatproto.CodeEnded)})
		})
		return err
	}
	return nil
}

// Close ends the program gracefully: its input is closed, then its group
// gets SIGTERM and SIGKILL if it takes too long. When ctx ends first, the
// group is killed at once.
func (s *session) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closing = true
	pr := s.proc
	s.mu.Unlock()
	if pr == nil {
		return nil
	}
	pr.stop()
	select {
	case <-s.done:
		return nil
	case <-ctx.Done():
		pr.kill()
		return ctx.Err()
	}
}

// finish ends the session after its program pr ended: err is why, nil
// after Close. A turn that ran fails, the queued messages are withdrawn,
// the requests that wait for the user end.
func (s *session) finish(pr *proc, err error) {
	s.change(func(o *out) {
		if s.ended || pr != s.proc || s.restarting {
			return
		}
		s.ended = true
		if s.closing {
			err = nil
		}
		s.err = err
		uuids := make([]string, 0, len(s.sent))
		for u := range s.sent {
			uuids = append(uuids, u)
		}
		slices.Sort(uuids)
		for _, u := range uuids {
			s.withdrawn(o, u)
		}
		e := asError(firstErr(err, errGone), chatproto.CodeEnded)
		s.endTurn(o, chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnError, Error: &chatproto.Error{Code: chatproto.CodeEnded, Message: e.Message, Stderr: e.Stderr}})
	})
	s.mu.Lock()
	ended := s.ended && pr == s.proc
	s.mu.Unlock()
	if ended {
		s.cancel()
		select {
		case <-s.done:
		default:
			close(s.done)
		}
	}
}

func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// textBlock is a text content block.
func textBlock(s string) map[string]any { return map[string]any{"type": "text", "text": s} }
