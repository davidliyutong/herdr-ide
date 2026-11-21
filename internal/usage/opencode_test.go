package usage

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// The databases of testdata/opencode (make.sh) are copied where a test
// reads them, so that nothing is ever opened beside the fixtures.
func copyFixture(t *testing.T, name, dst string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "opencode", name))
	if err != nil {
		t.Fatal(err)
	}
	write(t, dst, string(b))
}

// messageRows reads the table message of the database at p.
func messageRows(t *testing.T, p string, max int64) map[string][]any {
	t.Helper()
	f, err := openSQLite(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	root, cols, err := f.table("message")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cols[:5], []string{"id", "session_id", "time_created", "time_updated", "data"}) {
		t.Fatalf("columns %v", cols)
	}
	out := map[string][]any{}
	err = f.rows(root, max, func(_ int64, v []any) error {
		out[v[0].(string)] = v
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSQLiteTables(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "opencode.db")
	copyFixture(t, "opencode.db", db)
	f, err := openSQLite(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	_, cols, err := f.table("message")
	// A column a later migration added comes last.
	if err != nil || !slices.Equal(cols, []string{"id", "session_id", "time_created", "time_updated", "data", "extra"}) {
		t.Errorf("columns %v %v", cols, err)
	}
	if _, _, err := f.table("nothing"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a table that is not there: %v", err)
	}
	f.Close()
	// Every row, through interior pages and chains of overflow pages: 37
	// answers, 13 prompts, one answer without tokens, one with a long error.
	rows := messageRows(t, db, 1<<20)
	if len(rows) != 52 {
		t.Fatalf("%d rows", len(rows))
	}
	var e struct {
		Error struct{ Message string } `json:"error"`
	}
	if json.Unmarshal([]byte(rows["msg_e"][4].(string)), &e) != nil || len(e.Error.Message) != 3000 {
		t.Errorf("the long error: %d bytes", len(e.Error.Message))
	}
	if rows["msg_a1"][2].(int64) != (1794646800+3600)*1000 || len(rows["msg_a1"]) != 5 || len(rows["msg_a37"]) != 6 || rows["msg_a37"][5] != nil {
		t.Errorf("values %v %v", rows["msg_a1"][:4], rows["msg_a37"][:4])
	}
	// Records over the bound are skipped unread: the prompts and the error.
	small := messageRows(t, db, 600)
	if _, ok := small["msg_e"]; ok || len(small) != 52-13 {
		t.Errorf("%d small rows", len(small))
	}
}

func TestSQLiteColumns(t *testing.T) {
	got := sqliteColumns("CREATE TABLE x (\"a b\" text NOT NULL, [c] int DEFAULT (1+2), d CHECK (d > 0), `e,f` text, g,\n" +
		"PRIMARY KEY (a, c), CONSTRAINT k UNIQUE (d), FOREIGN KEY (g) REFERENCES y(id), CHECK (g <> ''))")
	if !slices.Equal(got, []string{"a b", "c", "d", "e,f", "g"}) {
		t.Errorf("columns %q", got)
	}
}

func TestSQLiteWAL(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "wal.db")
	copyFixture(t, "wal.db", db)
	// The database alone: what was checkpointed.
	rows := messageRows(t, db, 1<<20)
	output := func(rows map[string][]any, id string) float64 {
		var m openCodeMessage
		json.Unmarshal([]byte(rows[id][4].(string)), &m)
		return m.Tokens.Output
	}
	if len(rows) != 2 || output(rows, "msg_w2") != 20 {
		t.Errorf("database alone: %d rows, output %v", len(rows), output(rows, "msg_w2"))
	}
	// An empty WAL holds nothing.
	write(t, db+"-wal", "")
	if rows := messageRows(t, db, 1<<20); len(rows) != 2 {
		t.Errorf("empty WAL: %d rows", len(rows))
	}
	// With its WAL: the last commit's pages (a row added, another's tokens
	// written), not the frame of another generation after it.
	copyFixture(t, "wal.db-wal", db+"-wal")
	rows = messageRows(t, db, 1<<20)
	if len(rows) != 3 || output(rows, "msg_w2") != 500 || rows["msg_w3"] == nil {
		t.Errorf("with the WAL: %d rows, output %v", len(rows), output(rows, "msg_w2"))
	}

	// A writer meanwhile: a checkpoint (the database written) or a WAL
	// started over (its header) shows; frames added to the WAL do not.
	f, err := openSQLite(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	wal, _ := os.OpenFile(db+"-wal", os.O_WRONLY|os.O_APPEND, 0)
	wal.Write(make([]byte, 536))
	wal.Close()
	if f.changed() {
		t.Error("frames appended count as a change")
	}
	later := time.Now().Add(time.Minute)
	os.Chtimes(db, later, later)
	if !f.changed() {
		t.Error("a checkpoint not seen")
	}
	f.Close()
	f, _ = openSQLite(context.Background(), db)
	b, _ := os.ReadFile(db + "-wal")
	b[16] ^= 0xff
	os.WriteFile(db+"-wal", b, 0o600)
	if !f.changed() {
		t.Error("a WAL started over not seen")
	}
	f.Close()
}

// Damaged databases fail the read; nothing panics or loops.
func TestSQLiteDamaged(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "opencode", "opencode.db"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	db := filepath.Join(dir, "bad.db")
	try := func(b []byte) {
		os.WriteFile(db, b, 0o600)
		done := make(chan struct{})
		go func() {
			defer close(done)
			readOpenCode(context.Background(), db, 0)
		}()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("the read does not end")
		}
	}
	for _, b := range [][]byte{nil, []byte("not a database"), src[:100], src[:len(src)/2]} {
		try(b)
		if _, _, err := readOpenCode(context.Background(), db, 0); err == nil && len(b) < len(src)/2 {
			t.Errorf("%d bytes read as a database", len(b))
		}
	}
	for off := 100; off < len(src); off += 509 {
		b := slices.Clone(src)
		for i := off; i < min(off+24, len(b)); i++ {
			b[i] ^= 0x5a
		}
		try(b)
	}
}

func openCodeHome(t *testing.T) *Env {
	e := testEnv(t, nil)
	copyFixture(t, "opencode.db", filepath.Join(e.Home, ".local/share/opencode/opencode.db"))
	return e
}

func TestOpenCodeCost(t *testing.T) {
	e := openCodeHome(t)
	since := testNow.Add(-30 * 24 * time.Hour).Unix()
	rep, err := Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{OpenCode}})
	if err != nil {
		t.Fatal(err)
	}
	rows := rowsBy(rep)
	// Anthropic's API at the table's price (OpenCode recorded it free),
	// by the directory's name; the output with its reasoning.
	label, mp := Pricing.ModelPricing(Claude, "claude-opus-4-5-20251101")
	_, tier := mp.Tier(1110)
	step := tier.Cost(100, 1000, 10, 0, 25)
	for _, proj := range []string{"proj-a", "proj-b"} {
		c := rows["opencode|"+label+"|"+proj]
		if c.Requests != 6 || c.Output != 25*6 || !c.Priced || !near(c.Cost, 6*step) {
			t.Errorf("claude in %s: %+v", proj, c)
		}
	}
	// Each step's tokens: input 100, cache reads 1000 and writes 10, output
	// 20 and reasoning 5 (the answer with an error: input 7, output 3).
	var in, cached, written, out, reasoning, steps int64
	for _, r := range rep.Rows {
		in, cached, written, out, reasoning, steps = in+r.Input, cached+r.Cached, written+r.CacheWrite, out+r.Output, reasoning+r.Reasoning, steps+r.Requests
	}
	if steps != 38 || in != 37*100+7 || cached != 37*1000 || written != 37*10 || out != 37*25+3 || reasoning != 37*5 {
		t.Errorf("tokens: %d steps, %d %d %d %d %d", steps, in, cached, written, out, reasoning)
	}
	// Others at the cost OpenCode recorded (the answer with an error too).
	d := rows["opencode|deepseek-v4-flash|proj-a"]
	db := rows["opencode|deepseek-v4-flash|proj-b"]
	if d.Requests+db.Requests != 14 || !d.Priced || !near(d.Cost+db.Cost, 13*0.001+0.5) {
		t.Errorf("deepseek %+v %+v", d, db)
	}
	// Recorded free and not in the table: its tokens without a price.
	g := rows["opencode|glm-5|proj-a"]
	if g.Requests == 0 || g.Priced || g.Cost != 0 || !slices.Equal(rep.Unpriced, []string{"opencode/glm-5"}) {
		t.Errorf("glm %+v unpriced %v", g, rep.Unpriced)
	}
	total := int64(0)
	for _, r := range rep.Rows {
		total += r.Requests
		if r.Provider != OpenCode {
			t.Errorf("row %+v", r)
		}
	}
	// Neither the prompts, the one naming an assistant, nor the answer
	// without tokens.
	if total != 12+14+12 || rep.Files != 1 {
		t.Errorf("%d steps, %d files", total, rep.Files)
	}
	// The user's price for it.
	rep, _ = Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{OpenCode},
		Prices: map[string]Tier{"glm-5": {Input: 1, Cached: 0.1, Output: 2}}})
	g = rowsBy(rep)["opencode|glm-5|proj-a"]
	if !g.Priced || !near(g.Cost, float64(g.Requests)*(100*1+1000*0.1+10*1+25*2)/1e6) || len(rep.Unpriced) != 0 {
		t.Errorf("own price %+v", g)
	}
	// A cost not asked for OpenCode keeps its records.
	if rep, _ := Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Claude}}); len(rep.Rows) != 0 {
		t.Errorf("rows %+v", rep.Rows)
	}
	if c := loadCostCache(filepath.Join(e.Base, CostCacheFile)); len(c.Files) != 1 {
		t.Errorf("cache %+v", c.Files)
	}
}

func TestOpenCodeReadAgain(t *testing.T) {
	e := openCodeHome(t)
	db := filepath.Join(e.Home, ".local/share/opencode/opencode.db")
	o := CostOptions{Since: testNow.Add(-30 * 24 * time.Hour).Unix()}
	first, err := Cost(context.Background(), e, o)
	if err != nil || len(first.Rows) == 0 {
		t.Fatal(err)
	}
	// Unchanged (its size and time, and its WAL's): not read again.
	st, _ := os.Stat(db)
	os.WriteFile(db, make([]byte, st.Size()), 0o600)
	os.Chtimes(db, st.ModTime(), st.ModTime())
	if rep, _ := Cost(context.Background(), e, o); len(rep.Rows) != len(first.Rows) {
		t.Errorf("read again: %d rows", len(rep.Rows))
	}
	// A commit in its WAL: read again, whole.
	copyFixture(t, "wal.db", db)
	copyFixture(t, "wal.db-wal", db+"-wal")
	rep, _ := Cost(context.Background(), e, o)
	rows := rowsBy(rep)
	if len(rep.Rows) != 2 || rows["opencode|deepseek-v4-flash|proj-a"].Output != 25+505 || rows["opencode|kimi-k2.5|proj-c"].Cost != 0.002 {
		t.Errorf("after the WAL: %+v", rep.Rows)
	}
}

func TestOpenCodeDatabases(t *testing.T) {
	e := testEnv(t, nil)
	env := map[string]string{}
	e.Getenv = func(k string) string { return env[k] }
	data := filepath.Join(e.Home, "data")
	env["XDG_DATA_HOME"] = data
	for _, n := range []string{"opencode.db", "opencode-dev.db", "opencode.db-wal", "other.db"} {
		write(t, filepath.Join(data, "opencode", n), "")
	}
	got := openCodeDBs(e)
	if !slices.Equal(got, []string{filepath.Join(data, "opencode/opencode-dev.db"), filepath.Join(data, "opencode/opencode.db")}) {
		t.Errorf("databases %v", got)
	}
	env["OPENCODE_DB"] = "mine.db"
	if got := openCodeDBs(e); !slices.Equal(got, []string{filepath.Join(data, "opencode/mine.db")}) {
		t.Errorf("OPENCODE_DB %v", got)
	}
	env["OPENCODE_DB"] = ":memory:"
	if got := openCodeDBs(e); got != nil {
		t.Errorf(":memory: %v", got)
	}
	delete(env, "XDG_DATA_HOME")
	delete(env, "OPENCODE_DB")
	if got := openCodeDir(e); got != filepath.Join(e.Home, ".local/share/opencode") {
		t.Errorf("dir %s", got)
	}
	// No quota of its own: no account, nothing asked.
	if accs := Limits(context.Background(), e, Options{Providers: []string{OpenCode}}); len(accs) != 0 {
		t.Errorf("accounts %+v", accs)
	}
}
