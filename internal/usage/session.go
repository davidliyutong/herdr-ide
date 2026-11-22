package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"
	"unsafe"

	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/agentproto"
)

// What one session of a coding agent used (the conversation view's and the
// status bar's numbers for a pane): the records of the session's transcript
// and its subagents' transcripts, read by the parsers the spend reads the
// CLIs' logs with and priced as the spend prices them, with the latest
// request's model and context.

const (
	// MaxSessionBytes bounds a transcript SessionCost reads: a larger one
	// is refused (ErrSessionTooLarge).
	MaxSessionBytes = 256 << 20
	// sessionContextBack is how far back from a transcript's end the
	// latest request's context is looked for.
	sessionContextBack = 16 << 20
	// sessionMemoSize bounds the transcripts whose last read is kept.
	sessionMemoSize = 16
	// sessionModelBytes bounds the model's name in a session's numbers.
	sessionModelBytes = 128
	// sessionParallel bounds the SessionCost calls that read at once; the
	// others wait their turn (or for their ctx to end).
	sessionParallel = 2
)

// What SessionCost holds and keeps, in records and in the bytes they take
// (recordBytes); variables so that the tests can make them small.
var (
	// sessionMaxRecords bounds the records one SessionCost call holds, of
	// all its transcripts and before duplicates are dropped: beyond, the
	// session is ErrSessionTooLarge.
	sessionMaxRecords = 200_000
	// sessionMaxHeld bounds the bytes of those records the same way.
	sessionMaxHeld int64 = 48 << 20
	// sessionMemoBytes bounds the bytes of the records the memo keeps of
	// all transcripts: the least recently used go first.
	sessionMemoBytes int64 = 48 << 20
)

// sessionSlots holds a token for each SessionCost that reads
// (sessionParallel).
var sessionSlots = make(chan struct{}, sessionParallel)

var (
	// ErrSessionTooLarge: a transcript is larger than MaxSessionBytes, or a
	// session's transcripts hold more records than are kept
	// (sessionMaxRecords, sessionMaxHeld).
	ErrSessionTooLarge = errors.New("usage: transcript too large")
	// ErrSessionProvider: SessionCost reads no transcripts of the provider.
	ErrSessionProvider = errors.New("usage: no session transcripts of this provider")
)

// SessionFile is a transcript SessionCost reads. Name keys what is kept of
// it from one call to the next (its path, also the cost cache's key); Open
// opens it for reading, and SessionCost closes what it returns. SessionCost
// opens nothing by name: the caller opens the file it located, so that the
// file read is that one (internal/agent/sessions opens it through no
// symbolic link, as the file it found). A subagent's transcript gone by now
// fails Open with an error that is os.ErrNotExist.
type SessionFile struct {
	Name string
	Open func() (*os.File, error)
}

// SessionOptions select how SessionCost prices a session.
type SessionOptions struct {
	// Prices are the user's (usage.prices, ParsePrices), over the table's
	// (PricingWith), as CostOptions.Prices.
	Prices map[string]Tier `json:"prices,omitempty"`
}

// SessionRequest is the params of the plugin's session action: the session
// of an agent of Kind (an agentkinds id, SessionProvider) whose id is
// Session (agentkinds.ValidSessionID), priced with the options.
type SessionRequest struct {
	Kind    string `json:"kind"`
	Session string `json:"session"`
	SessionOptions
}

// sessionLogKind is the kind of log of a provider's session transcripts:
// Claude Code's and Codex's are the logs the spend reads.
func sessionLogKind(provider string) (string, bool) {
	switch provider {
	case Claude:
		return logClaude, true
	case Codex:
		return logCodex, true
	}
	return "", false
}

// SessionProvider is the provider whose prices the sessions of the agents
// of kind (an agentkinds id) are priced with, false when SessionCost reads
// none of them: the kind is not known, has no subscription the plugin
// reads, or keeps no transcripts of the provider's logs.
func SessionProvider(kind string) (string, bool) {
	k, ok := agentkinds.ByID(kind)
	if !ok || k.UsageProvider == "" {
		return "", false
	}
	if lk, ok := sessionLogKind(k.UsageProvider); !ok || lk != k.Transcript {
		return "", false
	}
	return k.UsageProvider, true
}

// SessionCost is what one session of a coding agent of provider used, at
// API prices. files are its transcripts: the session's own first, then its
// subagents' (one that is gone by now is left out). Each is read by the
// parser Cost reads the provider's logs with, its records deduplicated and
// left out past Retention as Cost does, and priced as Cost prices them, so
// that a transcript counts here what it counts in the spend; a response
// that several of the transcripts recorded counts once. Model (at most
// sessionModelBytes, cut at a character) and the context are those of the
// latest request of the session's own transcript.
//
// Only the members of the lines that carry usage are decoded, into structs
// without a text member: no prompt, reply or tool output is read.
//
// A transcript the cost cache holds unchanged is not read again, nor one
// read here before; one that grew is read on from where that read ended.
// At most sessionParallel calls read at once; a call holds at most
// sessionMaxRecords records (sessionMaxHeld bytes), ErrSessionTooLarge
// beyond; ctx is checked while reading.
func SessionCost(ctx context.Context, e *Env, provider string, files []SessionFile, o SessionOptions) (agentproto.SessionUsage, error) {
	kind, ok := sessionLogKind(provider)
	if !ok {
		return agentproto.SessionUsage{}, ErrSessionProvider
	}
	if len(files) == 0 {
		return agentproto.SessionUsage{}, os.ErrNotExist
	}
	select {
	case sessionSlots <- struct{}{}:
		defer func() { <-sessionSlots }()
	case <-ctx.Done():
		return agentproto.SessionUsage{}, ctx.Err()
	}
	cutoff := e.now().Add(-Retention).Unix()
	cachePath := ""
	if e.Base != "" {
		cachePath = path.Join(e.Base, CostCacheFile)
	}
	var main *sessionFile
	// One record per response across the transcripts, the one with the most
	// output (aggregateCost's rule); records without a key all count.
	best := map[string]int{}
	var recs []Record
	h := &held{}
	for i, file := range files {
		if err := ctx.Err(); err != nil {
			return agentproto.SessionUsage{}, err
		}
		sf, err := readSessionFile(ctx, file, kind, cachePath, i == 0, h)
		if err != nil {
			if i > 0 && errors.Is(err, os.ErrNotExist) {
				continue
			}
			return agentproto.SessionUsage{}, err
		}
		if i == 0 {
			main = sf
		}
		for _, r := range sf.ent.Records {
			if r.T < cutoff || r.E {
				continue
			}
			if r.K == "" {
				recs = append(recs, r)
				continue
			}
			if at, ok := best[r.K]; ok {
				if r.O > recs[at].O {
					recs[at] = r
				}
				continue
			}
			best[r.K] = len(recs)
			recs = append(recs, r)
		}
	}
	u := agentproto.SessionUsage{Priced: true}
	for _, r := range recs {
		cost, priced := priceRecord(provider, r, o.Prices)
		u.Input += r.I
		u.Cached += r.C
		u.CacheWrite += r.W + r.H
		u.Output += r.O
		u.Reasoning += r.R
		u.Requests += max(r.N, 1)
		u.Cost += cost
		u.Priced = u.Priced && priced
	}
	u.Model = main.model
	if kind == logCodex && main.ent.Codex != nil && main.ent.Codex.Model != "" {
		// The last turn's model, also before its first response.
		u.Model = main.ent.Codex.Model
	}
	if u.Model == "" {
		if n := len(main.ent.Records); n > 0 {
			u.Model = main.ent.Records[n-1].M
		}
	}
	u.ContextUsed, u.ContextSize = main.used, main.window
	if u.ContextSize == 0 && u.Model != "" {
		u.ContextSize = contextWindow(provider, u.Model)
	}
	u.Model = cutModel(u.Model)
	return u, nil
}

// cutModel is a model's name of at most sessionModelBytes, cut at the
// start of a character.
func cutModel(m string) string {
	if len(m) <= sessionModelBytes {
		return m
	}
	i := sessionModelBytes
	for i > 0 && !utf8.RuneStart(m[i]) {
		i--
	}
	return m[:i]
}

// recordSize is what a Record takes besides its strings.
const recordSize = int64(unsafe.Sizeof(Record{}))

// recordBytes is about what a record takes in memory.
func recordBytes(r *Record) int64 {
	return recordSize + int64(len(r.K)+len(r.M)+len(r.S)+len(r.J)+len(r.V))
}

// entryBytes is about what the records of a read take in memory.
func entryBytes(ent *fileEntry) int64 {
	var n int64
	for i := range ent.Records {
		n += recordBytes(&ent.Records[i])
	}
	return n
}

// held counts the records one SessionCost holds, against
// sessionMaxRecords and sessionMaxHeld.
type held struct {
	records int
	bytes   int64
}

// add counts rs: ErrSessionTooLarge past a bound.
func (h *held) add(rs []Record) error {
	for i := range rs {
		h.bytes += recordBytes(&rs[i])
	}
	h.records += len(rs)
	if h.records > sessionMaxRecords || h.bytes > sessionMaxHeld {
		return ErrSessionTooLarge
	}
	return nil
}

// boundedReader is a transcript as its parser reads it: each read checks
// ctx and counts the records the parser made of what it read before
// (held), so that a read ends once ctx ends or the records are too many.
type boundedReader struct {
	ctx     context.Context
	r       io.Reader
	ent     *fileEntry
	h       *held
	counted int
}

func (b *boundedReader) Read(p []byte) (int, error) {
	if err := b.ctx.Err(); err != nil {
		return 0, err
	}
	if err := b.count(); err != nil {
		return 0, err
	}
	return b.r.Read(p)
}

// count counts the records made since the last count.
func (b *boundedReader) count() error {
	rs := b.ent.Records
	if len(rs) < b.counted {
		b.counted = len(rs)
	}
	err := b.h.add(rs[b.counted:])
	b.counted = len(rs)
	return err
}

// ctxReaderAt is r whose reads fail once ctx ends.
type ctxReaderAt struct {
	ctx context.Context
	r   io.ReaderAt
}

func (c ctxReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.ReadAt(p, off)
}

// priceRecord is a record's cost and whether its model has a price, as
// aggregateCost prices the records of Claude's and Codex's logs: by the
// provider's table with the user's prices, the tier by the prompt's
// length; else at the cost the CLI recorded; else none.
func priceRecord(provider string, r Record, own map[string]Tier) (float64, bool) {
	_, mp := Pricing.PricingWith(provider, r.M, own)
	if mp == nil {
		return r.P, r.P > 0
	}
	basis := r.X
	if basis == 0 {
		basis = r.I + r.C + r.W + r.H
	}
	_, tier := mp.Tier(basis)
	return tier.Cost(r.I, r.C, r.W, r.H, r.O), true
}

// contextWindows are the context windows (tokens) the price table gives
// its models, by provider and model name prefix: an entry's optional
// contextWindow member.
var contextWindows = func() map[string]map[string]int64 {
	var t struct {
		Providers map[string]map[string]struct {
			ContextWindow int64 `json:"contextWindow"`
		} `json:"providers"`
	}
	out := map[string]map[string]int64{}
	if json.Unmarshal(pricingJSON, &t) != nil {
		return out
	}
	for prov, models := range t.Providers {
		for m, v := range models {
			if v.ContextWindow > 0 {
				if out[prov] == nil {
					out[prov] = map[string]int64{}
				}
				out[prov][m] = v.ContextWindow
			}
		}
	}
	return out
}()

// contextWindow is the context window of a model as the price table gives
// it (the longest prefix of the model's name that has one), 0 when it
// gives none.
func contextWindow(provider, model string) int64 {
	best, n := "", int64(0)
	for k, v := range contextWindows[provider] {
		if strings.HasPrefix(model, k) && len(k) > len(best) {
			best, n = k, v
		}
	}
	return n
}

// sessionFile is what SessionCost read of a transcript at a size and time.
type sessionFile struct {
	ent *fileEntry
	// info is the file read: a file at the same name, size and time that
	// is another one is read again.
	info os.FileInfo
	// hasContext: model, used and window were looked for (the session's
	// own transcript); they are "" and 0 when no line within
	// sessionContextBack of the end gave them.
	hasContext   bool
	model        string
	used, window int64
	// bytes is about what the entry takes (entryBytes).
	bytes int64
	// use orders the memo's entries by their last use.
	use uint64
}

// sessionMemo keeps the last read of the transcripts SessionCost read
// lately, by name, at most sessionMemoSize of them and sessionMemoBytes: a
// session's numbers are asked for again and again while its pane shows,
// and its transcript grows by a few lines in between. Entries are not
// changed once kept.
var sessionMemo struct {
	sync.Mutex
	files map[string]*sessionFile
	use   uint64
	bytes int64
}

func memoGet(p string) *sessionFile {
	sessionMemo.Lock()
	defer sessionMemo.Unlock()
	sf := sessionMemo.files[p]
	if sf != nil {
		sessionMemo.use++
		sf.use = sessionMemo.use
	}
	return sf
}

// memoPut keeps sf, dropping the least recently used entries while there
// are too many or they take too much; one larger than sessionMemoBytes
// alone is not kept.
func memoPut(p string, sf *sessionFile) {
	sessionMemo.Lock()
	defer sessionMemo.Unlock()
	if sessionMemo.files == nil {
		sessionMemo.files = map[string]*sessionFile{}
	}
	if old := sessionMemo.files[p]; old != nil {
		sessionMemo.bytes -= old.bytes
		delete(sessionMemo.files, p)
	}
	if sf.bytes > sessionMemoBytes {
		return
	}
	sessionMemo.use++
	sf.use = sessionMemo.use
	sessionMemo.files[p] = sf
	sessionMemo.bytes += sf.bytes
	for len(sessionMemo.files) > sessionMemoSize || sessionMemo.bytes > sessionMemoBytes {
		oldest := ""
		for k, v := range sessionMemo.files {
			if oldest == "" || v.use < sessionMemo.files[oldest].use {
				oldest = k
			}
		}
		sessionMemo.bytes -= sessionMemo.files[oldest].bytes
		delete(sessionMemo.files, oldest)
	}
}

// readSessionFile reads a transcript of kind (opened by file.Open, only as
// a regular file, at most MaxSessionBytes): the memo's or the cost cache's
// read of it when the file is unchanged since, else on from that read when
// it only grew, else whole. With main it also looks for the latest
// request's context. Its records count in h.
func readSessionFile(ctx context.Context, file SessionFile, kind, cachePath string, main bool, h *held) (*sessionFile, error) {
	if file.Open == nil {
		return nil, os.ErrNotExist
	}
	f, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errNotRegular
	}
	size, mtime := st.Size(), st.ModTime().UnixNano()
	if size > MaxSessionBytes {
		return nil, ErrSessionTooLarge
	}
	p := file.Name
	var base *fileEntry
	old := memoGet(p)
	if old != nil && old.ent.Kind == kind && os.SameFile(old.info, st) {
		base = old.ent
	} else {
		old = nil
		base = cachedEntry(cachePath, p, kind)
	}
	unchanged := base != nil && base.Kind == kind && base.Size == size && base.MTime == mtime
	if unchanged && old != nil && (old.hasContext || !main) {
		if err := h.add(old.ent.Records); err != nil {
			return nil, err
		}
		return old, nil
	}
	sf := &sessionFile{ent: base, info: st}
	if !unchanged {
		if sf.ent, err = readOnSession(ctx, f, p, kind, size, mtime, base, h); err != nil {
			return nil, err
		}
	} else {
		if err := h.add(base.Records); err != nil {
			return nil, err
		}
		if old != nil {
			sf.hasContext, sf.model, sf.used, sf.window = old.hasContext, old.model, old.used, old.window
		}
	}
	if main && !sf.hasContext {
		sf.hasContext = true
		sf.model, sf.used, sf.window = latestContext(ctxReaderAt{ctx, f}, kind, size)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		sf.model = cutModel(sf.model)
	}
	sf.bytes = entryBytes(sf.ent) + int64(len(sf.model))
	memoPut(p, sf)
	return sf, nil
}

// cachedEntry is a copy of the cost cache's entry of a log of kind at p,
// nil when the cache has none or a scan holds it: a session is read again
// rather than waiting for a scan, which may take minutes.
func cachedEntry(cachePath, p, kind string) *fileEntry {
	if cachePath == "" || !costMu.TryLock() {
		return nil
	}
	defer costMu.Unlock()
	if memCost.path != cachePath || memCost.cache == nil {
		return nil
	}
	ent := memCost.cache.Files[p]
	if ent == nil || ent.Kind != kind {
		return nil
	}
	cp := &fileEntry{Kind: ent.Kind, Size: ent.Size, MTime: ent.MTime, Off: ent.Off, Records: slices.Clone(ent.Records)}
	if ent.Codex != nil {
		st := *ent.Codex
		cp.Codex = &st
	}
	return cp
}

// readOnSession reads a transcript of kind as parseLog reads a log, with
// its parser: on from where old ended when the file only grew (old's
// records and parser state carried over), else from the start; its last
// line counts once it ends. It reads the open file f up to size and no
// further, however much the file grew meanwhile, while ctx lasts and the
// records it holds count in h (boundedReader).
func readOnSession(ctx context.Context, f *os.File, p, kind string, size, mtime int64, old *fileEntry, h *held) (*fileEntry, error) {
	ent := &fileEntry{Kind: kind, Size: size, MTime: mtime}
	from := int64(0)
	if old != nil && old.Kind == kind && old.Off > 0 && old.Off <= size && mtime >= old.MTime &&
		(kind != logCodex || old.Codex != nil) && endsLine(f, old.Off) {
		from = old.Off
		ent.Records = slices.Clone(old.Records)
		if old.Codex != nil {
			st := *old.Codex
			ent.Codex = &st
		}
	}
	br := &boundedReader{ctx: ctx, r: io.NewSectionReader(f, from, size-from), ent: ent, h: h}
	end, err := logParsers[kind](p, br, false, ent)
	if err == nil {
		err = br.count()
	}
	if err != nil {
		return nil, err
	}
	ent.Off = from + end
	ent.Records = dedupe(ent.Records)
	return ent, nil
}

// latestContext is the model and the context of the latest request a
// transcript of kind records, looked for backwards from its end (within
// sessionContextBack): Claude Code's last assistant message of the main
// chain (not a subagent's, not one it made up), its prompt's tokens with
// the cache's; Codex's last token_count event with its info, the last
// request's input (its cached part included) and the model's context
// window. Only those members are decoded.
func latestContext(r io.ReaderAt, kind string, size int64) (model string, used, window int64) {
	from := max(size-sessionContextBack, 0)
	// A line cut at the section's start fails to decode and is skipped.
	eachLineBackward(io.NewSectionReader(r, from, size-from), size-from, func(line []byte) bool {
		switch kind {
		case logClaude:
			if !bytes.Contains(line, []byte(`"usage"`)) || !bytes.Contains(line, []byte(`"assistant"`)) {
				return false
			}
			var d struct {
				IsSidechain bool `json:"isSidechain"`
				Message     struct {
					Role  string `json:"role"`
					Model string `json:"model"`
					Usage struct {
						Input         int64 `json:"input_tokens"`
						CacheRead     int64 `json:"cache_read_input_tokens"`
						CacheCreation int64 `json:"cache_creation_input_tokens"`
						Breakdown     struct {
							W5 int64 `json:"ephemeral_5m_input_tokens"`
							W1 int64 `json:"ephemeral_1h_input_tokens"`
						} `json:"cache_creation"`
					} `json:"usage"`
				} `json:"message"`
			}
			if json.Unmarshal(line, &d) != nil || d.IsSidechain || d.Message.Role != "assistant" || d.Message.Model == "<synthetic>" {
				return false
			}
			u := d.Message.Usage
			// The cache writes as parseClaudeLine counts them.
			w := u.Breakdown.W5 + u.Breakdown.W1
			if w == 0 {
				w = u.CacheCreation
			}
			if n := u.Input + u.CacheRead + w; n > 0 {
				model, used = d.Message.Model, n
				return true
			}
		case logCodex:
			if !bytes.Contains(line, []byte(`"token_count"`)) {
				return false
			}
			var d struct {
				Payload struct {
					Type string `json:"type"`
					Info *struct {
						Last struct {
							Input int64 `json:"input_tokens"`
						} `json:"last_token_usage"`
						Window int64 `json:"model_context_window"`
					} `json:"info"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &d) != nil || d.Payload.Type != "token_count" || d.Payload.Info == nil || d.Payload.Info.Last.Input <= 0 {
				return false
			}
			used, window = d.Payload.Info.Last.Input, max(d.Payload.Info.Window, 0)
			return true
		}
		return false
	})
	return model, used, window
}
