package agentproto

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestReadLineLeavesFollowingBytes(t *testing.T) {
	r := strings.NewReader("{\"op\":\"herdr-client\",\"session\":\"s\"}\nRAW-BYTES")
	var h Header
	if err := ReadLine(r, &h); err != nil {
		t.Fatal(err)
	}
	if h.Op != OpHerdrClient || h.Session != "s" {
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
