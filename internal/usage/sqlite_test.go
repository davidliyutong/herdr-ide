package usage

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Databases made by hand, for what the sqlite3 shell does not write: a
// file of 512-byte pages, page 1 the schema with the table message (id,
// data) whose root is page 2, then the pages given.

const tinyPage = 512

func putVarint(b []byte, v uint64) []byte {
	if v < 0x80 {
		return append(b, byte(v))
	}
	var tmp []byte
	for v > 0 {
		tmp = append([]byte{byte(v&0x7f) | 0x80}, tmp...)
		v >>= 7
	}
	tmp[len(tmp)-1] &= 0x7f
	return append(b, tmp...)
}

// record encodes values (string or int64) as a record.
func record(vals ...any) []byte {
	var head, body []byte
	for _, v := range vals {
		switch x := v.(type) {
		case string:
			head = putVarint(head, uint64(13+2*len(x)))
			body = append(body, x...)
		case int64:
			head = putVarint(head, 6)
			body = binary.BigEndian.AppendUint64(body, uint64(x))
		}
	}
	return append(append(putVarint(nil, uint64(len(head)+1)), head...), body...)
}

// leafCell is a table leaf's cell of a record that fits on its page.
func leafCell(rowid uint64, rec []byte) []byte {
	return append(putVarint(putVarint(nil, uint64(len(rec))), rowid), rec...)
}

// leaf writes a table leaf at h of pg: the cells from the page's end
// down, and ptrs as the cell pointers (nil: one per cell).
func leaf(pg []byte, h int, cells [][]byte, ptrs []int) {
	end := len(pg)
	var at []int
	for _, c := range cells {
		end -= len(c)
		copy(pg[end:], c)
		at = append(at, end)
	}
	if ptrs == nil {
		ptrs = at
	}
	pg[h] = 0x0d
	binary.BigEndian.PutUint16(pg[h+3:], uint16(len(ptrs)))
	binary.BigEndian.PutUint16(pg[h+5:], uint16(end))
	for i, p := range ptrs {
		binary.BigEndian.PutUint16(pg[h+8+2*i:], uint16(p))
	}
}

func tinyDB(pages ...[]byte) []byte {
	p1 := make([]byte, tinyPage)
	copy(p1, "SQLite format 3\x00")
	binary.BigEndian.PutUint16(p1[16:], tinyPage)
	p1[18], p1[19], p1[21], p1[22], p1[23] = 1, 1, 64, 32, 32
	binary.BigEndian.PutUint32(p1[28:], uint32(1+len(pages)))
	binary.BigEndian.PutUint32(p1[56:], 1)
	schema := record("table", "message", "message", int64(2), "CREATE TABLE message (id text, data text)")
	leaf(p1, 100, [][]byte{leafCell(1, schema)}, nil)
	out := p1
	for _, p := range pages {
		out = append(out, p...)
	}
	return out
}

// tinyAnswer is short enough for five on a page.
const tinyAnswer = `{"role":"assistant","time":{"created":1794830400000},"tokens":{"input":1}}`

// answers is a leaf page of n answers.
func answers(n int) []byte {
	pg := make([]byte, tinyPage)
	var cells [][]byte
	for i := range n {
		cells = append(cells, leafCell(uint64(i+1), record("msg_"+string(rune('a'+i)), tinyAnswer)))
	}
	leaf(pg, 0, cells, nil)
	return pg
}

// tinyTree is a table of two levels: an interior root (page 2) over two
// leaves (3 and 4), the second with a record that overflows into page 5.
func tinyTree() []byte {
	in := make([]byte, tinyPage)
	in[0] = 0x05
	binary.BigEndian.PutUint16(in[3:], 1)
	binary.BigEndian.PutUint32(in[8:], 4)
	binary.BigEndian.PutUint16(in[12:], tinyPage-5)
	binary.BigEndian.PutUint32(in[tinyPage-5:], 3)
	in[tinyPage-1] = 3
	rec := record("msg_z", `{"pad":"`+strings.Repeat("x", 700)+`",`+tinyAnswer[1:])
	f := &sqliteFile{usable: tinyPage}
	local := f.localSize(len(rec))
	cell := append(putVarint(putVarint(nil, uint64(len(rec))), 9), rec[:local]...)
	cell = binary.BigEndian.AppendUint32(cell, 5)
	big := make([]byte, tinyPage)
	leaf(big, 0, [][]byte{cell}, nil)
	over := make([]byte, tinyPage)
	copy(over[4:], rec[local:])
	return tinyDB(in, answers(3), big, over)
}

// scanFile reads the steps of the database b (and its WAL) with the
// reader alone: a panic fails the test, as the recover of readOpenCode is
// not there.
func scanFile(t testing.TB, ctx context.Context, b, wal []byte) (recs []Record, f *sqliteFile, err error) {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "opencode.db")
	os.WriteFile(p, b, 0o600)
	if wal != nil {
		os.WriteFile(p+"-wal", wal, 0o600)
	}
	f, err = openSQLite(ctx, p)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	recs, err = scanOpenCode(f, 0)
	return recs, f, err
}

func TestSQLiteTiny(t *testing.T) {
	recs, _, err := scanFile(t, context.Background(), tinyDB(answers(3)), nil)
	if err != nil || len(recs) != 3 || recs[0].K != "oc:msg_a" || recs[0].T != 1794830400 {
		t.Fatalf("%v %+v", err, recs)
	}
	// Two levels and an overflow chain: the leaves in order, the long
	// record whole.
	recs, f, err := scanFile(t, context.Background(), tinyTree(), nil)
	if err != nil || len(recs) != 4 || recs[3].K != "oc:msg_z" || f.read != 5*tinyPage {
		t.Fatalf("%v %+v", err, recs)
	}
}

// A length too large to add to an offset (a serial type of nine 0xff
// bytes, about 2^63) is refused, not wrapped past the check.
func TestSQLiteRecordLengths(t *testing.T) {
	huge := append([]byte{10}, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)
	for _, b := range [][]byte{
		huge,
		append(huge, "some text"...),
		{2, 13 + 2*5, 'a', 'b'}, // text of 5 bytes, 2 there
		{2, 0x81, 0x00},         // header longer than the record
		{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, // header length about 2^64
		{2, 10}, // a reserved serial type
	} {
		if _, err := sqliteRecord(b); !errors.Is(err, errSQLite) {
			t.Errorf("%x: %v", b, err)
		}
	}
	if v, err := sqliteRecord([]byte{3, 13 + 2*2, 1, 'h', 'i', 7}); err != nil || v[0] != "hi" || v[1] != int64(7) {
		t.Errorf("%v %v", v, err)
	}
	// In a file: the read fails, nothing panics.
	pg := make([]byte, tinyPage)
	leaf(pg, 0, [][]byte{leafCell(1, append(huge, `"assistant"`...))}, nil)
	if _, _, err := scanFile(t, context.Background(), tinyDB(pg), nil); !errors.Is(err, errSQLite) {
		t.Errorf("huge length in a file: %v", err)
	}
}

// Cells may not overlap: pointers that repeat one cell (a page read as
// thousands of rows) or point into another fail the read.
func TestSQLiteOverlappingCells(t *testing.T) {
	cell := leafCell(1, record("msg_a", tinyAnswer))
	at := tinyPage - len(cell)
	// As many pointers as fit before the cell, all to it.
	same := make([]int, (at-8)/2)
	for i := range same {
		same[i] = at
	}
	inside := []int{at, at + 3}
	for name, ptrs := range map[string][]int{"repeated": same, "inside another": inside} {
		pg := make([]byte, tinyPage)
		leaf(pg, 0, [][]byte{cell}, ptrs)
		if recs, _, err := scanFile(t, context.Background(), tinyDB(pg), nil); !errors.Is(err, errSQLite) || recs != nil {
			t.Errorf("%s: %d records, %v", name, len(recs), err)
		}
	}
	// A pointer into the pointer array, one past the page.
	for _, p := range []int{8, tinyPage} {
		pg := make([]byte, tinyPage)
		leaf(pg, 0, [][]byte{cell}, []int{p})
		if _, _, err := scanFile(t, context.Background(), tinyDB(pg), nil); !errors.Is(err, errSQLite) {
			t.Errorf("pointer %d: %v", p, err)
		}
	}
}

// A page is read once in a walk, overflow pages too: a chain that comes
// back, or a child named twice, fails.
func TestSQLitePagesOnce(t *testing.T) {
	// A record of 1,200 bytes overflows a 512-byte page into two pages; its
	// chain is page 3, which names itself next.
	rec := record("msg_a", tinyAnswer+string(make([]byte, 1100)))
	f := &sqliteFile{usable: tinyPage}
	local := f.localSize(len(rec))
	cell := append(putVarint(putVarint(nil, uint64(len(rec))), 1), rec[:local]...)
	cell = binary.BigEndian.AppendUint32(cell, 3)
	pg := make([]byte, tinyPage)
	leaf(pg, 0, [][]byte{cell}, nil)
	over := make([]byte, tinyPage)
	binary.BigEndian.PutUint32(over, 3)
	if _, _, err := scanFile(t, context.Background(), tinyDB(pg, over), nil); !errors.Is(err, errSQLite) {
		t.Errorf("an overflow chain that comes back: %v", err)
	}
	// An interior page naming its leaf twice.
	in := make([]byte, tinyPage)
	in[0] = 0x05
	binary.BigEndian.PutUint16(in[3:], 1)
	binary.BigEndian.PutUint32(in[8:], 3)
	binary.BigEndian.PutUint16(in[12:], tinyPage-5)
	binary.BigEndian.PutUint32(in[tinyPage-5:], 3)
	in[tinyPage-1] = 1
	if _, _, err := scanFile(t, context.Background(), tinyDB(in, answers(1)), nil); !errors.Is(err, errSQLite) {
		t.Errorf("a child twice: %v", err)
	}
}

// The pages a walk has yet to read are bounded by the pages there are: an
// interior page naming more children than the file has fails before any
// is read.
func TestSQLiteWalkBounded(t *testing.T) {
	in := make([]byte, tinyPage)
	in[0] = 0x05
	n := 60
	binary.BigEndian.PutUint16(in[3:], uint16(n))
	binary.BigEndian.PutUint32(in[8:], 1000)
	for i := range n {
		c := tinyPage - 5*(i+1)
		binary.BigEndian.PutUint16(in[12+2*i:], uint16(c))
		binary.BigEndian.PutUint32(in[c:], uint32(10+i))
		in[c+4] = byte(i)
	}
	_, f, err := scanFile(t, context.Background(), tinyDB(in), nil)
	if !errors.Is(err, errSQLite) || f.read > 2*tinyPage {
		t.Errorf("%v, %d bytes read", err, f.read)
	}
}

// A read has a budget: the rows it produces, the records it keeps and the
// bytes it reads; past it the read fails as too large, not cut short.
func TestSQLiteBudget(t *testing.T) {
	db := tinyDB(answers(5))
	defer func(rows, recs int) { sqliteMaxRows, openCodeMaxRecords = rows, recs }(sqliteMaxRows, openCodeMaxRecords)
	sqliteMaxRows = 4 // the schema's row and three answers
	if recs, _, err := scanFile(t, context.Background(), db, nil); !errors.Is(err, errSQLiteBudget) || recs != nil {
		t.Errorf("rows: %d records, %v", len(recs), err)
	}
	sqliteMaxRows = 100
	openCodeMaxRecords = 4
	if _, _, err := scanFile(t, context.Background(), db, nil); !errors.Is(err, errSQLiteBudget) || readFailure(err) != "too_large" {
		t.Errorf("records: %v", err)
	}
	openCodeMaxRecords = 5
	if recs, f, err := scanFile(t, context.Background(), db, nil); err != nil || len(recs) != 5 || f.read > f.budget || f.budget != 3*int64(len(db))+sqliteReadSlack {
		t.Errorf("within the budget: %d records, %v", len(recs), err)
	}
	// The bytes: a page past the budget is not read.
	dir := t.TempDir()
	p := filepath.Join(dir, "opencode.db")
	os.WriteFile(p, db, 0o600)
	f, err := openSQLite(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	f.budget = f.read + tinyPage
	if _, err := scanOpenCode(f, 0); !errors.Is(err, errSQLiteBudget) {
		t.Errorf("bytes: %v", err)
	}
}

// countdown is a context that ends after its Err was asked n times.
type countdown struct {
	context.Context
	n atomic.Int64
}

func (c *countdown) Err() error {
	if c.n.Add(-1) < 0 {
		return context.Canceled
	}
	return nil
}

// A read ends between two pages once its context ended, and a scan says
// nothing of a log it was stopped in.
func TestSQLiteCancelled(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "opencode", "opencode.db"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := &countdown{Context: context.Background()}
	ctx.n.Store(8)
	_, f, err := scanFile(t, ctx, src, nil)
	if !errors.Is(err, context.Canceled) || f.read > 8*tinyPage {
		t.Errorf("%v after %d bytes", err, f.read)
	}
	// A scan stopped within the database returns that, and no failure.
	e := openCodeHome(t)
	ctx = &countdown{Context: context.Background()}
	ctx.n.Store(4)
	if rep, err := Cost(ctx, e, CostOptions{}); !errors.Is(err, context.Canceled) || rep != nil {
		t.Errorf("a scan stopped in a read: %+v %v", rep, err)
	}
}

// A log that cannot be read is in the report, by provider and why.
func TestCostReportsUnreadLogs(t *testing.T) {
	e := testEnv(t, nil)
	db := filepath.Join(e.Home, ".local/share/opencode/opencode.db")
	write(t, db, "not a database at all, but long enough to be one's header ..... ..... ..... ..... ..... ..... ....")
	rep, err := Cost(context.Background(), e, CostOptions{Since: testNow.Add(-24 * time.Hour).Unix()})
	if err != nil || len(rep.Failed) != 1 || rep.Failed[0] != "opencode:damaged" {
		t.Errorf("%+v %v", rep, err)
	}
}

// FuzzSQLite reads any database and WAL (in memory) with the reader alone:
// it must not panic, and what it reads, produces and keeps is bounded by
// the files' size, in bounded time. make test runs the seeds; go test
// -fuzz=FuzzSQLite ./internal/usage looks further.
func FuzzSQLite(f *testing.F) {
	// The fixtures (a WAL over its database; interior and overflow pages
	// as SQLite writes them) and a small tree of two levels with an
	// overflow chain.
	read := func(name string) []byte {
		b, err := os.ReadFile(filepath.Join("testdata", "opencode", name))
		if err != nil {
			f.Fatal(err)
		}
		return b
	}
	f.Add(read("wal.db"), read("wal.db-wal"))
	f.Add(read("opencode.db"), []byte(nil))
	f.Add(tinyTree(), []byte(nil))
	f.Fuzz(func(t *testing.T, db, wal []byte) {
		start := time.Now()
		sf, err := sqliteBytes(context.Background(), db, wal)
		if err != nil {
			return
		}
		recs, err := scanOpenCode(sf, 0)
		size := int64(len(db) + len(wal))
		if sf.read > sf.budget || sf.budget > sqliteReadFactor*size+sqliteReadSlack {
			t.Fatalf("read %d of a budget of %d for %d bytes", sf.read, sf.budget, size)
		}
		// A row is a cell of at least 3 bytes and its 2-byte pointer, on a
		// page read once per tree (the schema's and the table's).
		if int64(sf.produced) > 2*size/4+2 || len(recs) > sf.produced {
			t.Fatalf("%d rows and %d records from %d bytes (%v)", sf.produced, len(recs), size, err)
		}
		if d := time.Since(start); d > 5*time.Second {
			t.Fatalf("%v for %d bytes", d, size)
		}
	})
}
