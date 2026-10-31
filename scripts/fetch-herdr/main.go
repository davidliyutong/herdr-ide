// Fetch the pinned upstream binaries for the requested Go platforms.
package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"herdr-ide/internal/herdrdist"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(platforms []string) error {
	if len(platforms) == 0 {
		return fmt.Errorf("usage: go run ./scripts/fetch-herdr OS/ARCH ...")
	}
	for _, p := range platforms {
		if _, err := herdrdist.ForPlatform(p); err != nil {
			return err
		}
	}
	for _, p := range platforms {
		a, _ := herdrdist.ForPlatform(p)
		path := filepath.Join("dist", "herdr", "herdr-"+strings.ReplaceAll(p, "/", "-"))
		if err := fetch(a, path); err != nil {
			return err
		}
		fmt.Printf("    herdr %s %s (verified)\n", herdrdist.Version, p)
	}
	return nil
}

func fetch(a herdrdist.Artifact, path string) error {
	if a.Verify(path) == nil {
		return os.Chmod(path, 0o755)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".herdr-download-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	resp, err := (&http.Client{Timeout: 5 * time.Minute}).Get(a.URL())
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", a.URL(), resp.Status)
	}
	if _, err := io.Copy(f, io.LimitReader(resp.Body, 128<<20)); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := a.Verify(f.Name()); err != nil {
		return err
	}
	if err := os.Chmod(f.Name(), 0o755); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
