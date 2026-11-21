package usage

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"slices"
	"strconv"
	"strings"
)

// Antigravity keeps each conversation in an SQLite database in WAL mode
// under ~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/conversations/<id>.db.
// Its table gen_metadata holds one protobuf blob per LLM generation with
// exact token counts (non-cached prompt, cached reads, output, thinking and
// content tokens), the model identifier and request metadata; steps holds
// per-step timestamps; trajectory_metadata_blob holds the workspace URI and
// conversation start time.
//
// Each database is read read-only with sqliteFile (no lock, no -shm, WAL
// commits included), retried when a writer checkpointed or restarted the
// WAL meanwhile, and cached by its combined database + WAL size and mtime.

const (
	// antigravityMaxMetaRecord bounds trajectory_metadata_blob rows (~1 KiB
	// in practice).
	antigravityMaxMetaRecord = 64 << 10
	// antigravityMaxStepRecord bounds steps rows read for timestamps:
	// planner steps with timestamps are a few KiB, while large tool output
	// steps are skipped unread.
	antigravityMaxStepRecord = 256 << 10
	// antigravityMaxGenRecord bounds gen_metadata rows: earlier turns are
	// ~1.5 KiB, while the last turn of a conversation embeds the prompt
	// history before the usage block and can reach tens of megabytes.
	// sqliteFile.payload refuses claimed sizes larger than the file holds
	// before allocating.
	antigravityMaxGenRecord = 64 << 20
	// antigravityMaxTok bounds a single token count from a protobuf varint.
	antigravityMaxTok = 1e15
	// antigravityMinTS and antigravityMaxTS bound valid Unix timestamps
	// (2001 to 2286).
	antigravityMinTS = 1_000_000_000
	antigravityMaxTS = 10_000_000_000
)

// antigravityMaxRecords bounds the generations kept per conversation
// database (a real conversation has tens to hundreds).
var antigravityMaxRecords = 100_000

// antigravityDirs are Antigravity's data directories below the home
// directory (desktop/daemon, CLI and IDE).
var antigravityDirs = []string{
	".gemini/antigravity",
	".gemini/antigravity-cli",
	".gemini/antigravity-ide",
}

// antigravityDBs lists Antigravity's conversation databases on this machine.
func antigravityDBs(e *Env) []string {
	var out []string
	for _, sub := range antigravityDirs {
		dir := path.Join(e.Home, sub, "conversations")
		ents, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, d := range ents {
			n := d.Name()
			if d.Type().IsRegular() && strings.HasSuffix(n, ".db") {
				out = append(out, path.Join(dir, n))
			}
		}
	}
	slices.Sort(out)
	return out
}

// antigravityTable picks the price table for a model used in Antigravity:
// Anthropic, OpenAI and xAI models use their own tables; Gemini models use
// Antigravity's.
func antigravityTable(model string) string {
	switch {
	case strings.HasPrefix(model, "claude-"):
		return Claude
	case strings.HasPrefix(model, "gpt-"):
		return Codex
	case strings.HasPrefix(model, "grok-"):
		return Grok
	}
	return Antigravity
}

// parseAntigravityDB reads into ent the generations of an Antigravity
// conversation database from since on, retrying up to three times if a
// writer checkpointed or restarted its WAL meanwhile.
func parseAntigravityDB(ctx context.Context, p string, ent *fileEntry, since int64) (int64, error) {
	fallbackTS := ent.MTime / 1e9
	var read int64
	for attempt := 0; ; attempt++ {
		recs, n, err := readAntigravity(ctx, p, since, fallbackTS)
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

// readAntigravity reads one Antigravity conversation database at p.
func readAntigravity(ctx context.Context, p string, since, fallbackTS int64) (recs []Record, read int64, err error) {
	f, err := openSQLite(ctx, p)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%w: %v", errSQLite, r)
		}
		if ctx.Err() == nil && f.changed() {
			err = errSQLiteChanged
		}
		if err != nil {
			recs = nil
		}
		read = f.read
	}()
	convID := strings.TrimSuffix(path.Base(p), ".db")
	recs, err = scanAntigravity(f, convID, since, fallbackTS)
	return recs, 0, err
}

// scanAntigravity reads a conversation's schema once, parses gen_metadata
// first, and only then reads trajectory_metadata_blob and the exact steps
// rows referenced by non-empty generations.
func scanAntigravity(f *sqliteFile, convID string, since, fallbackTS int64) ([]Record, error) {
	tbls, err := f.tables("gen_metadata", "trajectory_metadata_blob", "steps")
	if err != nil {
		return nil, err
	}
	genTbl, ok := tbls["gen_metadata"]
	if !ok {
		return nil, nil
	}
	iIdx, iData := slices.Index(genTbl.cols, "idx"), slices.Index(genTbl.cols, "data")
	if iData < 0 {
		return nil, errSQLite
	}

	type rawGen struct {
		idx int64
		g   antigravityGen
	}
	var gens []rawGen
	var needSteps map[int64]bool
	err = f.rows(genTbl.root, antigravityMaxGenRecord, func(rowid int64, v []any) error {
		data := bytesOf(colAt(v, iData))
		if len(data) == 0 {
			return nil
		}
		g, ok := parseAntigravityGen(data)
		if !ok || g.input+g.cached+g.output == 0 {
			return nil
		}
		if len(gens) >= antigravityMaxRecords {
			return errSQLiteBudget
		}
		idx := rowid
		if n, ok := colAt(v, iIdx).(int64); ok {
			idx = n
		}
		if len(g.steps) > 0 || g.hasLastStep {
			if needSteps == nil {
				needSteps = map[int64]bool{}
			}
			for _, s := range g.steps {
				needSteps[s] = true
			}
			if g.hasLastStep {
				needSteps[g.lastStep] = true
			}
		}
		gens = append(gens, rawGen{idx: idx, g: g})
		return nil
	})
	if err != nil || len(gens) == 0 {
		return nil, err
	}

	var project string
	var convTS int64
	if metaTbl, ok := tbls["trajectory_metadata_blob"]; ok {
		project, convTS, err = scanAntigravityMeta(f, metaTbl)
		if err != nil {
			return nil, err
		}
	}
	var stepTS map[int64]int64
	if len(needSteps) > 0 {
		if stepsTbl, ok := tbls["steps"]; ok {
			stepTS, err = scanAntigravityStepTS(f, stepsTbl, needSteps)
			if err != nil {
				return nil, err
			}
		}
	}

	recs := make([]Record, 0, len(gens))
	for _, item := range gens {
		g := item.g
		ts := int64(0)
		for _, s := range g.steps {
			if t := stepTS[s]; t > 0 {
				ts = t
				break
			}
		}
		if ts == 0 && g.hasLastStep {
			ts = stepTS[g.lastStep]
		}
		if ts == 0 {
			ts = convTS
		}
		if ts == 0 {
			ts = fallbackTS
		}
		if ts <= 0 || ts < since {
			continue
		}
		key := ""
		switch {
		case g.requestID != "":
			key = "ag:" + g.requestID
		case g.cascadeID != "":
			key = "ag:" + g.cascadeID + ":" + strconv.FormatInt(item.idx, 10)
		case convID != "":
			key = "ag:" + convID + ":" + strconv.FormatInt(item.idx, 10)
		}
		recs = append(recs, Record{
			K: key,
			T: ts,
			M: firstNonEmpty(g.model, "unknown"),
			J: project,
			I: g.input,
			C: g.cached,
			O: g.output,
			R: min(g.thinking, g.output),
			N: 1,
		})
	}
	return recs, nil
}

// scanAntigravityMeta reads the project name and start time from
// trajectory_metadata_blob.
func scanAntigravityMeta(f *sqliteFile, tbl sqliteTable) (project string, ts int64, err error) {
	iData := slices.Index(tbl.cols, "data")
	if iData < 0 {
		return "", 0, nil
	}
	err = f.rows(tbl.root, antigravityMaxMetaRecord, func(_ int64, v []any) error {
		if project != "" && ts != 0 {
			return nil
		}
		b := bytesOf(colAt(v, iData))
		if len(b) == 0 {
			return nil
		}
		p, t := parseAntigravityTrajectory(b)
		if project == "" && p != "" {
			project = p
		}
		if ts == 0 && t > 0 {
			ts = t
		}
		return nil
	})
	return project, ts, err
}

// scanAntigravityStepTS reads timestamps from steps.metadata only for the
// rowids in want, skipping unreferenced tool-output steps before reading
// their overflow pages.
func scanAntigravityStepTS(f *sqliteFile, tbl sqliteTable, want map[int64]bool) (map[int64]int64, error) {
	iIdx, iMeta := slices.Index(tbl.cols, "idx"), slices.Index(tbl.cols, "metadata")
	if iMeta < 0 {
		return nil, nil
	}
	out := make(map[int64]int64, len(want))
	err := f.rowsWhere(tbl.root, antigravityMaxStepRecord, func(rowid int64) bool {
		return want[rowid]
	}, func(rowid int64, v []any) error {
		b := bytesOf(colAt(v, iMeta))
		if len(b) == 0 {
			return nil
		}
		if t := parseAntigravityStepMetaTS(b); t > 0 {
			idx := rowid
			if n, ok := colAt(v, iIdx).(int64); ok {
				idx = n
			}
			out[idx] = t
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func colAt(v []any, i int) any {
	if i < 0 || i >= len(v) {
		return nil
	}
	return v[i]
}

func bytesOf(v any) []byte {
	switch x := v.(type) {
	case []byte:
		return x
	case string:
		return []byte(x)
	}
	return nil
}

// antigravityGen is what one gen_metadata protobuf blob says about an LLM
// generation.
type antigravityGen struct {
	model       string
	requestID   string
	cascadeID   string
	steps       []int64
	lastStep    int64
	hasLastStep bool
	input       int64
	cached      int64
	output      int64
	thinking    int64
}

// protoField is one decoded protobuf wire field.
type protoField struct {
	num uint64
	wt  uint64
	u   uint64
	b   []byte
}

// protoNext reads the next protobuf wire field from b without panicking or
// overflowing. ok is false at EOF or on malformed input.
func protoNext(b []byte) (f protoField, rest []byte, ok bool) {
	tag, n := binary.Uvarint(b)
	if n <= 0 {
		return f, nil, false
	}
	b = b[n:]
	f.num, f.wt = tag>>3, tag&7
	if f.num == 0 {
		return f, nil, false
	}
	switch f.wt {
	case 0: // varint
		v, m := binary.Uvarint(b)
		if m <= 0 {
			return f, nil, false
		}
		f.u = v
		return f, b[m:], true
	case 1: // 64-bit
		if len(b) < 8 {
			return f, nil, false
		}
		return f, b[8:], true
	case 2: // length-delimited
		l, m := binary.Uvarint(b)
		if m <= 0 || l > uint64(len(b)-m) {
			return f, nil, false
		}
		f.b = b[m : m+int(l)]
		return f, b[m+int(l):], true
	case 5: // 32-bit
		if len(b) < 4 {
			return f, nil, false
		}
		return f, b[4:], true
	}
	return f, nil, false
}

func protoTok(v uint64) int64 {
	if v == 0 || v > antigravityMaxTok {
		return 0
	}
	return int64(v)
}

func protoTimestamp(b []byte) int64 {
	for len(b) > 0 {
		f, rest, ok := protoNext(b)
		if !ok {
			break
		}
		b = rest
		if f.num == 1 && f.wt == 0 && f.u > antigravityMinTS && f.u < antigravityMaxTS {
			return int64(f.u)
		}
	}
	return 0
}

func protoString(b []byte, maxLen int) string {
	if len(b) == 0 || len(b) > maxLen {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// parseAntigravityGen extracts usage telemetry from a gen_metadata blob:
//
//	field 2: step indices (packed varints or repeated varint)
//	field 1 (payload):
//	  field 4 (usage):
//	    field 2: prompt tokens (non-cached input)
//	    field 3: total output tokens
//	    field 5: cached input tokens
//	    field 9: thinking tokens (subset of output)
//	    field 10: content tokens
//	  field 19: model ID
//	  field 20 (map<string,string>): request_id, cascade_id, last_step_index
func parseAntigravityGen(b []byte) (antigravityGen, bool) {
	var g antigravityGen
	foundUsage := false
	for len(b) > 0 {
		f, rest, ok := protoNext(b)
		if !ok {
			break
		}
		b = rest
		switch {
		case f.num == 2 && f.wt == 0:
			if f.u <= antigravityMaxTok {
				g.steps = append(g.steps, int64(f.u))
			}
		case f.num == 2 && f.wt == 2:
			s := f.b
			for len(s) > 0 && len(g.steps) < 64 {
				v, n := binary.Uvarint(s)
				if n <= 0 {
					break
				}
				s = s[n:]
				if v <= antigravityMaxTok {
					g.steps = append(g.steps, int64(v))
				}
			}
		case f.num == 1 && f.wt == 2:
			if parseAntigravityPayload(f.b, &g) {
				foundUsage = true
			}
		}
	}
	return g, foundUsage
}

func parseAntigravityPayload(b []byte, g *antigravityGen) bool {
	foundUsage := false
	for len(b) > 0 {
		f, rest, ok := protoNext(b)
		if !ok {
			break
		}
		b = rest
		if f.wt != 2 {
			continue
		}
		switch f.num {
		case 4:
			foundUsage = true
			var content int64
			u := f.b
			for len(u) > 0 {
				uf, urest, ok := protoNext(u)
				if !ok {
					break
				}
				u = urest
				if uf.wt != 0 {
					continue
				}
				switch uf.num {
				case 2:
					g.input = protoTok(uf.u)
				case 3:
					g.output = protoTok(uf.u)
				case 5:
					g.cached = protoTok(uf.u)
				case 9:
					g.thinking = protoTok(uf.u)
				case 10:
					content = protoTok(uf.u)
				}
			}
			if g.output == 0 && (g.thinking > 0 || content > 0) {
				g.output = g.thinking + content
			}
		case 19:
			if m := protoString(f.b, 200); m != "" {
				g.model = m
			}
		case 20:
			k, v := parseProtoMapEntry(f.b)
			switch k {
			case "request_id":
				g.requestID = v
			case "cascade_id":
				g.cascadeID = v
			case "last_step_index":
				if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
					g.lastStep, g.hasLastStep = n, true
				}
			}
		}
	}
	return foundUsage
}

func parseProtoMapEntry(b []byte) (k, v string) {
	for len(b) > 0 {
		f, rest, ok := protoNext(b)
		if !ok {
			break
		}
		b = rest
		if f.wt != 2 {
			continue
		}
		switch f.num {
		case 1:
			k = protoString(f.b, 128)
		case 2:
			v = protoString(f.b, 256)
		}
	}
	return k, v
}

// parseAntigravityTrajectory reads the workspace directory name (field 7,
// else field 1.1) and conversation start timestamp (field 2.1) from
// trajectory_metadata_blob.data.
func parseAntigravityTrajectory(b []byte) (project string, ts int64) {
	var f1URI string
	for len(b) > 0 {
		f, rest, ok := protoNext(b)
		if !ok {
			break
		}
		b = rest
		if f.wt != 2 {
			continue
		}
		switch f.num {
		case 1:
			if f1URI == "" {
				s := f.b
				for len(s) > 0 {
					sf, srest, ok := protoNext(s)
					if !ok {
						break
					}
					s = srest
					if sf.num == 1 && sf.wt == 2 {
						f1URI = protoString(sf.b, 4096)
						break
					}
				}
			}
		case 2:
			if ts == 0 {
				ts = protoTimestamp(f.b)
			}
		case 7:
			if project == "" {
				project = uriProjectName(protoString(f.b, 4096))
			}
		}
	}
	if project == "" && f1URI != "" {
		project = uriProjectName(f1URI)
	}
	return project, ts
}

// parseAntigravityStepMetaTS reads a step's timestamp from steps.metadata:
// created_at (field 1), else completion timestamps (fields 6, 7, 8).
func parseAntigravityStepMetaTS(b []byte) int64 {
	var fallback int64
	for len(b) > 0 {
		f, rest, ok := protoNext(b)
		if !ok {
			break
		}
		b = rest
		if f.wt != 2 || len(f.b) > 32 {
			continue
		}
		switch f.num {
		case 1:
			if t := protoTimestamp(f.b); t > 0 {
				return t
			}
		case 6, 7, 8:
			if fallback == 0 {
				fallback = protoTimestamp(f.b)
			}
		}
	}
	return fallback
}

func uriProjectName(s string) string {
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, "file://") {
		if u, err := url.Parse(s); err == nil && u.Path != "" {
			return projectName(u.Path)
		}
	}
	return projectName(s)
}
