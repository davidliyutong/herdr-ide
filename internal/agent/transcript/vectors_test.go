//go:build unix

package transcript

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"veldr/internal/agentproto"
)

// The shared vectors (spec/vectors/transcript/*.json, which the web UI's
// tests check against its types): the lines of a Claude Code transcript and
// the events a reader of the whole conversation gathers of their Frames
// (readAll), without their times.
var update = flag.Bool("update", false, "rewrite the vectors' expected events, unknown counts and titles")

const vectorDir = "../../../spec/vectors/transcript"

type vector struct {
	Note    string            `json:"note"`
	Kind    string            `json:"kind"`
	Lines   []string          `json:"lines"`
	Unknown int               `json:"unknown"`
	Title   string            `json:"title,omitempty"`
	Events  []json.RawMessage `json:"events"`
}

func vectorFiles(t testing.TB) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(vectorDir, "*.json"))
	if err != nil || len(files) < 5 {
		t.Fatalf("vectors: %v %v", files, err)
	}
	return files
}

func readVector(t testing.TB, file string) vector {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var v vector
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("%s: %v", file, err)
	}
	return v
}

// content is a vector's lines as a file.
func (v vector) content() []byte {
	var b bytes.Buffer
	for _, l := range v.Lines {
		b.WriteString(l)
		b.WriteByte('\n')
	}
	return b.Bytes()
}

// plainEvents are events as JSON values without their times.
func plainEvents(t testing.TB, evs []agentproto.TranscriptEvent) []any {
	t.Helper()
	out := []any{}
	for _, ev := range evs {
		b, err := json.Marshal(ev)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		delete(m, "at")
		out = append(out, m)
	}
	return out
}

func rawValues(t testing.TB, raws []json.RawMessage) []any {
	t.Helper()
	out := []any{}
	for _, r := range raws {
		var v any
		if err := json.Unmarshal(r, &v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

func sameEvents(t testing.TB, what string, got, want []any) {
	t.Helper()
	if reflect.DeepEqual(got, want) {
		return
	}
	for i := range max(len(got), len(want)) {
		var g, w []byte
		if i < len(got) {
			g, _ = json.Marshal(got[i])
		}
		if i < len(want) {
			w, _ = json.Marshal(want[i])
		}
		if !bytes.Equal(g, w) {
			t.Errorf("%s: event %d (of %d, want %d)\n got  %s\n want %s", what, i, len(got), len(want), g, w)
			return
		}
	}
}

func TestVectors(t *testing.T) {
	for _, file := range vectorFiles(t) {
		t.Run(filepath.Base(file), func(t *testing.T) {
			v := readVector(t, file)
			got := readAll(t, v.content(), Limits{})
			if *update {
				v.Events = nil
				for _, e := range plainEvents(t, got.Events) {
					b, _ := marshalPlain(e)
					v.Events = append(v.Events, b)
				}
				v.Unknown, v.Title = got.Unknown, got.Title
				var out bytes.Buffer
				enc := json.NewEncoder(&out)
				enc.SetEscapeHTML(false)
				enc.SetIndent("", "  ")
				if err := enc.Encode(v); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(file, out.Bytes(), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			sameEvents(t, "events", plainEvents(t, got.Events), rawValues(t, v.Events))
			if got.Unknown != v.Unknown || got.Title != v.Title {
				t.Errorf("unknown %d title %q, want %d %q", got.Unknown, got.Title, v.Unknown, v.Title)
			}
			// No base64 of an image is forwarded.
			b, _ := json.Marshal(got)
			if bytes.Contains(b, []byte("iVBORw0KGgo")) || bytes.Contains(b, []byte(";base64,")) {
				t.Errorf("an image was forwarded: %s", b)
			}
		})
	}
}

// marshalPlain is v as JSON without HTML escapes, as the vectors are
// written.
func marshalPlain(v any) (json.RawMessage, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	err := enc.Encode(v)
	return bytes.TrimSpace(b.Bytes()), err
}

// Read from each line's start, and from inside each line, a vector gives
// the Frames of the lines from there on, the same as each line on its own
// (ClaudeFrame).
func TestVectorsFromEachLine(t *testing.T) {
	for _, file := range vectorFiles(t) {
		v := readVector(t, file)
		data := v.content()
		// offs are the lines' offsets, and the end.
		offs := []int64{0}
		for _, l := range v.Lines {
			offs = append(offs, offs[len(offs)-1]+int64(len(l))+1)
		}
		for i, l := range v.Lines {
			want := ClaudeFrame([]byte(l), Limits{})
			for first, from := range map[int]int64{i: offs[i], i + 1: offs[i] + 1} {
				var got []int64
				err := EachClaude(context.Background(), bytes.NewReader(data), from, int64(len(data)), Limits{}, func(o int64, f Frame) bool {
					if len(got) == 0 && o == offs[i] && !reflect.DeepEqual(f, want) {
						t.Errorf("%s line %d: %+v, want %+v", filepath.Base(file), i, f, want)
					}
					got = append(got, o)
					return true
				})
				if err != nil || !slices.Equal(got, offs[first:len(v.Lines)]) {
					t.Errorf("%s from %d: offsets %v, want %v (%v)", filepath.Base(file), from, got, offs[first:len(v.Lines)], err)
				}
			}
		}
	}
}

func TestVectorNames(t *testing.T) {
	for _, file := range vectorFiles(t) {
		v := readVector(t, file)
		if v.Note == "" || v.Kind != "claude" || len(v.Lines) == 0 {
			t.Errorf("%s: a vector has a note, the kind claude and lines", file)
		}
		if strings.ContainsAny(filepath.Base(file), " ") {
			t.Errorf("%s: a name without spaces", file)
		}
	}
}
