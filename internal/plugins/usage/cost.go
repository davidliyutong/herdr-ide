package usage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"sort"
	"strconv"
	"strings"
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
	// costKeep is how many reports (days|tz|...) are kept.
	costKeep = 4
	// machineCostKeep bounds per-machine ETag cached reports.
	machineCostKeep = 64
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
	at   time.Time
	rep  *CostReport
	etag string
}

type machineCostEntry struct {
	etag string
	rep  usage.CostReport
	at   time.Time
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
	rep, _ := p.costWithETag(ctx, days, tz)
	return rep
}

func costKey(days, tz int, o usage.Options, priceKey string) string {
	provs := slices.Clone(o.Providers)
	sort.Strings(provs)
	homes := slices.Clone(o.CodexHomes)
	sort.Strings(homes)
	return strconv.Itoa(days) + "|" + strconv.Itoa(tz) + "|" +
		strings.Join(provs, ",") + "|" + strings.Join(homes, "\x00") + "|" + priceKey
}

func (p *Plugin) costWithETag(ctx context.Context, days, tz int) (*CostReport, string) {
	own, priceKey := p.prices()
	o := p.options()
	key := costKey(days, tz, o, priceKey)
	now := p.now()
	p.mu.Lock()
	if p.costCache == nil {
		p.costCache = map[string]costEntry{}
	}
	if e, ok := p.costCache[key]; ok && now.Sub(e.at) < costFresh {
		p.mu.Unlock()
		return e.rep, e.etag
	}
	ready := p.readyList()
	p.mu.Unlock()

	// From the start of the user's day days-1 days ago.
	zone := time.FixedZone("", tz*60)
	local := now.In(zone)
	since := time.Date(local.Year(), local.Month(), local.Day()-(days-1), 0, 0, 0, 0, zone).Unix()
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
	// Sort merged rows deterministically so identical data across scans
	// yields the same ETag regardless of goroutine completion order.
	sort.Slice(rep.Rows, func(i, j int) bool {
		a, b := rep.Rows[i], rep.Rows[j]
		if a.Machine != b.Machine {
			return a.Machine < b.Machine
		}
		if a.Day != b.Day {
			return a.Day < b.Day
		}
		if a.Provider != b.Provider {
			return a.Provider < b.Provider
		}
		if a.Model != b.Model {
			return a.Model < b.Model
		}
		return a.Project < b.Project
	})
	etag := costReportETag(rep)
	if ctx.Err() != nil {
		// The request gave up: what it missed is not served to others.
		return rep, etag
	}
	p.mu.Lock()
	// Fresh from when the scans ended, however long they took.
	p.costCache[key] = costEntry{at: p.now(), rep: rep, etag: etag}
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
	return rep, etag
}

// costReportETag hashes the report's content (excluding GeneratedAt) so
// unchanged reports answer 304 Not Modified.
func costReportETag(rep *CostReport) string {
	cp := *rep
	cp.GeneratedAt = 0
	b, _ := json.Marshal(&cp)
	return jsonETag("c", b)
}

func jsonETag(prefix string, b []byte) string {
	sum := sha256.Sum256(b)
	return `"` + prefix + "-" + hex.EncodeToString(sum[:8]) + `"`
}

// machineCost asks machine m for the cost of key's days: a scan of the
// same parameters in progress is shared, one of others is waited for (the
// agent scans one at a time anyway). The scan is bounded by costTimeout,
// not by the request that started it, so that the others can share it.
// When the core already holds a report with an ETag for (m, key), it sends
// IfNoneMatch so an unchanged machine answers NotModified with no rows.
func (p *Plugin) machineCost(ctx context.Context, m, key string, params usage.CostOptions) (usage.CostReport, error) {
	mcKey := m + "|" + key
	for {
		p.mu.Lock()
		if p.costFlights == nil {
			p.costFlights = map[string]*costFlight{}
		}
		f := p.costFlights[m]
		if f == nil {
			f = &costFlight{key: key, done: make(chan struct{})}
			p.costFlights[m] = f
			prev, hasPrev := p.machineCosts[mcKey]
			p.mu.Unlock()
			req := params
			if hasPrev && prev.etag != "" {
				req.IfNoneMatch = prev.etag
			}
			cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), costTimeout)
			f.err = p.call(cctx, m, "cost", req, &f.rep)
			cancel()
			if f.err == nil && f.rep.NotModified && hasPrev {
				f.rep = prev.rep
			}
			p.mu.Lock()
			if f.err == nil && f.rep.ETag != "" {
				if p.machineCosts == nil {
					p.machineCosts = map[string]machineCostEntry{}
				}
				p.machineCosts[mcKey] = machineCostEntry{etag: f.rep.ETag, rep: f.rep, at: p.now()}
				for len(p.machineCosts) > machineCostKeep {
					oldest := ""
					for k, e := range p.machineCosts {
						if oldest == "" || e.at.Before(p.machineCosts[oldest].at) {
							oldest = k
						}
					}
					delete(p.machineCosts, oldest)
				}
			}
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
