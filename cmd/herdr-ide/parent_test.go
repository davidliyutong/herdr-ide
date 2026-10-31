package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

func TestStopWithParent(t *testing.T) {
	for _, broken := range []bool{false, true} {
		r, w := io.Pipe()
		ctx, cancel := context.WithCancel(context.Background())
		go stopWithParent(r, cancel)
		if _, err := w.Write([]byte("ignored\n")); err != nil {
			t.Fatal(err)
		}
		if ctx.Err() != nil {
			t.Fatal("parent bytes must not stop the server")
		}
		if broken {
			w.CloseWithError(errors.New("parent crashed"))
		} else {
			w.Close()
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
			t.Fatal("server did not stop after parent pipe closed")
		}
		r.Close()
		cancel()
	}
}

func TestWriteReady(t *testing.T) {
	var out bytes.Buffer
	if err := writeReady(&out, "127.0.0.1:7781"); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "{\"event\":\"ready\",\"url\":\"http://127.0.0.1:7781\"}\n"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	r, w := io.Pipe()
	r.Close()
	defer w.Close()
	if err := writeReady(w, "127.0.0.1:7781"); err == nil {
		t.Fatal("lost launcher must be reported")
	}
}
