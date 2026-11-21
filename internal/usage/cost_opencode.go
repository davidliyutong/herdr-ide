package usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path"
	"slices"
	"strings"
)

// OpenCode keeps its sessions in an SQLite database: opencode.db in its
// data directory ($XDG_DATA_HOME/opencode, else ~/.local/share/opencode,
// on macOS too, as OpenCode follows XDG there), opencode-<channel>.db for
// a build of another channel, or $OPENCODE_DB. Each assistant message of
// its table message is one step of a turn and records the model
// (providerID, modelID), the step's tokens (input without the cache reads
// and writes, output without the reasoning, reasoning, cache reads and
// writes), the cost OpenCode computed from its own price list, when it
// started and the directory. OpenCode is a client of many providers and
// has no quota of its own to ask: it has spend and no windows.
//
// The database is read with sqliteFile, the whole table each time the
// database or its WAL changed (a step's tokens are written when it ends,
// into a row already there), its records replacing those of the last read.

// openCodeMaxRecord bounds a message's record: a prompt with what it
// attached can be megabytes and is skipped unread; an answer's is a few
// hundred bytes.
const openCodeMaxRecord = 64 << 10

// openCodeMaxRecords bounds the steps a read keeps (those within the
// cost's retention, 90 days): 300,000 is over 3,000 a day, where the
// database this was written against has 6,393 in nine months. A database
// with more fails the read (too_large) rather than leaving steps out.
var openCodeMaxRecords = 300_000

// openCodeTables are the price tables of the providers whose APIs serve
// models the table prices (Anthropic's, OpenAI's, xAI's, Google's): their
// steps cost what the CLIs' logs would, also signed in with a subscription,
// which OpenCode records as free.
var openCodeTables = map[string]string{"anthropic": Claude, "openai": Codex, "xai": Grok, "google": Antigravity}

var errSQLiteChanged = errors.New("the database changed while it was read")

// openCodeDir is OpenCode's data directory.
func openCodeDir(e *Env) string {
	if d := e.getenv("XDG_DATA_HOME"); d != "" {
		return path.Join(e.expand(d), "opencode")
	}
	return path.Join(e.Home, ".local/share/opencode")
}

// openCodeDBs are OpenCode's databases: $OPENCODE_DB (relative to the
// data directory) when set, else every channel's in the data directory.
func openCodeDBs(e *Env) []string {
	dir := openCodeDir(e)
	if db := e.getenv("OPENCODE_DB"); db != "" {
		if db == ":memory:" {
			return nil
		}
		if !path.IsAbs(db) {
			db = path.Join(dir, db)
		}
		return []string{db}
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, d := range ents {
		n := d.Name()
		if d.Type().IsRegular() && (n == "opencode.db" || strings.HasPrefix(n, "opencode-") && strings.HasSuffix(n, ".db")) {
			out = append(out, path.Join(dir, n))
		}
	}
	slices.Sort(out)
	return out
}

// parseOpenCodeDB reads into ent the steps of OpenCode's database from
// since on: again (at most 3 times) when a writer checkpointed or restarted
// its WAL while it was read. It returns the bytes read.
func parseOpenCodeDB(ctx context.Context, p string, ent *fileEntry, since int64) (int64, error) {
	var read int64
	for attempt := 0; ; attempt++ {
		recs, n, err := readOpenCode(ctx, p, since)
		read += n
		if errors.Is(err, errSQLiteChanged) && attempt < 2 {
			continue
		}
		if err != nil {
			return read, err
		}
		ent.Records = recs
		return read, nil
	}
}

// openCodeMessage is what an assistant message's data says of its step.
type openCodeMessage struct {
	Role       string  `json:"role"`
	ModelID    string  `json:"modelID"`
	ProviderID string  `json:"providerID"`
	Cost       float64 `json:"cost"`
	Time       struct {
		Created float64 `json:"created"`
	} `json:"time"`
	Path struct {
		Cwd string `json:"cwd"`
	} `json:"path"`
	Tokens struct {
		Input     float64 `json:"input"`
		Output    float64 `json:"output"`
		Reasoning float64 `json:"reasoning"`
		Cache     struct {
			Read  float64 `json:"read"`
			Write float64 `json:"write"`
		} `json:"cache"`
	} `json:"tokens"`
}

// readOpenCode reads the steps of the database at p from since on.
func readOpenCode(ctx context.Context, p string, since int64) (recs []Record, read int64, err error) {
	f, err := openSQLite(ctx, p)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	defer func() {
		// The last line of defence: the reader checks what it reads and
		// does not panic (FuzzSQLite), but a file that is not what it
		// should be must fail the read, never the agent or the core.
		if r := recover(); r != nil {
			err = fmt.Errorf("%w: %v", errSQLite, r)
		}
		// Also when the read failed: a checkpoint may have truncated the
		// WAL under it.
		if ctx.Err() == nil && f.changed() {
			err = errSQLiteChanged
		}
		if err != nil {
			recs = nil
		}
		read = f.read
	}()
	recs, err = scanOpenCode(f, since)
	return recs, 0, err
}

// scanOpenCode reads the steps of OpenCode's table message from since on,
// at most openCodeMaxRecords of them.
func scanOpenCode(f *sqliteFile, since int64) ([]Record, error) {
	root, cols, err := f.table("message")
	if err != nil {
		return nil, err
	}
	iID, iTime, iData := slices.Index(cols, "id"), slices.Index(cols, "time_created"), slices.Index(cols, "data")
	if iData < 0 {
		return nil, errSQLite
	}
	col := func(v []any, i int) any {
		if i < 0 || i >= len(v) {
			return nil
		}
		return v[i]
	}
	var recs []Record
	err = f.rows(root, openCodeMaxRecord, func(_ int64, v []any) error {
		data, _ := col(v, iData).(string)
		if !strings.Contains(data, `"assistant"`) {
			return nil
		}
		var m openCodeMessage
		if json.Unmarshal([]byte(data), &m) != nil || m.Role != "assistant" {
			return nil
		}
		ms := m.Time.Created
		if ms <= 0 {
			if t, ok := col(v, iTime).(int64); ok {
				ms = float64(t)
			}
		}
		tok := func(x float64) int64 {
			if x <= 0 || math.IsNaN(x) || x > 1e15 {
				return 0
			}
			return int64(math.Round(x))
		}
		in, out, reason := tok(m.Tokens.Input), tok(m.Tokens.Output), tok(m.Tokens.Reasoning)
		cr, cw := tok(m.Tokens.Cache.Read), tok(m.Tokens.Cache.Write)
		if ms <= 0 || ms > 1e15 || int64(ms/1000) < since || in+out+reason+cr+cw == 0 {
			return nil
		}
		if len(recs) >= openCodeMaxRecords {
			return errSQLiteBudget
		}
		r := Record{
			T: int64(ms / 1000), M: firstNonEmpty(m.ModelID, "unknown"), V: m.ProviderID, J: projectName(m.Path.Cwd),
			I: in, C: cr, W: cw, O: out + reason, R: reason, N: 1,
		}
		if id, _ := col(v, iID).(string); id != "" {
			r.K = "oc:" + id
		}
		if m.Cost > 0 && m.Cost < 1e6 {
			r.P = m.Cost
		}
		recs = append(recs, r)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return recs, nil
}
