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

// cost asks the connected machines for their logs' cost of the last days
// (the user's days: tz minutes east of UTC), all at once.
func (p *Plugin) cost(ctx context.Context, days, tz int) *CostReport {
	key := strconv.Itoa(days) + "|" + strconv.Itoa(tz)
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
	params := usage.CostOptions{Since: since, TZOffset: tz, CodexHomes: o.CodexHomes, Providers: o.Providers}
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
			cctx, cancel := context.WithTimeout(ctx, costTimeout)
			defer cancel()
			var r usage.CostReport
			err := p.call(cctx, m, "cost", params, &r)
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
			rep.Machines[m] = MachineCost{Files: r.Files, Retries: r.Retries, Unpriced: r.Unpriced}
			for _, row := range r.Rows {
				rep.Rows = append(rep.Rows, CostRow{CostRow: row, Machine: m})
			}
		}()
	}
	wg.Wait()
	p.mu.Lock()
	p.costCache = map[string]costEntry{key: {at: now, rep: rep}}
	p.mu.Unlock()
	return rep
}
