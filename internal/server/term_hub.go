package server

import (
	"sync"

	"veldr/internal/agentproto"
)

type termHub struct {
	s        *Server
	mu       sync.Mutex
	backends map[string]*termBackend
}

func (h *termHub) backend(id string) *termBackend {
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.backends[id]
	if b == nil {
		b = &termBackend{s: h.s, id: id, state: termStarting, subs: map[*termClient]bool{}, wake: make(chan struct{}, 1),
			agents: map[string]agentproto.DetectEvent{}}
		h.backends[id] = b
	}
	return b
}

// forget drops the backend of a removed machine: its connection to the
// terminal core closes and its clients no longer count it as subscribed, so
// a machine added again under the same id starts afresh.
func (h *termHub) forget(id string) {
	h.mu.Lock()
	b := h.backends[id]
	delete(h.backends, id)
	h.mu.Unlock()
	if b == nil {
		return
	}
	b.mu.Lock()
	b.gone = true
	if b.idle != nil {
		b.idle.Stop()
		b.idle = nil
	}
	if b.stop != nil {
		b.stop()
		b.stop = nil
	}
	subs := make([]*termClient, 0, len(b.subs))
	for c := range b.subs {
		subs = append(subs, c)
	}
	clear(b.subs)
	b.mu.Unlock()
	for _, c := range subs {
		c.mu.Lock()
		if c.subs[id] == b {
			delete(c.subs, id)
		}
		c.mu.Unlock()
	}
}

// existing returns a machine's backend, nil when it has none.
func (h *termHub) existing(id string) *termBackend {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.backends[id]
}

// wakeUp ends a backend's wait before its next try (its machine connected).
func (h *termHub) wakeUp(id string) {
	h.mu.Lock()
	b := h.backends[id]
	h.mu.Unlock()
	if b != nil {
		b.wakeUp()
	}
}
