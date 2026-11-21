package usage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"os"
	"slices"
	"strings"
)

// sqliteFile reads the tables of an SQLite 3 database read-only, without
// SQLite: the file format's table b-trees and records
// (https://www.sqlite.org/fileformat2.html) and, in WAL mode, the pages the
// -wal file holds up to its last commit. It takes no lock and opens
// neither the -shm file nor anything for writing, so it never stands in
// the way of the program that owns the database. A writer that
// checkpointed or restarted the WAL meanwhile shows in changed, and the
// read is then tried again (OpenCode's and Antigravity's databases,
// cost_opencode.go and cost_antigravity.go).
//
// The file is another program's and may be damaged or made to hurt: every
// offset and length is checked before it is used (without arithmetic that
// could overflow), the cells of a page may not overlap, a page is read at
// most once in a tree (overflow pages too), and a read has a budget (the
// bytes read, the rows produced, the pages waiting in a walk), past which
// it fails with errSQLiteBudget rather than going on. ctx ends a read
// between any two pages.
type sqliteFile struct {
	ctx context.Context
	// db and wal are what is read (wal nil without one), their sizes as
	// opened; dbFile and walFile the files, for changed (nil for bytes).
	db, wal         io.ReaderAt
	dbLen, walLen   int64
	dbFile, walFile *os.File
	pageSize        int
	usable          int
	// pages is the database's size in pages: the last commit's in the
	// WAL, else the file's. limit is how many pages a walk may read: no
	// more than the files hold (a WAL's commit can name any size).
	pages uint32
	limit uint64
	// walPages are the offsets in the WAL of the pages its last commit
	// holds.
	walPages map[uint32]int64
	// read counts the bytes read, budget bounds them; produced counts the
	// rows produced.
	read, budget int64
	produced     int
	// Taken when opened, for changed.
	dbTime  int64
	walHead []byte
}

var (
	errSQLite = errors.New("not a readable SQLite database")
	// errSQLiteBudget: the read would cost more than a database of its
	// size can (sqliteReadFactor, sqliteMaxRows).
	errSQLiteBudget = errors.New("the database is larger than a read may be")
	errNotRegular   = errors.New("not a regular file")
)

const (
	// sqliteMaxWAL bounds the WAL read: a larger one (a checkpoint held
	// back for long) is not read.
	sqliteMaxWAL = 1 << 30
	walHeader    = 32
	walFrameHead = 24
	// sqliteReadFactor and sqliteReadSlack bound the bytes a read takes:
	// a well-formed file reads each page at most once per tree and its WAL
	// once, so at most twice the database's and the WAL's size; the slack
	// covers the header and the schema of a small file.
	sqliteReadFactor = 3
	sqliteReadSlack  = 1 << 20
)

// sqliteMaxRows bounds the rows a read produces (the schema's and the
// table's): OpenCode's table has a row per message, some thousands a year
// (7,532 in 9 months of daily use); 2,000,000 would be a database of
// gigabytes.
var sqliteMaxRows = 2_000_000

// openSQLite opens the database at p and its WAL, both regular files.
func openSQLite(ctx context.Context, p string) (*sqliteFile, error) {
	db, err := openRegular(p)
	if err != nil {
		return nil, err
	}
	f := &sqliteFile{ctx: ctx, db: db, dbFile: db}
	st, err := db.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	f.dbLen, f.dbTime = st.Size(), st.ModTime().UnixNano()
	switch w, err := openRegular(p + "-wal"); {
	case err == nil:
		f.wal, f.walFile = w, w
		if st, err := w.Stat(); err == nil {
			f.walLen = st.Size()
		}
	case !errors.Is(err, os.ErrNotExist):
		// A WAL that cannot be read: the database alone would be stale.
		f.Close()
		return nil, err
	}
	if err := f.open(); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// sqliteBytes reads a database and its WAL (nil: none) held in memory
// (FuzzSQLite).
func sqliteBytes(ctx context.Context, db, wal []byte) (*sqliteFile, error) {
	f := &sqliteFile{ctx: ctx, db: bytes.NewReader(db), dbLen: int64(len(db))}
	if wal != nil {
		f.wal, f.walLen = bytes.NewReader(wal), int64(len(wal))
	}
	if err := f.open(); err != nil {
		return nil, err
	}
	return f, nil
}

func (f *sqliteFile) open() error {
	f.budget = sqliteReadFactor*f.dbLen + sqliteReadSlack
	var head [100]byte
	hasHead := false
	if _, err := f.db.ReadAt(head[:], 0); err == nil {
		if !bytes.HasPrefix(head[:], []byte("SQLite format 3\x00")) {
			return errSQLite
		}
		hasHead = true
		f.pageSize = pageSizeOf(binary.BigEndian.Uint16(head[16:]))
	}
	if f.wal != nil {
		if err := f.readWAL(); err != nil {
			return err
		}
	}
	if f.pageSize == 0 {
		return errSQLite
	}
	f.usable = f.pageSize
	if !hasHead || f.walPages[1] > 0 {
		// The header as the last commit left it.
		pg, err := f.page(1)
		if err != nil {
			return err
		}
		copy(head[:], pg)
	}
	if !bytes.HasPrefix(head[:], []byte("SQLite format 3\x00")) || pageSizeOf(binary.BigEndian.Uint16(head[16:])) != f.pageSize {
		return errSQLite
	}
	// Text in UTF-8 only (0: a database that has none yet).
	if enc := binary.BigEndian.Uint32(head[56:]); enc > 1 {
		return errSQLite
	}
	f.usable = f.pageSize - int(head[20])
	if f.usable < 480 {
		return errSQLite
	}
	if f.pages == 0 {
		n := f.dbLen / int64(f.pageSize)
		if n > math.MaxUint32 {
			return errSQLite
		}
		f.pages = uint32(n)
	}
	f.limit = min(uint64(f.pages), uint64(f.dbLen)/uint64(f.pageSize)+uint64(len(f.walPages)))
	return nil
}

func pageSizeOf(v uint16) int {
	if v == 1 {
		return 65536
	}
	if v < 512 || v&(v-1) != 0 {
		return 0
	}
	return int(v)
}

// readWAL finds the pages of the WAL's last commit: frames whose salts are
// the header's and whose running checksum holds, up to the last that
// commits. A WAL without a valid header holds nothing.
func (f *sqliteFile) readWAL() error {
	if f.walLen > sqliteMaxWAL {
		return errSQLiteBudget
	}
	f.budget += sqliteReadFactor * f.walLen
	h := make([]byte, walHeader)
	if _, err := f.wal.ReadAt(h, 0); err != nil {
		f.walHead = nil
		return nil
	}
	f.walHead = h
	magic := binary.BigEndian.Uint32(h)
	if magic != 0x377f0682 && magic != 0x377f0683 {
		return nil
	}
	var order binary.ByteOrder = binary.LittleEndian
	if magic&1 == 1 {
		order = binary.BigEndian
	}
	ps := int(binary.BigEndian.Uint32(h[8:]))
	if binary.BigEndian.Uint32(h[4:]) != 3007000 || ps < 512 || ps > 65536 || ps&(ps-1) != 0 {
		return nil
	}
	s0, s1 := walChecksum(order, 0, 0, h[:24])
	if s0 != binary.BigEndian.Uint32(h[24:]) || s1 != binary.BigEndian.Uint32(h[28:]) {
		return nil
	}
	if f.pageSize == 0 {
		f.pageSize = ps
	} else if f.pageSize != ps {
		return nil
	}
	bufSize := min(1<<20, max(4096, int(f.walLen-walHeader)))
	r := bufio.NewReaderSize(io.NewSectionReader(f.wal, walHeader, f.walLen-walHeader), bufSize)
	frame := make([]byte, walFrameHead+ps)
	pending := map[uint32]int64{}
	off := int64(walHeader)
	for {
		if err := f.ctx.Err(); err != nil {
			return err
		}
		if _, err := io.ReadFull(r, frame); err != nil {
			break
		}
		f.read += int64(len(frame))
		fh := frame[:walFrameHead]
		if !bytes.Equal(fh[8:16], h[16:24]) {
			break
		}
		s0, s1 = walChecksum(order, s0, s1, fh[:8])
		s0, s1 = walChecksum(order, s0, s1, frame[walFrameHead:])
		if s0 != binary.BigEndian.Uint32(fh[16:]) || s1 != binary.BigEndian.Uint32(fh[20:]) {
			break
		}
		pg := binary.BigEndian.Uint32(fh)
		if pg == 0 {
			break
		}
		pending[pg] = off + walFrameHead
		if size := binary.BigEndian.Uint32(fh[4:]); size != 0 {
			if f.walPages == nil {
				f.walPages = map[uint32]int64{}
			}
			for k, v := range pending {
				f.walPages[k] = v
			}
			clear(pending)
			f.pages = size
		}
		off += int64(len(frame))
	}
	return nil
}

// walChecksum is the WAL's running checksum over b (whole 32-bit words in
// the WAL's byte order).
func walChecksum(order binary.ByteOrder, s0, s1 uint32, b []byte) (uint32, uint32) {
	for i := 0; i+8 <= len(b); i += 8 {
		s0 += order.Uint32(b[i:]) + s1
		s1 += order.Uint32(b[i+4:]) + s0
	}
	return s0, s1
}

func (f *sqliteFile) Close() {
	if f.dbFile != nil {
		f.dbFile.Close()
	}
	if f.walFile != nil {
		f.walFile.Close()
	}
}

// changed tells whether a writer changed the database since it was opened
// (a checkpoint writes it) or restarted the WAL (a new header): what was
// read may then mix two states.
func (f *sqliteFile) changed() bool {
	if f.dbFile == nil {
		return false
	}
	st, err := f.dbFile.Stat()
	if err != nil || st.Size() != f.dbLen || st.ModTime().UnixNano() != f.dbTime {
		return true
	}
	if f.walFile == nil {
		return false
	}
	h := make([]byte, walHeader)
	if _, err := f.walFile.ReadAt(h, 0); err != nil {
		return f.walHead != nil
	}
	return !bytes.Equal(h, f.walHead)
}

// page reads page n (from 1): the WAL's copy of the last commit, else the
// database's; within the budget, and not once ctx ended.
func (f *sqliteFile) page(n uint32) ([]byte, error) {
	if err := f.ctx.Err(); err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, errSQLite
	}
	if f.read > f.budget-int64(f.pageSize) {
		return nil, errSQLiteBudget
	}
	b := make([]byte, f.pageSize)
	if off, ok := f.walPages[n]; ok {
		if _, err := f.wal.ReadAt(b, off); err != nil {
			return nil, errSQLite
		}
	} else {
		if f.pages != 0 && n > f.pages {
			return nil, errSQLite
		}
		if _, err := f.db.ReadAt(b, int64(n-1)*int64(f.pageSize)); err != nil {
			return nil, errSQLite
		}
	}
	f.read += int64(len(b))
	return b, nil
}

// sqliteVarint reads a varint: big-endian groups of 7 bits, the ninth byte
// whole; 0 bytes when b ends first.
func sqliteVarint(b []byte) (uint64, int) {
	var v uint64
	for i := 0; i < 9 && i < len(b); i++ {
		if i == 8 {
			return v<<8 | uint64(b[i]), 9
		}
		v = v<<7 | uint64(b[i]&0x7f)
		if b[i] < 0x80 {
			return v, i + 1
		}
	}
	return 0, 0
}

// localSize is how much of a leaf cell's record of size bytes is on its
// page; the rest is in overflow pages.
func (f *sqliteFile) localSize(size int) int {
	u := f.usable
	if x := u - 35; size > x {
		m := (u-12)*32/255 - 23
		local := m + (size-m)%(u-4)
		if local > x {
			local = m
		}
		return local
	}
	return size
}

// cell is a cell of a page: where it is, and what it says.
type cell struct {
	start, end int
	// child (interior) or rowid and record size (leaf); at is where the
	// leaf's record starts.
	child       uint32
	rowid, size uint64
	at          int
}

// cells reads the cells of page pg (its b-tree header at h): each wholly
// within the cell content area, after the cell pointer array, none
// overlapping another.
func (f *sqliteFile) cells(pg []byte, h int, leaf bool) ([]cell, error) {
	n := int(binary.BigEndian.Uint16(pg[h+3:]))
	ptrs := h + 8
	if !leaf {
		ptrs = h + 12
	}
	area := ptrs + 2*n
	if area > f.usable {
		return nil, errSQLite
	}
	out := make([]cell, n)
	for i := range out {
		c := int(binary.BigEndian.Uint16(pg[ptrs+2*i:]))
		if c < area || c >= f.usable {
			return nil, errSQLite
		}
		x := cell{start: c}
		if !leaf {
			if f.usable-c < 4 {
				return nil, errSQLite
			}
			x.child = binary.BigEndian.Uint32(pg[c:])
			_, k := sqliteVarint(pg[c+4 : f.usable])
			if k == 0 {
				return nil, errSQLite
			}
			x.end = c + 4 + k
		} else {
			size, k1 := sqliteVarint(pg[c:f.usable])
			if k1 == 0 {
				return nil, errSQLite
			}
			rowid, k2 := sqliteVarint(pg[c+k1 : f.usable])
			if k2 == 0 || size > math.MaxInt32 {
				return nil, errSQLite
			}
			local := f.localSize(int(size))
			x.rowid, x.size, x.at = rowid, size, c+k1+k2
			// The record on the page, and the first overflow page's number.
			room := f.usable - x.at
			if local > room || local < int(size) && room-local < 4 {
				return nil, errSQLite
			}
			x.end = x.at + local
			if local < int(size) {
				x.end += 4
			}
		}
		out[i] = x
	}
	byStart := slices.Clone(out)
	slices.SortFunc(byStart, func(a, b cell) int { return a.start - b.start })
	for i := 1; i < len(byStart); i++ {
		if byStart[i].start < byStart[i-1].end {
			return nil, errSQLite
		}
	}
	return out, nil
}

// rows calls fn with each row of the table b-tree at root: its rowid and
// its values (nil, int64, float64, string or []byte). Rows whose record is
// longer than maxRecord are skipped unread.
func (f *sqliteFile) rows(root uint32, maxRecord int64, fn func(rowid int64, vals []any) error) error {
	return f.rowsWhere(root, maxRecord, nil, fn)
}

// rowsWhere is rows, skipping any row whose rowid want rejects before
// reading its overflow pages or decoding its record.
func (f *sqliteFile) rowsWhere(root uint32, maxRecord int64, want func(rowid int64) bool, fn func(rowid int64, vals []any) error) error {
	stack := []uint32{root}
	// Every page of the tree, overflow pages too: each once.
	seen := map[uint32]bool{}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[n] || uint64(len(seen)) >= f.limit {
			return errSQLite
		}
		seen[n] = true
		pg, err := f.page(n)
		if err != nil {
			return err
		}
		h := 0
		if n == 1 {
			h = 100
		}
		if len(pg) < h+12 {
			return errSQLite
		}
		switch pg[h] {
		case 0x05: // interior: children left to right, then the right-most
			cs, err := f.cells(pg, h, false)
			if err != nil {
				return err
			}
			// The pages a walk has read and has yet to read are distinct
			// pages of the tree: no more than the database has.
			if uint64(len(seen)+len(stack)+len(cs)+1) > f.limit {
				return errSQLite
			}
			stack = append(stack, binary.BigEndian.Uint32(pg[h+8:]))
			for i := len(cs) - 1; i >= 0; i-- {
				stack = append(stack, cs[i].child)
			}
		case 0x0d: // leaf
			cs, err := f.cells(pg, h, true)
			if err != nil {
				return err
			}
			for _, c := range cs {
				if int64(c.size) > maxRecord {
					continue
				}
				if f.produced++; f.produced > sqliteMaxRows {
					return errSQLiteBudget
				}
				if want != nil && !want(int64(c.rowid)) {
					continue
				}
				rec, err := f.payload(pg, c.at, int(c.size), seen)
				if err != nil {
					return err
				}
				vals, err := sqliteRecord(rec)
				if err != nil {
					return err
				}
				if err := fn(int64(c.rowid), vals); err != nil {
					return err
				}
			}
		default:
			return errSQLite
		}
	}
	return nil
}

// payload is a leaf cell's record of size bytes starting at at (its
// extent checked by cells): the part on the page and the rest from its
// chain of overflow pages, each a page of the tree not read before.
func (f *sqliteFile) payload(pg []byte, at, size int, seen map[uint32]bool) ([]byte, error) {
	local := f.localSize(size)
	if local < size {
		// Overflow pages each hold at most usable-4 bytes, and a walk reads
		// at most f.limit pages in all: refuse a claimed size the file
		// cannot hold before allocating for it.
		rem := uint64(size - local)
		maxPages := f.limit - uint64(len(seen))
		if rem > maxPages*uint64(f.usable-4) {
			return nil, errSQLite
		}
	}
	out := make([]byte, 0, size)
	out = append(out, pg[at:at+local]...)
	if local == size {
		return out, nil
	}
	next := binary.BigEndian.Uint32(pg[at+local:])
	for len(out) < size {
		if next == 0 || seen[next] || uint64(len(seen)) >= f.limit {
			return nil, errSQLite
		}
		seen[next] = true
		op, err := f.page(next)
		if err != nil {
			return nil, err
		}
		n := min(size-len(out), f.usable-4)
		out = append(out, op[4:4+n]...)
		next = binary.BigEndian.Uint32(op)
	}
	return out, nil
}

// sqliteRecord decodes a record: its header of serial types, then the
// values. Lengths are compared with what is left, never added to an
// offset first, so no length can overflow past a check.
func sqliteRecord(b []byte) ([]any, error) {
	hl, k := sqliteVarint(b)
	if k == 0 || hl > uint64(len(b)) || hl < uint64(k) {
		return nil, errSQLite
	}
	var types []uint64
	for p := k; p < int(hl); {
		t, n := sqliteVarint(b[p:hl])
		if n == 0 {
			return nil, errSQLite
		}
		types = append(types, t)
		p += n
	}
	vals := make([]any, len(types))
	p := int(hl)
	for i, t := range types {
		var size uint64
		switch {
		case t == 0:
		case t <= 6:
			size = []uint64{0, 1, 2, 3, 4, 6, 8}[t]
		case t == 7:
			size = 8
		case t == 8 || t == 9:
			vals[i] = int64(t - 8)
			continue
		case t >= 12:
			size = (t - 12) / 2
		default:
			return nil, errSQLite
		}
		if size > uint64(len(b)-p) {
			return nil, errSQLite
		}
		v := b[p : p+int(size)]
		p += int(size)
		switch {
		case t == 0:
			vals[i] = nil
		case t <= 6:
			x := int64(0)
			if v[0]&0x80 != 0 {
				x = -1
			}
			for _, c := range v {
				x = x<<8 | int64(c)
			}
			vals[i] = x
		case t == 7:
			vals[i] = math.Float64frombits(binary.BigEndian.Uint64(v))
		case t%2 == 0:
			// payload() allocates a fresh buffer per row that nothing else
			// mutates, so slicing directly avoids doubling peak memory on
			// multi-megabyte BLOB rows.
			vals[i] = v
		default:
			vals[i] = string(v)
		}
	}
	return vals, nil
}

// sqliteTable is a table's root page and column list from sqlite_master.
type sqliteTable struct {
	root uint32
	cols []string
}

// tables finds every named table in the schema in a single walk of page 1.
// A WITHOUT ROWID table (an index b-tree) fails with errSQLite.
func (f *sqliteFile) tables(names ...string) (map[string]sqliteTable, error) {
	want := make(map[string]bool, len(names))
	for _, n := range names {
		want[n] = true
	}
	found := make(map[string]sqliteTable, len(names))
	err := f.rows(1, 1<<20, func(_ int64, v []any) error {
		if len(v) < 5 || v[0] != "table" {
			return nil
		}
		name, _ := v[1].(string)
		if !want[name] {
			return nil
		}
		r, _ := v[3].(int64)
		sql, _ := v[4].(string)
		if r <= 0 || r > math.MaxUint32 || strings.Contains(strings.ToUpper(sql), "WITHOUT ROWID") {
			return errSQLite
		}
		found[name] = sqliteTable{root: uint32(r), cols: sqliteColumns(sql)}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return found, nil
}

// table finds a table in the schema: its root page and its columns in
// their order. A WITHOUT ROWID table (an index b-tree) is not read.
func (f *sqliteFile) table(name string) (uint32, []string, error) {
	found, err := f.tables(name)
	if err != nil {
		return 0, nil, err
	}
	t, ok := found[name]
	if !ok {
		return 0, nil, os.ErrNotExist
	}
	return t.root, t.cols, nil
}

// sqliteColumns are the names of the columns a CREATE TABLE statement
// declares, in their order (columns added later are in it too): each
// definition's first word, unquoted, leaving out table constraints.
func sqliteColumns(sql string) []string {
	i, j := strings.IndexByte(sql, '('), strings.LastIndexByte(sql, ')')
	if i < 0 || j <= i {
		return nil
	}
	var cols []string
	add := func(def string) {
		def = strings.TrimSpace(def)
		if def == "" {
			return
		}
		if q := def[0]; q == '`' || q == '"' || q == '[' || q == '\'' {
			if q == '[' {
				q = ']'
			}
			if k := strings.IndexByte(def[1:], q); k >= 0 {
				cols = append(cols, def[1:1+k])
			}
			return
		}
		word := def
		if k := strings.IndexAny(def, " \t\r\n"); k >= 0 {
			word = def[:k]
		}
		switch strings.ToUpper(word) {
		case "CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK":
			return
		}
		cols = append(cols, word)
	}
	depth, start := 0, i+1
	var quote byte
	for k := i + 1; k < j; k++ {
		c := sql[k]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '`' || c == '"' || c == '\'':
			quote = c
		case c == '[':
			quote = ']'
		case c == '(':
			depth++
		case c == ')':
			depth--
		case c == ',' && depth == 0:
			add(sql[start:k])
			start = k + 1
		}
	}
	add(sql[start:j])
	return cols
}
