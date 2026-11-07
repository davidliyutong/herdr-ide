package machines

import (
	"context"
	"log"
	"sync"
)

// Manager owns all machines.
type Manager struct {
	logger *log.Logger
	order  []string
	byID   map[string]*Machine

	mu      sync.Mutex
	subs    map[int]func(State)
	agentFn map[int]func(AgentEvent)
	nextSub int

	// overrides keep the user's enabled and disabled machines (UseOverrides).
	overrides *Overrides
}

// UseOverrides applies the user's enabled and disabled machines and keeps
// later changes in o. Call before Run.
func (mg *Manager) UseOverrides(o *Overrides) {
	mg.overrides = o
	for _, id := range mg.order {
		m := mg.byID[id]
		specs := []Spec{m.spec}
		o.Apply(specs)
		m.setEnabled(specs[0].Enabled)
	}
}

// SetEnabled enables or disables machine id from the UI: it is saved over
// herdr's catalog, and the machine connects or ends its session at once. A
// disabled machine's panes keep running in its herdr.
func (mg *Manager) SetEnabled(id string, on bool) error {
	m := mg.byID[id]
	if m == nil {
		return ErrUnknownMachine
	}
	if mg.overrides != nil {
		if err := mg.overrides.SetEnabled(id, on); err != nil {
			return err
		}
	}
	m.setEnabled(on)
	return nil
}

// NewManager creates machines for specs; call Run to connect them.
func NewManager(specs []Spec, dial Dialer, logger *log.Logger) *Manager {
	mg := &Manager{logger: logger, byID: map[string]*Machine{}, subs: map[int]func(State){}, agentFn: map[int]func(AgentEvent){}}
	for _, s := range specs {
		mg.order = append(mg.order, s.ID)
		mg.byID[s.ID] = newMachine(s, dial, logger, mg.broadcast, mg.broadcastAgent)
	}
	return mg
}

// Run connects every enabled machine until ctx ends.
func (mg *Manager) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, id := range mg.order {
		m := mg.byID[id]
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.Run(ctx)
		}()
	}
	wg.Wait()
}

// SetStreamHandler installs the handler for agent-initiated streams. Call
// before Run.
func (mg *Manager) SetStreamHandler(h StreamHandler) {
	for _, m := range mg.byID {
		m.streams = h
	}
}

// Get returns a machine by id.
func (mg *Manager) Get(id string) *Machine { return mg.byID[id] }

// States returns all machine states in configured order.
func (mg *Manager) States() []State {
	out := make([]State, 0, len(mg.order))
	for _, id := range mg.order {
		out = append(out, mg.byID[id].State())
	}
	return out
}

// Subscribe registers callbacks for state changes and agent events.
func (mg *Manager) Subscribe(onState func(State), onAgent func(AgentEvent)) (cancel func()) {
	mg.mu.Lock()
	id := mg.nextSub
	mg.nextSub++
	mg.subs[id] = onState
	mg.agentFn[id] = onAgent
	mg.mu.Unlock()
	return func() {
		mg.mu.Lock()
		delete(mg.subs, id)
		delete(mg.agentFn, id)
		mg.mu.Unlock()
	}
}

func (mg *Manager) broadcast(st State) {
	mg.mu.Lock()
	fns := make([]func(State), 0, len(mg.subs))
	for _, f := range mg.subs {
		fns = append(fns, f)
	}
	mg.mu.Unlock()
	for _, f := range fns {
		f(st)
	}
}

func (mg *Manager) broadcastAgent(ev AgentEvent) {
	mg.mu.Lock()
	fns := make([]func(AgentEvent), 0, len(mg.agentFn))
	for _, f := range mg.agentFn {
		fns = append(fns, f)
	}
	mg.mu.Unlock()
	for _, f := range fns {
		f(ev)
	}
}
