package machines

import (
	"context"
	"log"
	"slices"
	"sync"
	"time"
)

// Manager owns all machines. Machines are added, removed, renamed, enabled
// and disabled while it runs; with a Registry (UseRegistry) those changes are
// stored.
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

	// reg stores the machines (UseRegistry); nil keeps changes in memory.
	reg *Registry
	// SSHSession is the herdr session of SSH machines added at runtime.
	SSHSession string
}

// UseRegistry stores later changes of the machines in r. Call before Run.
func (mg *Manager) UseRegistry(r *Registry) {
	mg.reg = r
}

// store writes machine s's record when the registry keeps it: a stored SSH
// machine, or the local machine. Machines given with --ssh are not stored.
func (mg *Manager) store(s Spec) error {
	if mg.reg == nil {
		return nil
	}
	if _, ok := mg.reg.Get(s.ID); !ok && s.ID != LocalID {
		return nil
	}
	return mg.reg.Put(s)
}

// spec is machine m's record as it is now.
func spec(m *Machine) Spec {
	st := m.State()
	s := m.spec
	s.Label, s.Enabled = st.Label, st.Enabled
	return s
}

// SetEnabled enables or disables machine id: stored, and the machine
// connects or ends its session at once. A disabled machine's programs keep
// running there.
func (mg *Manager) SetEnabled(id string, on bool) error {
	m := mg.Get(id)
	if m == nil {
		return ErrUnknownMachine
	}
	s := spec(m)
	s.Enabled = on
	if err := mg.store(s); err != nil {
		return err
	}
	m.setEnabled(on)
	return nil
}

// SetLabel renames machine id. The local machine keeps its host's name; a
// label another machine has (running or stored) is refused, since
// --machine selects by label.
func (mg *Manager) SetLabel(id, label string) error {
	m := mg.Get(id)
	if m == nil {
		return ErrUnknownMachine
	}
	if m.Local() {
		return ErrLocalMachine
	}
	if mg.taken(id, func(s Spec) bool { return s.Label == label }) {
		return ErrLabelTaken
	}
	s := spec(m)
	s.Label = label
	if err := mg.store(s); err != nil {
		return err
	}
	m.setLabel(label)
	return nil
}

// taken reports whether a machine other than id, running or stored, matches.
func (mg *Manager) taken(id string, match func(Spec) bool) bool {
	for _, m := range mg.list() {
		if m.ID() != id && match(spec(m)) {
			return true
		}
	}
	if mg.reg != nil {
		for _, s := range mg.reg.Specs() {
			if s.ID != id && match(s) {
				return true
			}
		}
	}
	return false
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

// Add adds an SSH machine, stores it and connects it unless it is
// disabled. A machine with its id or its target exists already.
func (mg *Manager) Add(s Spec) error {
	s.Kind = KindSSH
	if s.Session == "" {
		s.Session = mg.SSHSession
	}
	if s.ID == "" || mg.taken("", func(o Spec) bool { return o.ID == s.ID || (o.Kind == KindSSH && o.Target == s.Target) }) {
		return ErrMachineExists
	}
	if mg.reg != nil {
		if err := mg.reg.Put(s); err != nil {
			return err
		}
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

// Remove forgets a machine: its record is deleted and its session ends (the
// agent exits and stops what it started; programs in its terminal core keep
// running there). The local machine stays.
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
	if mg.reg != nil {
		if err := mg.reg.Delete(id); err != nil {
			mg.mmu.Unlock()
			return err
		}
	}
	delete(mg.byID, id)
	mg.order = slices.DeleteFunc(slices.Clone(mg.order), func(x string) bool { return x == id })
	stop := mg.stops[id]
	delete(mg.stops, id)
	mg.mmu.Unlock()
	if stop != nil {
		stop()
	}
	return nil
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
