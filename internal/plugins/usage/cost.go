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

	"veldr/internal/plugin"
	"veldr/internal/usage"
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
	// recentSpan is how far back the report's quarter hours go: past the
	// start of a week's window (CostReport.Recent).
	recentSpan = 8 * 24 * time.Hour
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

// CostSlot is a machine's quarter of an hour of a provider's spend.
type CostSlot struct {
	usage.CostSlot
	Machine string `json:"machine"`
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
	// Recent are the machines' quarters of an hour with spend since
	// RecentSince (recentSpan back, at the start of a UTC day so that it
	// changes once a day): what a subscription's window (5 hours, a week)
	// has cost.
	RecentSince int64      `json:"recentSince"`
	Recent      []CostSlot `json:"recent"`
}

type costEntry struct {
	at   time.Time
	rep  *CostReport
	etag string
}

type machineCostEntry struct {
	Machine    string           `json:"machine"`
	TZOffset   int              `json:"tzOffset"`
	Since      int64            `json:"since"`
	CodexHomes []string         `json:"codexHomes,omitempty"`
	PriceKey   string           `json:"priceKey,omitempty"`
	ETag       string           `json:"etag"`
	Rep        usage.CostReport `json:"rep"`
	At         time.Time        `json:"at"`
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
	p.ensureMachineCosts()
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
	recent := now.Add(-recentSpan).Unix()
	recent -= recent % 86400
	params := usage.CostOptions{Since: since, RecentSince: recent, TZOffset: tz, CodexHomes: o.CodexHomes, Providers: o.Providers, Prices: own}
	rep := &CostReport{
		GeneratedAt: now.Unix(), Days: days, TZOffset: tz, Since: since,
		WeekHours: usage.Pricing.WeekHours, MonthHours: usage.Pricing.MonthHours,
		Machines: map[string]MachineCost{}, Rows: []CostRow{},
		RecentSince: recent, Recent: []CostSlot{},
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, m := range ready {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := p.machineCost(ctx, m, key, params, priceKey)
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
			for _, s := range r.Recent {
				rep.Recent = append(rep.Recent, CostSlot{CostSlot: s, Machine: m})
			}
		}()
	}
	wg.Wait()
	// Include cached historical cost reports for machines that are not ready
	// (such as disabled or offline machines) without live-polling them.
	p.appendCachedNonReadyCosts(rep, ready, key, params, priceKey)
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
	sort.Slice(rep.Recent, func(i, j int) bool {
		a, b := rep.Recent[i], rep.Recent[j]
		if a.Machine != b.Machine {
			return a.Machine < b.Machine
		}
		if a.At != b.At {
			return a.At < b.At
		}
		return a.Provider < b.Provider
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

// appendCachedNonReadyCosts adds the last cached cost report for any
// configured (including disabled or offline) machine not in ready, filtered
// to params without polling the machine.
func (p *Plugin) appendCachedNonReadyCosts(rep *CostReport, ready []string, key string, params usage.CostOptions, priceKey string) {
	var known func(string) bool
	if h := p.getHost(); h != nil && h.Machines() != nil {
		mg := h.Machines()
		known = func(m string) bool { return mg.Get(m) != nil }
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	seen := map[string]bool{}
	var machines []string
	for _, e := range p.machineCosts {
		if e.Machine == "" || slices.Contains(ready, e.Machine) || seen[e.Machine] {
			continue
		}
		if known != nil && !known(e.Machine) {
			continue
		}
		seen[e.Machine] = true
		machines = append(machines, e.Machine)
	}
	sort.Strings(machines)
	for _, m := range machines {
		r, ok := p.cachedMachineCostLocked(m, key, params, priceKey)
		if !ok {
			continue
		}
		rep.Machines[m] = MachineCost{Files: r.Files, Retries: r.Retries, Unpriced: r.Unpriced, Failed: r.Failed}
		for _, row := range r.Rows {
			rep.Rows = append(rep.Rows, CostRow{CostRow: row, Machine: m})
		}
		for _, s := range r.Recent {
			rep.Recent = append(rep.Recent, CostSlot{CostSlot: s, Machine: m})
		}
	}
}

// cachedMachineCostLocked returns machine m's cached report for key, or
// falls back to its best matching cached report filtered to params; p.mu is held.
func (p *Plugin) cachedMachineCostLocked(m, key string, params usage.CostOptions, priceKey string) (usage.CostReport, bool) {
	if e, ok := p.machineCosts[m+"|"+key]; ok {
		return e.Rep, true
	}
	var best *machineCostEntry
	bestScore := -1
	for _, e := range p.machineCosts {
		if e.Machine != m {
			continue
		}
		score := 0
		if e.TZOffset == params.TZOffset {
			score += 8
		}
		if e.Since <= params.Since {
			score += 4
		}
		if e.PriceKey == priceKey {
			score += 2
		}
		if slices.Equal(e.CodexHomes, params.CodexHomes) {
			score += 1
		}
		if best == nil || score > bestScore ||
			(score == bestScore && (e.At.After(best.At) || (e.At.Equal(best.At) && e.Since < best.Since))) {
			cp := e
			best = &cp
			bestScore = score
		}
	}
	if best == nil {
		return usage.CostReport{}, false
	}
	return filterMachineCostReport(best.Rep, params), true
}

func filterMachineCostReport(r usage.CostReport, params usage.CostOptions) usage.CostReport {
	sinceDay := time.Unix(params.Since, 0).In(time.FixedZone("", params.TZOffset*60)).Format("2006-01-02")
	wantProvider := func(prov string) bool {
		return len(params.Providers) == 0 || slices.Contains(params.Providers, prov)
	}
	out := usage.CostReport{
		Since:   params.Since,
		Files:   r.Files,
		Retries: r.Retries,
		Rows:    make([]usage.CostRow, 0, len(r.Rows)),
	}
	for _, s := range r.Recent {
		if s.At >= params.RecentSince && wantProvider(s.Provider) {
			out.Recent = append(out.Recent, s)
		}
	}
	unpricedSet := map[string]bool{}
	for _, row := range r.Rows {
		if row.Day < sinceDay || !wantProvider(row.Provider) {
			continue
		}
		out.Rows = append(out.Rows, row)
		if !row.Priced {
			unpricedSet[row.Provider+"/"+row.Model] = true
		}
	}
	for u := range unpricedSet {
		out.Unpriced = append(out.Unpriced, u)
	}
	sort.Strings(out.Unpriced)
	for _, f := range r.Failed {
		prov, _, _ := strings.Cut(f, ":")
		if wantProvider(prov) {
			out.Failed = append(out.Failed, f)
		}
	}
	return out
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
func (p *Plugin) machineCost(ctx context.Context, m, key string, params usage.CostOptions, priceKey string) (usage.CostReport, error) {
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
			if hasPrev && prev.ETag != "" {
				req.IfNoneMatch = prev.ETag
			}
			cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), costTimeout)
			f.err = p.call(cctx, m, "cost", req, &f.rep)
			cancel()
			modified := !f.rep.NotModified || !hasPrev
			if f.err == nil && f.rep.NotModified && hasPrev {
				f.rep = prev.Rep
			}
			var savedEntry machineCostEntry
			var evicted []string
			shouldSave := false
			p.mu.Lock()
			if f.err == nil {
				if p.machineCosts == nil {
					p.machineCosts = map[string]machineCostEntry{}
				}
				savedEntry = machineCostEntry{
					Machine:    m,
					TZOffset:   params.TZOffset,
					Since:      params.Since,
					CodexHomes: slices.Clone(params.CodexHomes),
					PriceKey:   priceKey,
					ETag:       f.rep.ETag,
					Rep:        f.rep,
					At:         p.now(),
				}
				p.machineCosts[mcKey] = savedEntry
				shouldSave = modified
				for len(p.machineCosts) > machineCostKeep {
					oldest := evictMachineCostKeyLocked(p.machineCosts)
					if oldest == "" {
						break
					}
					delete(p.machineCosts, oldest)
					evicted = append(evicted, oldest)
				}
			}
			delete(p.costFlights, m)
			p.mu.Unlock()
			if shouldSave {
				p.saveMachineCost(mcKey, savedEntry, evicted)
			}
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

// evictMachineCostKeyLocked picks the oldest cached entry to evict, preferring
// machines with more than one cached entry so a disabled machine's sole
// snapshot is kept.
func evictMachineCostKeyLocked(costs map[string]machineCostEntry) string {
	counts := map[string]int{}
	for _, e := range costs {
		counts[e.Machine]++
	}
	oldestMulti := ""
	oldestAny := ""
	for k, e := range costs {
		if oldestAny == "" || e.At.Before(costs[oldestAny].At) {
			oldestAny = k
		}
		if counts[e.Machine] > 1 && (oldestMulti == "" || e.At.Before(costs[oldestMulti].At)) {
			oldestMulti = k
		}
	}
	if oldestMulti != "" {
		return oldestMulti
	}
	return oldestAny
}
