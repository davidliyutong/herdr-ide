package agentproto

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestReadLineLeavesFollowingBytes(t *testing.T) {
	r := strings.NewReader("{\"op\":\"hc-api\",\"path\":\"p\"}\nRAW-BYTES")
	var h Header
	if err := ReadLine(r, &h); err != nil {
		t.Fatal(err)
	}
	if h.Op != OpHCAPI || h.Path != "p" {
		t.Fatalf("header = %+v", h)
	}
	rest, _ := io.ReadAll(r)
	if string(rest) != "RAW-BYTES" {
		t.Fatalf("rest = %q", rest)
	}
}

func TestChunkRoundTrip(t *testing.T) {
	payload := bytes.Repeat([]byte("herdr-ide-"), 300000) // > 1 MiB, several chunks
	var buf bytes.Buffer
	cw := ChunkWriter{W: &buf}
	if _, err := cw.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := cw.Finish(); err != nil {
		t.Fatal(err)
	}
	buf.WriteString("{\"ok\":true}\n") // a reply may follow the stream
	cr := &ChunkReader{R: &buf}
	got, err := io.ReadAll(cr)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload mismatch: %d vs %d bytes", len(got), len(payload))
	}
	var rep Reply
	if err := ReadLine(&buf, &rep); err != nil || !rep.OK {
		t.Fatalf("reply after chunks: %+v %v", rep, err)
	}
}

func TestChunkReaderTruncated(t *testing.T) {
	cr := &ChunkReader{R: bytes.NewReader([]byte{0, 0, 0, 10, 'a', 'b'})}
	if _, err := io.ReadAll(cr); err == nil {
		t.Fatal("expected error for truncated chunk")
	}
}

// A body follows its line: read in full, bounded, the bytes after it left.
func TestReadBody(t *testing.T) {
	r := strings.NewReader("{\"op\":\"plugin\",\"params_length\":7}\n{\"a\":1}REST")
	var h Header
	if err := ReadLine(r, &h); err != nil || h.ParamsLength != 7 {
		t.Fatalf("header %+v %v", h, err)
	}
	b, err := ReadBody(r, h.ParamsLength)
	if err != nil || string(b) != `{"a":1}` {
		t.Fatalf("body %q %v", b, err)
	}
	if rest, _ := io.ReadAll(r); string(rest) != "REST" {
		t.Fatalf("rest %q", rest)
	}
	if _, err := ReadBody(strings.NewReader("{}"), 5); err == nil {
		t.Error("a short body was read")
	}
	if _, err := ReadBody(strings.NewReader(""), MaxBody+1); err == nil {
		t.Error("a body over MaxBody was read")
	}
}
