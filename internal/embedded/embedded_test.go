package embedded

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"testing/fstest"
)

func TestHC(t *testing.T) {
	bin := []byte("#!/bin/sh\nexit 0\n")
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(bin)
	zw.Close()
	files := fstest.MapFS{
		"hc/hc-linux-amd64.gz": {Data: buf.Bytes()},
		"hc/hc-linux-arm64.gz": {Data: []byte("not gzip")},
		// A stream cut off before its checksum must not get a digest.
		"hc/hc-darwin-arm64.gz": {Data: buf.Bytes()[:buf.Len()-6]},
	}
	old := hcFS
	hcFS = files
	hcCache = map[string]encoderEntry{}
	t.Cleanup(func() { hcFS = old; hcCache = map[string]encoderEntry{} })

	sum := sha256.Sum256(bin)
	gz, digest, err := HC("linux", "amd64")
	if err != nil || !bytes.Equal(gz, buf.Bytes()) || digest != hex.EncodeToString(sum[:]) {
		t.Fatalf("HC = %d bytes, %q, %v", len(gz), digest, err)
	}
	// The digest is computed once per platform.
	delete(files, "hc/hc-linux-amd64.gz")
	if _, again, err := HC("linux", "amd64"); err != nil || again != digest {
		t.Fatalf("cached HC = %q, %v", again, err)
	}
	for _, arch := range []string{"arm64", "riscv64"} {
		if _, _, err := HC("linux", arch); err == nil {
			t.Fatalf("linux/%s accepted", arch)
		}
	}
	if _, _, err := HC("darwin", "arm64"); err == nil {
		t.Fatal("truncated executable accepted")
	}
}
