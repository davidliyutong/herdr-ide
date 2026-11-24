package usage

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"sync"

	"veldr/internal/usage"
)

// Status pages: Statuspage's summaries for Anthropic and OpenAI, Google's
// incident feed for Antigravity; the others are links.
var (
	StatusURLs = map[string]string{
		usage.Claude:      "https://status.claude.com/api/v2/status.json",
		usage.Codex:       "https://status.openai.com/api/v2/status.json",
		usage.Antigravity: "https://www.google.com/appsstatus/dashboard/incidents.json",
	}
	statusPages = map[string]string{
		usage.Claude:      "https://status.claude.com",
		usage.Codex:       "https://status.openai.com",
		usage.Antigravity: "https://www.google.com/appsstatus/dashboard/",
		usage.Grok:        "https://status.x.ai",
		usage.DeepSeek:    "https://status.deepseek.com",
	}
)

// antigravityProduct is Antigravity's id in Google's incident feed.
const antigravityProduct = "npdyhgECDJ6tB66MxXyo"

var statusHTTP = usage.NewClient()

func fetchStatusJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	res, err := statusHTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return io.ErrUnexpectedEOF
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
}

// pollStatus asks the status pages of the providers turned on; a page
// that does not answer keeps what it said last (or stays a link).
func (p *Plugin) pollStatus(ctx context.Context) {
	enabled := p.options().Providers
	var wg sync.WaitGroup
	var mu sync.Mutex
	got := map[string]StatusPage{}
	for prov, page := range statusPages {
		if !slices.Contains(enabled, prov) {
			continue
		}
		mu.Lock()
		got[prov] = StatusPage{URL: page}
		mu.Unlock()
		url := StatusURLs[prov]
		if url == "" {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			var sp StatusPage
			var ok bool
			if prov == usage.Antigravity {
				var incidents []googleIncident
				if p.statusClient(ctx, url, &incidents) == nil {
					sp, ok = googleStatus(incidents), true
				}
			} else {
				var v struct {
					Status struct {
						Indicator   string `json:"indicator"`
						Description string `json:"description"`
					} `json:"status"`
				}
				if p.statusClient(ctx, url, &v) == nil && v.Status.Indicator != "" {
					sp, ok = StatusPage{Indicator: v.Status.Indicator, Description: v.Status.Description}, true
				}
			}
			if !ok {
				return
			}
			sp.URL, sp.At = page, p.now().Unix()
			mu.Lock()
			got[prov] = sp
			mu.Unlock()
		}()
	}
	wg.Wait()
	p.mu.Lock()
	for prov, sp := range got {
		if sp.Indicator == "" && p.status[prov].Indicator != "" {
			continue // keep what the page said last
		}
		p.status[prov] = sp
	}
	for prov := range p.status {
		if _, ok := got[prov]; !ok {
			delete(p.status, prov)
		}
	}
	p.mu.Unlock()
	p.broadcast()
}

type googleIncident struct {
	End              string `json:"end"`
	Severity         string `json:"severity"`
	ExternalDesc     string `json:"external_desc"`
	AffectedProducts []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	} `json:"affected_products"`
}

// googleStatus is Antigravity's state: its open incidents of the feed.
func googleStatus(incidents []googleIncident) StatusPage {
	sp := StatusPage{Indicator: "none"}
	for _, in := range incidents {
		if in.End != "" {
			continue
		}
		affected := false
		for _, pr := range in.AffectedProducts {
			affected = affected || pr.ID == antigravityProduct
		}
		if !affected {
			continue
		}
		ind := "minor"
		if in.Severity == "high" {
			ind = "major"
		}
		if sp.Indicator != "major" {
			sp.Indicator, sp.Description = ind, in.ExternalDesc
		}
	}
	return sp
}
