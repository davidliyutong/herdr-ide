package machines

import (
	"context"
	"log"
	"slices"
	"sync"
	"time"
)

// Manager owns all machines. Machines saved in herdr's catalog from the UI
// are added and removed while it runs (Add, Remove).
type Manager struct {
	logger *log.Logger
	dial   Dialer

	// mmu guards the machines, their order and how to stop each, and the
	// running context. It is never held while calling into a machine,
	// whose state changes publish through mg.broadcast.
	mmu     sync.RWMutex
	order   []string
	byID    map[string]*Machine
	stops   map[string]func()
	ctx     context.Context
	ended   bool
	wg      sync.WaitGroup
	streams StreamHandler

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
	for _, m := range mg.list() {
		specs := []Spec{m.spec}
		o.Apply(specs)
		m.setEnabled(specs[0].Enabled)
	}
}

// SetEnabled enables or disables machine id from the UI: it is saved over
// herdr's catalog, and the machine connects or ends its session at once. A
// disabled machine's panes keep running in its herdr.
func (mg *Manager) SetEnabled(id string, on bool) error {
	m := mg.Get(id)
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
	mg := &Manager{logger: logger, dial: dial, byID: map[string]*Machine{}, stops: map[string]func(){},
		subs: map[int]func(State){}, agentFn: map[int]func(AgentEvent){}}
	for _, s := range specs {
		mg.order = append(mg.order, s.ID)
		mg.byID[s.ID] = mg.newMachine(s)
	}
	return mg
}

// newMachine creates a machine whose state changes and agent events reach
// the subscribers while it belongs to the manager: a removed machine's last
// steps publish nothing.
func (mg *Manager) newMachine(s Spec) *Machine {
	var m *Machine
	m = newMachine(s, mg.dial, mg.logger, func(st State) {
		if mg.Get(st.ID) == m {
			mg.broadcast(st)
		}
	}, func(ev AgentEvent) {
		if mg.Get(ev.Machine) == m {
			mg.broadcastAgent(ev)
		}
	})
	m.streams = mg.streams
	return m
}

// Run connects every enabled machine, and those added later, until ctx
// ends.
func (mg *Manager) Run(ctx context.Context) {
	mg.mmu.Lock()
	mg.ctx = ctx
	for _, id := range mg.order {
		mg.start(mg.byID[id])
	}
	mg.mmu.Unlock()
	<-ctx.Done()
	mg.mmu.Lock()
	mg.ended = true
	mg.mmu.Unlock()
	mg.wg.Wait()
}

// removeWait bounds how long Remove waits for a machine's session to end.
var removeWait = 15 * time.Second

// start runs m's connection loop until the manager's context ends or m is
// removed; mg.mmu is held. Before Run, Run starts it.
func (mg *Manager) start(m *Machine) {
	if mg.ctx == nil || mg.ended {
		return
	}
	ctx, cancel := context.WithCancel(mg.ctx)
	done := make(chan struct{})
	mg.stops[m.ID()] = func() {
		cancel()
		select {
		case <-done:
		case <-time.After(removeWait):
			mg.logger.Printf("machine %s: session did not end within %s", m.Label(), removeWait)
		}
	}
	mg.wg.Add(1)
	go func() {
		defer mg.wg.Done()
		defer close(done)
		m.Run(ctx)
	}()
}

// Add adds a machine, one just saved in herdr's catalog, and connects it
// unless it is disabled (by herdr or by the user's earlier choice for its
// id).
func (mg *Manager) Add(s Spec) error {
	if mg.overrides != nil {
		specs := []Spec{s}
		mg.overrides.Apply(specs)
		s = specs[0]
	}
	m := mg.newMachine(s)
	mg.mmu.Lock()
	defer mg.mmu.Unlock()
	if mg.byID[s.ID] != nil {
		return ErrMachineExists
	}
	mg.order = append(mg.order, s.ID)
	mg.byID[s.ID] = m
	mg.start(m)
	return nil
}

// Remove forgets a machine removed from herdr's catalog: its session ends
// (the agent exits and stops what it started; its panes keep running in its
// herdr) and its enabled choice is dropped. The local machine stays.
func (mg *Manager) Remove(id string) error {
	mg.mmu.Lock()
	m := mg.byID[id]
	if m == nil {
		mg.mmu.Unlock()
		return ErrUnknownMachine
	}
	if m.Local() {
		mg.mmu.Unlock()
		return ErrLocalMachine
	}
	delete(mg.byID, id)
	mg.order = slices.DeleteFunc(slices.Clone(mg.order), func(x string) bool { return x == id })
	stop := mg.stops[id]
	delete(mg.stops, id)
	mg.mmu.Unlock()
	if stop != nil {
		stop()
	}
	if mg.overrides != nil {
		if err := mg.overrides.Forget(id); err != nil {
			mg.logger.Printf("machine %s: %v", m.Label(), err)
		}
	}
	return nil
}

// Update applies what changed in herdr's catalog for a machine the core
// has: its label, and herdr's enabled flag unless the user enabled or
// disabled the machine here. The target and session stay as they were. It
// reports whether anything changed.
func (mg *Manager) Update(s Spec) (bool, error) {
	m := mg.Get(s.ID)
	if m == nil {
		return false, ErrUnknownMachine
	}
	if mg.overrides != nil {
		specs := []Spec{s}
		mg.overrides.Apply(specs)
		s = specs[0]
	}
	renamed := m.setLabel(s.Label)
	toggled := m.setEnabled(s.Enabled)
	return renamed || toggled, nil
}

// SetStreamHandler installs the handler for agent-initiated streams. Call
// before Run.
func (mg *Manager) SetStreamHandler(h StreamHandler) {
	mg.mmu.Lock()
	defer mg.mmu.Unlock()
	mg.streams = h
	for _, m := range mg.byID {
		m.streams = h
	}
}

// Get returns a machine by id.
func (mg *Manager) Get(id string) *Machine {
	mg.mmu.RLock()
	defer mg.mmu.RUnlock()
	return mg.byID[id]
}

// list returns the machines in configured order.
func (mg *Manager) list() []*Machine {
	mg.mmu.RLock()
	defer mg.mmu.RUnlock()
	out := make([]*Machine, 0, len(mg.order))
	for _, id := range mg.order {
		out = append(out, mg.byID[id])
	}
	return out
}

// States returns all machine states in configured order.
func (mg *Manager) States() []State {
	ms := mg.list()
	out := make([]State, 0, len(ms))
	for _, m := range ms {
		out = append(out, m.State())
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
