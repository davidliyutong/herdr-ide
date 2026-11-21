package usage

import (
	"context"
	"strconv"
	"sync"
	"time"

	"herdr-ide/internal/plugin"
	"herdr-ide/internal/usage"
)

const (
	// costTimeout bounds one machine's scan of its logs (the first one
	// reads 90 days of them).
	costTimeout = 120 * time.Second
	// costFresh is how long a cost report is served again.
	costFresh = time.Minute
	// costKeep is how many reports (days|tz) are kept.
	costKeep = 4
)

// CostRow is a machine's row of a cost report.
type CostRow struct {
	usage.CostRow
	Machine string `json:"machine"`
}

// MachineCost is how a machine's scan went.
type MachineCost struct {
	Error    string   `json:"error,omitempty"`
	Files    int      `json:"files"`
	Retries  int64    `json:"retries,omitempty"`
	Unpriced []string `json:"unpriced,omitempty"`
	// Failed are the logs the machine could not read (provider:code).
	Failed []string `json:"failed,omitempty"`
}

// CostReport is GET /api/p/usage/cost.
type CostReport struct {
	GeneratedAt int64                  `json:"generatedAt"`
	Days        int                    `json:"days"`
	TZOffset    int                    `json:"tzOffset"`
	Since       int64                  `json:"since"`
	WeekHours   float64                `json:"weekHours"`
	MonthHours  float64                `json:"monthHours"`
	Machines    map[string]MachineCost `json:"machines"`
	Rows        []CostRow              `json:"rows"`
}

type costEntry struct {
	at  time.Time
	rep *CostReport
}

// costFlight is a machine's scan in progress: one at a time per machine,
// which requests with the same parameters share.
type costFlight struct {
	key  string
	done chan struct{}
	rep  usage.CostReport
	err  error
}

// cost asks the connected machines for their logs' cost of the last days
// (the user's days: tz minutes east of UTC), all at once.
func (p *Plugin) cost(ctx context.Context, days, tz int) *CostReport {
	own, priceKey := p.prices()
	key := strconv.Itoa(days) + "|" + strconv.Itoa(tz) + "|" + priceKey
	now := p.now()
	p.mu.Lock()
	if p.costCache == nil {
		p.costCache = map[string]costEntry{}
	}
	if e, ok := p.costCache[key]; ok && now.Sub(e.at) < costFresh {
		p.mu.Unlock()
		return e.rep
	}
	ready := p.readyList()
	p.mu.Unlock()

	// From the start of the user's day days-1 days ago.
	zone := time.FixedZone("", tz*60)
	local := now.In(zone)
	since := time.Date(local.Year(), local.Month(), local.Day()-(days-1), 0, 0, 0, 0, zone).Unix()
	o := p.options()
	params := usage.CostOptions{Since: since, TZOffset: tz, CodexHomes: o.CodexHomes, Providers: o.Providers, Prices: own}
	rep := &CostReport{
		GeneratedAt: now.Unix(), Days: days, TZOffset: tz, Since: since,
		WeekHours: usage.Pricing.WeekHours, MonthHours: usage.Pricing.MonthHours,
		Machines: map[string]MachineCost{}, Rows: []CostRow{},
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, m := range ready {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := p.machineCost(ctx, m, key, params)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				code := "failed"
				if pe, ok := err.(*plugin.Error); ok {
					code = pe.Code
				}
				rep.Machines[m] = MachineCost{Error: code}
				return
			}
			rep.Machines[m] = MachineCost{Files: r.Files, Retries: r.Retries, Unpriced: r.Unpriced, Failed: r.Failed}
			for _, row := range r.Rows {
				rep.Rows = append(rep.Rows, CostRow{CostRow: row, Machine: m})
			}
		}()
	}
	wg.Wait()
	if ctx.Err() != nil {
		// The request gave up: what it missed is not served to others.
		return rep
	}
	p.mu.Lock()
	// Fresh from when the scans ended, however long they took.
	p.costCache[key] = costEntry{at: p.now(), rep: rep}
	for len(p.costCache) > costKeep {
		oldest := ""
		for k, e := range p.costCache {
			if oldest == "" || e.at.Before(p.costCache[oldest].at) {
				oldest = k
			}
		}
		delete(p.costCache, oldest)
	}
	p.mu.Unlock()
	return rep
}

// machineCost asks machine m for the cost of key's days: a scan of the
// same parameters in progress is shared, one of others is waited for (the
// agent scans one at a time anyway). The scan is bounded by costTimeout,
// not by the request that started it, so that the others can share it.
func (p *Plugin) machineCost(ctx context.Context, m, key string, params usage.CostOptions) (usage.CostReport, error) {
	for {
		p.mu.Lock()
		if p.costFlights == nil {
			p.costFlights = map[string]*costFlight{}
		}
		f := p.costFlights[m]
		if f == nil {
			f = &costFlight{key: key, done: make(chan struct{})}
			p.costFlights[m] = f
			p.mu.Unlock()
			cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), costTimeout)
			f.err = p.call(cctx, m, "cost", params, &f.rep)
			cancel()
			p.mu.Lock()
			delete(p.costFlights, m)
			p.mu.Unlock()
			close(f.done)
			return f.rep, f.err
		}
		p.mu.Unlock()
		select {
		case <-f.done:
		case <-ctx.Done():
			return usage.CostReport{}, ctx.Err()
		}
		if f.key == key {
			return f.rep, f.err
		}
	}
}
