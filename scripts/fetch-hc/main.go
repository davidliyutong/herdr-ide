// Fetch the pinned upstream herdr-core for the requested Go platforms and
// write the executables, gzip-compressed, where the core embeds them. The
// downloaded executables are never run.
//
//	go run ./scripts/fetch-hc linux/amd64 darwin/arm64 …
//	go run ./scripts/fetch-hc -exe FILE OS/ARCH
//
// -exe writes one platform's verified executable to FILE instead, as is
// (for the integration tests' HC_TEST_BIN: make it in CI); nothing is
// embedded.
package main

import (
	"bytes"
	"compress/gzip"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"herdr-ide/internal/hcdist"
)

const (
	cacheDir   = "dist/hc"
	licenseDir = "dist/hc/licenses"
	embedDir   = "internal/embedded/hc"
	// maxArchive bounds a download (release archives are about 8 MB).
	maxArchive = 128 << 20
)

func main() {
	exe := flag.String("exe", "", "write the executable of the one platform given to this file instead of embedding")
	flag.Parse()
	var err error
	if *exe != "" {
		err = writeExecutable(*exe, flag.Args())
	} else {
		err = run(flag.Args())
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// writeExecutable fetches the archive of the one platform given and writes
// its verified executable to path (mode 0755).
func writeExecutable(path string, platforms []string) error {
	if len(platforms) != 1 {
		return fmt.Errorf("usage: go run ./scripts/fetch-hc -exe FILE OS/ARCH")
	}
	a, err := hcdist.ForPlatform(platforms[0])
	if err != nil {
		return err
	}
	archive := filepath.Join(cacheDir, a.Name)
	if err := fetch(a, archive); err != nil {
		return err
	}
	bin, err := a.Extract(archive, hcdist.Executable, hcdist.MaxExecutable)
	if err != nil {
		return err
	}
	if err := writeFile(path, bin); err != nil {
		return err
	}
	if err := os.Chmod(path, 0o755); err != nil {
		return err
	}
	fmt.Printf("    herdr-core %s %s (verified) in %s\n", hcdist.Version, platforms[0], path)
	return nil
}

func run(platforms []string) error {
	if len(platforms) == 0 {
		return fmt.Errorf("usage: go run ./scripts/fetch-hc OS/ARCH ...")
	}
	for _, p := range platforms {
		if _, err := hcdist.ForPlatform(p); err != nil {
			return err
		}
	}
	for i, p := range platforms {
		a, _ := hcdist.ForPlatform(p)
		archive := filepath.Join(cacheDir, a.Name)
		if err := fetch(a, archive); err != nil {
			return err
		}
		bin, err := a.Extract(archive, hcdist.Executable, hcdist.MaxExecutable)
		if err != nil {
			return err
		}
		gz, err := compress(bin)
		if err != nil {
			return err
		}
		out := filepath.Join(embedDir, "hc-"+strings.ReplaceAll(p, "/", "-")+".gz")
		if err := writeFile(out, gz); err != nil {
			return err
		}
		// The license and notices are the same in every archive of a release.
		if i == 0 {
			for _, name := range []string{hcdist.License, hcdist.Notices} {
				text, err := a.Extract(archive, name, hcdist.MaxNotice)
				if err != nil {
					return err
				}
				if err := writeFile(filepath.Join(licenseDir, name), text); err != nil {
					return err
				}
			}
		}
		fmt.Printf("    herdr-core %s %s (verified, %d kB embedded)\n", hcdist.Version, p, len(gz)/1000)
	}
	return nil
}

// fetch downloads the archive to path unless a verified copy is there.
func fetch(a hcdist.Artifact, path string) error {
	if a.Verify(path) == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".hc-download-*")
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
	if _, err := io.Copy(f, io.LimitReader(resp.Body, maxArchive)); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := a.Verify(f.Name()); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// compress returns data as gzip without a name or a time in the header, so
// the same executable always embeds as the same bytes.
func compress(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(data); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// writeFile replaces path with data through a temporary file beside it.
func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".hc-write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(0o644); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
