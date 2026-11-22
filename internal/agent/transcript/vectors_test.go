//go:build unix

package transcript

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"herdr-ide/internal/agentproto"
)

// The shared vectors (design/testdata/transcript/*.json, which the web UI's
// tests check against its types): the lines of a transcript and the events
// a read of them gives, without their places and times.
var update = flag.Bool("update", false, "rewrite the vectors' expected events, unknown counts and titles")

const vectorDir = "../../../design/testdata/transcript"

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
	if err != nil || len(files) < 6 {
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

// plainEvents are events as JSON values without their places and times.
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
		delete(m, "seq")
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
			data := v.content()
			fwd := read(t, v.Kind, data, agentproto.TranscriptRef{}, Limits{})
			if fwd.More || fwd.Code != "" {
				t.Fatalf("one page holds the vector: %+v", fwd)
			}
			if *update {
				v.Events = nil
				for _, e := range plainEvents(t, fwd.Events) {
					b, _ := marshalPlain(e)
					v.Events = append(v.Events, b)
				}
				v.Unknown, v.Title = fwd.Unknown, fwd.Title
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
			want := rawValues(t, v.Events)
			sameEvents(t, "forward", plainEvents(t, fwd.Events), want)
			if fwd.Unknown != v.Unknown || fwd.Title != v.Title {
				t.Errorf("unknown %d title %q, want %d %q", fwd.Unknown, fwd.Title, v.Unknown, v.Title)
			}
			if fwd.Next != agentproto.Seq(int64(len(data)), 0) {
				t.Errorf("next %d, want the end %d", fwd.Next, len(data))
			}
			back := read(t, v.Kind, data, agentproto.TranscriptRef{Back: true}, Limits{})
			sameEvents(t, "back", plainEvents(t, back.Events), want)
			if back.More || back.Next != fwd.Next || back.Unknown != v.Unknown || back.Title != v.Title {
				t.Errorf("back read: more %v next %d unknown %d title %q", back.More, back.Next, back.Unknown, back.Title)
			}
			// No base64 of an image is forwarded.
			b, _ := json.Marshal(fwd)
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

// Every vector, read on from each line's start, gives the events of the
// lines from there on: a line's events do not depend on where a read
// started (for Codex, the form and the model come from a look back).
func TestVectorsFromEachLine(t *testing.T) {
	for _, file := range vectorFiles(t) {
		v := readVector(t, file)
		data := v.content()
		full := read(t, v.Kind, data, agentproto.TranscriptRef{}, Limits{})
		off := int64(0)
		for i, l := range v.Lines {
			from := agentproto.Seq(off, 0)
			got := read(t, v.Kind, data, agentproto.TranscriptRef{From: from}, Limits{})
			var want []agentproto.TranscriptEvent
			for _, ev := range full.Events {
				if ev.Seq >= from {
					want = append(want, ev)
				}
			}
			if !reflect.DeepEqual(seqs(got.Events), seqs(want)) {
				t.Errorf("%s from line %d: seqs %v, want %v", filepath.Base(file), i, seqs(got.Events), seqs(want))
			} else {
				sameEvents(t, fmt.Sprintf("%s from line %d", filepath.Base(file), i), plainEvents(t, got.Events), plainEvents(t, want))
			}
			off += int64(len(l)) + 1
		}
	}
}

func seqs(evs []agentproto.TranscriptEvent) []uint64 {
	out := []uint64{}
	for _, ev := range evs {
		out = append(out, ev.Seq)
	}
	return out
}

// withoutUsage leaves out usage updates: of the lines of one message, each
// page reports the usage once.
func withoutUsage(t testing.TB, evs []agentproto.TranscriptEvent) []any {
	var out []agentproto.TranscriptEvent
	for _, ev := range evs {
		if !bytes.Contains(ev.Update, []byte(`"usage_update"`)) {
			out = append(out, ev)
		}
	}
	return plainEvents(t, out)
}

// Read in small pages, forward from each page's Next or back from each
// page's First, a vector gives the same events as in one page.
func TestVectorsInPages(t *testing.T) {
	for _, file := range vectorFiles(t) {
		v := readVector(t, file)
		data := v.content()
		full := read(t, v.Kind, data, agentproto.TranscriptRef{}, Limits{})
		for _, size := range []int{1500, 3000, 8000} {
			lim := Limits{Bytes: size}
			name := fmt.Sprintf("%s in pages of %d", filepath.Base(file), size)
			var fwd []agentproto.TranscriptEvent
			ref := agentproto.TranscriptRef{}
			for n := 0; ; n++ {
				if n > 1000 {
					t.Fatalf("%s: no end", name)
				}
				p := read(t, v.Kind, data, ref, lim)
				if len(p.Events) > 1 && encodedSize(t, p) > size {
					t.Errorf("%s: a page of %d bytes", name, encodedSize(t, p))
				}
				fwd = append(fwd, p.Events...)
				if !p.More {
					break
				}
				if p.Next <= ref.From {
					t.Fatalf("%s: next %d after %d", name, p.Next, ref.From)
				}
				ref.From = p.Next
			}
			sameEvents(t, name+" forward", withoutUsage(t, fwd), withoutUsage(t, full.Events))
			var pages [][]agentproto.TranscriptEvent
			ref = agentproto.TranscriptRef{Back: true}
			for n := 0; ; n++ {
				if n > 1000 {
					t.Fatalf("%s: no start", name)
				}
				p := read(t, v.Kind, data, ref, lim)
				pages = append(pages, p.Events)
				if !p.More {
					break
				}
				if ref.From != 0 && p.First >= ref.From {
					t.Fatalf("%s: first %d before %d", name, p.First, ref.From)
				}
				ref.From = p.First
			}
			slices.Reverse(pages)
			sameEvents(t, name+" back", withoutUsage(t, slices.Concat(pages...)), withoutUsage(t, full.Events))
		}
	}
}

func encodedSize(t testing.TB, tail agentproto.TranscriptTail) int {
	b, err := json.Marshal(tail)
	if err != nil {
		t.Fatal(err)
	}
	return len(b)
}

func TestVectorNames(t *testing.T) {
	for _, file := range vectorFiles(t) {
		v := readVector(t, file)
		if v.Note == "" || formats[v.Kind] == nil || len(v.Lines) == 0 {
			t.Errorf("%s: a vector has a note, a kind and lines", file)
		}
		if strings.ContainsAny(filepath.Base(file), " ") {
			t.Errorf("%s: a name without spaces", file)
		}
	}
}
