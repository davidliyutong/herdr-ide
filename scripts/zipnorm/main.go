// Command zipnorm rewrites a zip archive with sorted entries and a fixed
// modification time, so that packaging the same files twice gives identical
// bytes (used for the VS Code bridge VSIX embedded in the core binary).
//
//	go run ./scripts/zipnorm FILE
package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"sort"
	"time"
)

var epoch = time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: zipnorm FILE")
		os.Exit(2)
	}
	if err := normalize(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, "zipnorm:", err)
		os.Exit(1)
	}
}

func normalize(path string) error {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer zr.Close()
	files := append([]*zip.File(nil), zr.File...)
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		h := &zip.FileHeader{Name: f.Name, Method: f.Method, Modified: epoch}
		h.SetMode(f.Mode())
		w, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		_, err = io.Copy(w, rc)
		rc.Close()
		if err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}
