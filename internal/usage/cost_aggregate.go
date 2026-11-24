package usage

import (
	"sort"
	"time"
)

type rowKey struct{ day, provider, model, project string }

// aggregateCost dedupes the records (the most output wins) and sums them
// by day, model and project from o.Since on, and by provider and quarter of
// an hour from o.RecentSince on (when not 0).
func aggregateCost(c *costCache, seen map[string]bool, o CostOptions) *CostReport {
	rep := &CostReport{Since: o.Since, Rows: []CostRow{}}
	sid := map[string]string{}
	for p, ent := range c.Files {
		if seen[p] && ent.Kind == logGrokEvents {
			for k, v := range ent.Models {
				if _, ok := sid[k]; !ok {
					sid[k] = v
				}
			}
		}
	}
	type keyed struct {
		provider string
		r        Record
	}
	best := map[string]keyed{}
	var plain []keyed
	paths := make([]string, 0, len(c.Files))
	for p := range c.Files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		ent := c.Files[p]
		if !seen[p] || ent.Kind == logGrokEvents {
			continue
		}
		prov := providerOf(ent.Kind)
		rep.Files++
		from := o.Since
		if o.RecentSince != 0 {
			from = min(from, o.RecentSince)
		}
		for _, r := range ent.Records {
			if r.T < from {
				continue
			}
			if r.E {
				rep.Retries++
				continue
			}
			if r.S != "" && r.M == "" {
				r.M = firstNonEmpty(sid[r.S], "unknown")
			}
			if r.K == "" {
				plain = append(plain, keyed{prov, r})
				continue
			}
			if b, ok := best[r.K]; !ok || r.O > b.r.O {
				best[r.K] = keyed{prov, r}
			}
		}
	}
	for _, k := range best {
		plain = append(plain, k)
	}
	rows := map[rowKey]*CostRow{}
	type slotKey struct {
		at       int64
		provider string
	}
	slots := map[slotKey]*CostSlot{}
	unpriced := map[string]bool{}
	zone := time.FixedZone("", o.TZOffset*60)
	for _, k := range plain {
		r := k.r
		day := time.Unix(r.T, 0).In(zone).Format("2006-01-02")
		// OpenCode's and Antigravity's steps by the table of the API that
		// served them (none for OpenCode's others: the user's prices only),
		// else at the cost OpenCode recorded.
		table := k.provider
		switch k.provider {
		case OpenCode:
			table = openCodeTables[r.V]
		case Antigravity:
			table = antigravityTable(r.M)
		}
		label, mp := Pricing.PricingWith(table, r.M, o.Prices)
		cost, priced := 0.0, mp != nil
		if priced {
			basis := r.X
			if basis == 0 {
				basis = r.I + r.C + r.W + r.H
			}
			_, tier := mp.Tier(basis)
			cost = tier.Cost(r.I, r.C, r.W, r.H, r.O)
		} else if r.P > 0 {
			label, cost, priced = r.M, r.P, true
		} else {
			label = r.M
			if r.T >= o.Since {
				unpriced[k.provider+"/"+r.M] = true
			}
		}
		if o.RecentSince != 0 && r.T >= o.RecentSince {
			sk := slotKey{r.T - r.T%SlotSec, k.provider}
			s := slots[sk]
			if s == nil {
				s = &CostSlot{At: sk.at, Provider: sk.provider, Priced: true}
				slots[sk] = s
			}
			s.Tokens += r.I + r.C + r.W + r.H + r.O
			s.Requests += max(r.N, 1)
			s.Cost += cost
			s.Priced = s.Priced && priced
		}
		if r.T < o.Since {
			continue
		}
		rk := rowKey{day, k.provider, label, r.J}
		row := rows[rk]
		if row == nil {
			row = &CostRow{Day: day, Provider: k.provider, Model: label, Project: r.J, Priced: priced}
			rows[rk] = row
		}
		// A model some of whose steps OpenCode recorded no cost for.
		row.Priced = row.Priced && priced
		row.Input += r.I
		row.Cached += r.C
		row.CacheWrite += r.W + r.H
		row.Output += r.O
		row.Reasoning += r.R
		row.Requests += max(r.N, 1)
		row.Cost += cost
	}
	for _, row := range rows {
		rep.Rows = append(rep.Rows, *row)
	}
	sort.Slice(rep.Rows, func(i, j int) bool {
		a, b := rep.Rows[i], rep.Rows[j]
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
	for _, s := range slots {
		rep.Recent = append(rep.Recent, *s)
	}
	sort.Slice(rep.Recent, func(i, j int) bool {
		a, b := rep.Recent[i], rep.Recent[j]
		if a.At != b.At {
			return a.At < b.At
		}
		return a.Provider < b.Provider
	})
	for k := range unpriced {
		rep.Unpriced = append(rep.Unpriced, k)
	}
	sort.Strings(rep.Unpriced)
	return rep
}
