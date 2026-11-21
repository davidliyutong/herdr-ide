package usage

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func copyAntigravityFixture(t *testing.T, name, dst string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "antigravity", name))
	if err != nil {
		t.Fatal(err)
	}
	write(t, dst, string(b))
}

func pbVarint(v uint64) []byte {
	var buf [binary.MaxVarintLen64]byte
	return buf[:binary.PutUvarint(buf[:], v)]
}

func pbField(num, wt uint64, val any) []byte {
	out := pbVarint((num << 3) | wt)
	switch wt {
	case 0:
		return append(out, pbVarint(val.(uint64))...)
	case 2:
		b := val.([]byte)
		out = append(out, pbVarint(uint64(len(b)))...)
		return append(out, b...)
	}
	panic("unsupported wire type")
}

func TestAntigravityProto(t *testing.T) {
	// Normal blob with embedded prompt padding before f4/f19/f20, plus packed steps.
	f4 := append(pbField(2, 0, uint64(1000)), pbField(3, 0, uint64(300))...)
	f4 = append(f4, pbField(5, 0, uint64(5000))...)
	f4 = append(f4, pbField(9, 0, uint64(100))...)
	f4 = append(f4, pbField(10, 0, uint64(200))...)
	mapEntry := func(k, v string) []byte {
		return append(pbField(1, 2, []byte(k)), pbField(2, 2, []byte(v))...)
	}
	f1 := pbField(1, 2, []byte(strings.Repeat("P", 2048)))
	f1 = append(f1, pbField(4, 2, f4)...)
	f1 = append(f1, pbField(19, 2, []byte("gemini-3.8-flash"))...)
	f1 = append(f1, pbField(20, 2, mapEntry("request_id", "req-abc"))...)
	f1 = append(f1, pbField(20, 2, mapEntry("cascade_id", "cas-1"))...)
	f1 = append(f1, pbField(20, 2, mapEntry("last_step_index", "42"))...)
	steps := append(pbVarint(7), pbVarint(8)...)
	raw := append(pbField(2, 2, steps), pbField(1, 2, f1)...)

	g, ok := parseAntigravityGen(raw)
	if !ok {
		t.Fatal("expected parsed generation")
	}
	if g.input != 1000 || g.cached != 5000 || g.output != 300 || g.thinking != 100 ||
		g.model != "gemini-3.8-flash" || g.requestID != "req-abc" || g.cascadeID != "cas-1" ||
		!g.hasLastStep || g.lastStep != 42 || !slices.Equal(g.steps, []int64{7, 8}) {
		t.Fatalf("unexpected gen: %+v", g)
	}

	// Reconciles output from thinking + content when field 3 is missing,
	// and accepts unpacked field 2 step indices.
	f4b := append(pbField(2, 0, uint64(50)), pbField(9, 0, uint64(20))...)
	f4b = append(f4b, pbField(10, 0, uint64(80))...)
	raw2 := append(pbField(2, 0, uint64(3)), pbField(1, 2, pbField(4, 2, f4b))...)
	g2, ok := parseAntigravityGen(raw2)
	if !ok || g2.output != 100 || g2.thinking != 20 || !slices.Equal(g2.steps, []int64{3}) {
		t.Fatalf("reconciled gen: %+v ok=%v", g2, ok)
	}

	// Trajectory metadata: file:// URI with escaped spaces, and fallback f1.1.
	traj := append(pbField(2, 2, pbField(1, 0, uint64(1794650400))), pbField(7, 2, []byte("file:///Users/u/my%20proj"))...)
	proj, ts := parseAntigravityTrajectory(traj)
	if proj != "my proj" || ts != 1794650400 {
		t.Errorf("traj: proj=%q ts=%d", proj, ts)
	}
	trajFallback := pbField(1, 2, pbField(1, 2, []byte("file:///work/alpha/")))
	if p, _ := parseAntigravityTrajectory(trajFallback); p != "alpha" {
		t.Errorf("traj fallback: %q", p)
	}

	// Step metadata: prefers field 1, falls back to field 6.
	meta1 := append(pbField(6, 2, pbField(1, 0, uint64(1794650500))), pbField(1, 2, pbField(1, 0, uint64(1794650400)))...)
	if got := parseAntigravityStepMetaTS(meta1); got != 1794650400 {
		t.Errorf("step ts: %d", got)
	}
	meta6 := pbField(6, 2, pbField(1, 0, uint64(1794650500)))
	if got := parseAntigravityStepMetaTS(meta6); got != 1794650500 {
		t.Errorf("step ts fallback: %d", got)
	}

	// Malformed / truncated / overflow protobufs never panic.
	for _, bad := range [][]byte{
		nil,
		{0x00},
		{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
		{0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 'x'},
		{0x0b}, // wire type 3 (unsupported)
		{0x09, 1, 2},
		{0x0d, 1, 2},
	} {
		parseAntigravityGen(bad)
		parseAntigravityTrajectory(bad)
		parseAntigravityStepMetaTS(bad)
	}
}

func TestAntigravityCost(t *testing.T) {
	e := testEnv(t, nil)
	// Same conversation placed in both antigravity and antigravity-ide:
	// request_id deduplication ensures nothing is double-counted.
	copyAntigravityFixture(t, "conv.db", filepath.Join(e.Home, ".gemini/antigravity/conversations/conv-uuid-1.db"))
	copyAntigravityFixture(t, "conv.db", filepath.Join(e.Home, ".gemini/antigravity-ide/conversations/conv-uuid-1.db"))
	// A second conversation in antigravity-cli with uncommitted WAL frames.
	copyAntigravityFixture(t, "wal.db", filepath.Join(e.Home, ".gemini/antigravity-cli/conversations/wal-uuid.db"))
	copyAntigravityFixture(t, "wal.db-wal", filepath.Join(e.Home, ".gemini/antigravity-cli/conversations/wal-uuid.db-wal"))

	since := testNow.Add(-30 * 24 * time.Hour).Unix()
	rep, err := Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Antigravity}})
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Failed) != 0 {
		t.Fatalf("unexpected failures: %v", rep.Failed)
	}
	rows := rowsBy(rep)

	// Day 1: gemini-4-neon (in 3, cached 0.15, out 15).
	neon := rows["antigravity|gemini-4-neon|my app"]
	wantNeon := (10000*3.0 + 50000*0.15 + 1000*15.0) / 1e6
	if neon.Day != "2026-11-14" || neon.Requests != 1 || neon.Input != 10000 || neon.Cached != 50000 ||
		neon.Output != 1000 || neon.Reasoning != 400 || !neon.Priced || !near(neon.Cost, wantNeon) {
		t.Errorf("neon: %+v want cost %g", neon, wantNeon)
	}

	// Day 1: gemini-3.1-pro-preview with 250k total prompt -> >200k long tier (in 4, cached 0.4, out 18).
	pro := rows["antigravity|gemini-3.1-pro|my app"]
	wantPro := (50000*4.0 + 200000*0.4 + 500*18.0) / 1e6
	if pro.Day != "2026-11-14" || pro.Requests != 1 || !pro.Priced || !near(pro.Cost, wantPro) {
		t.Errorf("pro: %+v want cost %g", pro, wantPro)
	}

	// Day 2: claude-opus-4-6-thinking priced via Claude table (in 5, cached 0.5, out 25).
	cl := rows["antigravity|claude-opus-4-6|my app"]
	wantCl := (2000*5.0 + 10000*0.5 + 300*25.0) / 1e6
	if cl.Day != "2026-11-15" || cl.Requests != 1 || cl.Reasoning != 50 || !cl.Priced || !near(cl.Cost, wantCl) {
		t.Errorf("claude: %+v want cost %g", cl, wantCl)
	}

	// Day 2: gemini-3.8-flash-n (output reconciled 120+180=300; in 0.75, cached 0.075, out 3.75).
	fl := rows["antigravity|gemini-3.8-flash|my app"]
	wantFl := (4000*0.75 + 8000*0.075 + 300*3.75) / 1e6
	if fl.Day != "2026-11-15" || fl.Requests != 1 || fl.Output != 300 || fl.Reasoning != 120 || !fl.Priced || !near(fl.Cost, wantFl) {
		t.Errorf("flash: %+v want cost %g", fl, wantFl)
	}

	// Day 2: large last-turn row with overflow pages (gemini-4-hydrogen: in 1.5, cached 0.075, out 7.5).
	hyd := rows["antigravity|gemini-4-hydrogen|my app"]
	wantHyd := (3000*1.5 + 20000*0.075 + 200*7.5) / 1e6
	if hyd.Day != "2026-11-15" || hyd.Requests != 1 || hyd.Reasoning != 80 || !hyd.Priced || !near(hyd.Cost, wantHyd) {
		t.Errorf("hydrogen: %+v want cost %g", hyd, wantHyd)
	}

	// Day 2: unpriced model (tokens counted, cost 0, reported in Unpriced).
	unp := rows["antigravity|gpt-oss-120b|my app"]
	if unp.Requests != 1 || unp.Input != 1000 || unp.Cached != 2000 || unp.Output != 100 || unp.Priced || unp.Cost != 0 ||
		!slices.Equal(rep.Unpriced, []string{"antigravity/gpt-oss-120b"}) {
		t.Errorf("unpriced: %+v list=%v", unp, rep.Unpriced)
	}

	// WAL conversation: both checkpointed row (0) and WAL-only row (1), not the corrupt trailing frame.
	walRow := rows["antigravity|gemini-4-neon|wal-proj"]
	wantWal := ((1000+2000)*3.0 + 5000*0.15 + (100+400)*15.0) / 1e6
	if walRow.Requests != 2 || walRow.Input != 3000 || walRow.Cached != 5000 || walRow.Output != 500 || !near(walRow.Cost, wantWal) {
		t.Errorf("wal: %+v want cost %g", walRow, wantWal)
	}

	// User custom price prices gpt-oss-120b and clears Unpriced.
	rep2, err := Cost(context.Background(), e, CostOptions{
		Since:     since,
		Providers: []string{Antigravity},
		Prices:    map[string]Tier{"gpt-oss-120b": {Input: 0.5, Cached: 0.125, Output: 1.5}},
	})
	if err != nil {
		t.Fatal(err)
	}
	unp2 := rowsBy(rep2)["antigravity|gpt-oss-120b|my app"]
	wantUnp2 := (1000*0.5 + 2000*0.125 + 100*1.5) / 1e6
	if !unp2.Priced || !near(unp2.Cost, wantUnp2) || len(rep2.Unpriced) != 0 {
		t.Errorf("custom price: %+v unpriced=%v", unp2, rep2.Unpriced)
	}

	// Asking only Claude returns no Antigravity rows and keeps its cache entries.
	repCl, err := Cost(context.Background(), e, CostOptions{Since: since, Providers: []string{Claude}})
	if err != nil || len(repCl.Rows) != 0 {
		t.Errorf("claude-only: %+v %v", repCl, err)
	}
	if c := loadCostCache(filepath.Join(e.Base, CostCacheFile)); len(c.Files) != 3 {
		t.Errorf("cache files: %d", len(c.Files))
	}
}

func TestAntigravityReadAgainAndErrors(t *testing.T) {
	e := testEnv(t, nil)
	db := filepath.Join(e.Home, ".gemini/antigravity/conversations/w.db")
	copyAntigravityFixture(t, "wal.db", db)
	o := CostOptions{Since: testNow.Add(-30 * 24 * time.Hour).Unix(), Providers: []string{Antigravity}}

	// Without WAL: 1 generation.
	first, err := Cost(context.Background(), e, o)
	if err != nil || len(first.Rows) != 1 || first.Rows[0].Requests != 1 {
		t.Fatalf("without wal: %+v %v", first, err)
	}

	// Unchanged (size and mtime): served from cache without reading the file.
	st, _ := os.Stat(db)
	os.WriteFile(db, make([]byte, st.Size()), 0o600)
	os.Chtimes(db, st.ModTime(), st.ModTime())
	if rep, _ := Cost(context.Background(), e, o); len(rep.Rows) != 1 || rep.Rows[0].Requests != 1 {
		t.Errorf("cache bypassed: %+v", rep.Rows)
	}

	// Add WAL commit: combined stamp changes, re-read sees both generations.
	copyAntigravityFixture(t, "wal.db", db)
	copyAntigravityFixture(t, "wal.db-wal", db+"-wal")
	rep, err := Cost(context.Background(), e, o)
	if err != nil || len(rep.Rows) != 1 || rep.Rows[0].Requests != 2 {
		t.Errorf("after wal: %+v %v", rep, err)
	}

	// Damaged database is reported in Failed as antigravity:damaged.
	bad := filepath.Join(e.Home, ".gemini/antigravity/conversations/bad.db")
	write(t, bad, strings.Repeat("not-sqlite", 20))
	rep, err = Cost(context.Background(), e, o)
	if err != nil || !slices.Equal(rep.Failed, []string{"antigravity:damaged"}) {
		t.Errorf("damaged: failed=%v err=%v", rep.Failed, err)
	}

	// Valid SQLite database without gen_metadata table: 0 records, no failure.
	os.Remove(bad)
	empty := filepath.Join(e.Home, ".gemini/antigravity/conversations/empty.db")
	os.WriteFile(empty, tinyDB(answers(1)), 0o600)
	rep, err = Cost(context.Background(), e, o)
	if err != nil || len(rep.Failed) != 0 {
		t.Errorf("no gen_metadata: failed=%v err=%v", rep.Failed, err)
	}
}

// A crafted tiny database claiming a 64 MiB record size fails payload()
// before allocating memory.
func TestSQLitePayloadRefusesOversizedClaim(t *testing.T) {
	p1 := make([]byte, tinyPage)
	copy(p1, "SQLite format 3\x00")
	binary.BigEndian.PutUint16(p1[16:], tinyPage)
	p1[18], p1[19], p1[21], p1[22], p1[23] = 1, 1, 64, 32, 32
	binary.BigEndian.PutUint32(p1[28:], 2)
	binary.BigEndian.PutUint32(p1[56:], 1)
	schema := record("table", "gen_metadata", "gen_metadata", int64(2), "CREATE TABLE gen_metadata (idx integer, data blob)")
	leaf(p1, 100, [][]byte{leafCell(1, schema)}, nil)

	// Leaf page 2 with a cell claiming 60 MiB payload size.
	claim := uint64(60 << 20)
	sf := &sqliteFile{usable: tinyPage}
	local := sf.localSize(int(claim))
	cell := append(putVarint(putVarint(nil, claim), 1), make([]byte, local)...)
	cell = binary.BigEndian.AppendUint32(cell, 3)
	p2 := make([]byte, tinyPage)
	leaf(p2, 0, [][]byte{cell}, nil)

	f, err := sqliteBytes(context.Background(), append(p1, p2...), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := scanAntigravity(f, "c", 0, 1794650400); !errors.Is(err, errSQLite) {
		t.Errorf("oversized claim: %v", err)
	}
}

// scanAntigravity reads only the steps rowids referenced by non-empty
// generations (skipping unreferenced rows before following overflow pages)
// and exits early without reading steps when gen_metadata has no usage.
func TestAntigravitySkipsUnreferencedSteps(t *testing.T) {
	blobRecord := func(vals ...any) []byte {
		var head, body []byte
		for _, v := range vals {
			switch x := v.(type) {
			case string:
				head = putVarint(head, uint64(13+2*len(x)))
				body = append(body, x...)
			case []byte:
				head = putVarint(head, uint64(12+2*len(x)))
				body = append(body, x...)
			case int64:
				head = putVarint(head, 6)
				body = binary.BigEndian.AppendUint64(body, uint64(x))
			}
		}
		return append(append(putVarint(nil, uint64(len(head)+1)), head...), body...)
	}

	buildDB := func(genCell []byte) []byte {
		p1 := make([]byte, tinyPage)
		copy(p1, "SQLite format 3\x00")
		binary.BigEndian.PutUint16(p1[16:], tinyPage)
		p1[18], p1[19], p1[21], p1[22], p1[23] = 1, 1, 64, 32, 32
		binary.BigEndian.PutUint32(p1[28:], 3)
		binary.BigEndian.PutUint32(p1[56:], 1)
		sGen := record("table", "gen_metadata", "gen_metadata", int64(2), "CREATE TABLE gen_metadata (idx integer, data blob)")
		sSteps := record("table", "steps", "steps", int64(3), "CREATE TABLE steps (idx integer, metadata blob)")
		leaf(p1, 100, [][]byte{leafCell(1, sGen), leafCell(2, sSteps)}, nil)

		p2 := make([]byte, tinyPage)
		leaf(p2, 0, [][]byte{genCell}, nil)

		// Page 3 (steps): rowid 1 is referenced and valid; rowid 2 is
		// unreferenced and claims an overflow page (999) past EOF.
		// If rowsWhere followed rowid 2's payload, the read would fail.
		step1 := blobRecord(int64(1), pbField(1, 2, pbField(1, 0, uint64(1794650500))))
		sf := &sqliteFile{usable: tinyPage}
		bigSize := tinyPage * 2
		local := sf.localSize(bigSize)
		step2Cell := append(putVarint(putVarint(nil, uint64(bigSize)), 2), make([]byte, local)...)
		step2Cell = binary.BigEndian.AppendUint32(step2Cell, 999)
		p3 := make([]byte, tinyPage)
		leaf(p3, 0, [][]byte{leafCell(1, step1), step2Cell}, nil)

		return append(append(p1, p2...), p3...)
	}

	// Generation referencing only step 1 succeeds without reading step 2's
	// broken overflow chain.
	f4 := append(pbField(2, 0, uint64(100)), pbField(3, 0, uint64(50))...)
	f1 := append(pbField(4, 2, f4), pbField(19, 2, []byte("gemini-4-neon"))...)
	genBlob := append(pbField(2, 2, pbVarint(1)), pbField(1, 2, f1)...)
	f, err := sqliteBytes(context.Background(), buildDB(leafCell(1, blobRecord(int64(1), genBlob))), nil)
	if err != nil {
		t.Fatal(err)
	}
	recs, err := scanAntigravity(f, "conv", 0, 1794650400)
	if err != nil {
		t.Fatalf("unexpected error reading referenced step: %v", err)
	}
	if len(recs) != 1 || recs[0].T != 1794650500 || recs[0].I != 100 || recs[0].O != 50 {
		t.Fatalf("recs: %+v", recs)
	}

	// Zero-token gen_metadata returns early without reading steps at all.
	emptyGen := pbField(1, 2, pbField(19, 2, []byte("gemini-4-neon")))
	dbEmpty := buildDB(leafCell(1, blobRecord(int64(1), emptyGen)))
	// Corrupt steps page header (page 3) to prove it is never read.
	dbEmpty[2*tinyPage] = 0xff
	f2, err := sqliteBytes(context.Background(), dbEmpty, nil)
	if err != nil {
		t.Fatal(err)
	}
	recs2, err := scanAntigravity(f2, "conv", 0, 1794650400)
	if err != nil || len(recs2) != 0 {
		t.Fatalf("empty gen read steps: recs=%+v err=%v", recs2, err)
	}
}

func FuzzAntigravityProto(f *testing.F) {
	f.Add(pbField(1, 2, append(pbField(4, 2, pbField(2, 0, uint64(10))), pbField(19, 2, []byte("gemini-4-neon"))...)))
	f.Add([]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff})
	f.Fuzz(func(t *testing.T, b []byte) {
		parseAntigravityGen(b)
		parseAntigravityTrajectory(b)
		parseAntigravityStepMetaTS(b)
	})
}
