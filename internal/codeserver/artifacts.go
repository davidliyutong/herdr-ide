package codeserver

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"herdr-ide/internal/brand"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Artifacts (code-server tarballs, extension VSIXs) are resolved on the core
// host only, then pushed to machines through the agent, so machines never
// need internet access. Resolution order:
//
//  1. SeedDirs: directories prepared for air-gapped installs
//     (see `fetch-assets`), searched in order;
//  2. CacheDir: previous downloads;
//  3. download from TarballURL/ExtensionURL, unless Offline.
//
// Every artifact is verified against a SHA-256: the pinned table below for
// the default versions, else a "<file>.sha256" sidecar next to it. A
// download without either is accepted once (trust on first use) and its
// digest recorded as a sidecar.

// DefaultTarballURL is the code-server release download template.
const DefaultTarballURL = "https://github.com/coder/code-server/releases/download/v{version}/{file}"

// DefaultExtensionURL is the Open VSX download template.
const DefaultExtensionURL = "https://open-vsx.org/api/{publisher}/{name}/{version}/file/{file}"

// Extension is a marketplace extension installed into code-server.
type Extension struct {
	ID      string // publisher.name
	Version string
}

// File returns the VSIX file name.
func (e Extension) File() string { return e.ID + "-" + e.Version + ".vsix" }

// DefaultExtensions are installed on every machine.
var DefaultExtensions = []Extension{{ID: "mhutchie.git-graph", Version: "1.30.0"}}

// pinned holds known-good digests for the default versions. Update it
// together with DefaultVersion / DefaultExtensions (digests from the GitHub
// release API "digest" field and a verified Open VSX download).
var pinned = map[string]string{
	"code-server-4.144.0-linux-amd64.tar.gz": "710f749c40a0f3d0ab3be09c0de65314e5c2907cc50646f5fbc0f24c0e8fba2d",
	"code-server-4.144.0-linux-arm64.tar.gz": "4404c784f541bd56a2a8d6e2a9474ed0b4e37bc8502aa3a247898ca933434482",
	"code-server-4.144.0-macos-amd64.tar.gz": "cb03ed6ce12136f9f9d6f32fd5d780b991d96cf0dd1b3d590c16d73accc665c9",
	"code-server-4.144.0-macos-arm64.tar.gz": "ebd78e944b9e918c0a1ca4239688c0e7a27096955dbf8ea98c3cad9668bc4fcc",
	"mhutchie.git-graph-1.30.0.vsix":         "a6baa3d5b6231035431d6338286e4de7e25ee214b58edee1c7e2c9423bdb552f",
}

// ErrMissingArtifact is returned in offline mode when a file is not seeded.
var ErrMissingArtifact = errors.New("artifact not available offline")

// TarballFile names the code-server release tarball for an asset
// ("linux-amd64", "macos-arm64", ...).
func TarballFile(version, asset string) string {
	return fmt.Sprintf("code-server-%s-%s.tar.gz", version, asset)
}

func expandURL(tmpl string, vars map[string]string) string {
	for k, v := range vars {
		tmpl = strings.ReplaceAll(tmpl, "{"+k+"}", v)
	}
	return tmpl
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// expectedSHA returns the digest a file must have, from the pinned table or
// a sidecar in dir; "" when unknown.
func expectedSHA(dir, file string) string {
	if s, ok := pinned[file]; ok {
		return s
	}
	b, err := os.ReadFile(filepath.Join(dir, file+".sha256"))
	if err != nil {
		return ""
	}
	// Accept "sha256sum" output ("<hex>  <file>") as well as a bare digest.
	return strings.ToLower(strings.Fields(string(b) + " ")[0])
}

func verify(path, want string) error {
	if want == "" {
		return nil
	}
	got, err := fileSHA256(path)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("%s: sha256 %s does not match expected %s", filepath.Base(path), got, want)
	}
	return nil
}

// artifact returns a verified local path for file, downloading from url if
// allowed. progress receives download progress.
func (mg *Manager) artifact(ctx context.Context, file, url string, progress func(done, total int64)) (string, error) {
	mg.dl.Lock()
	defer mg.dl.Unlock()
	for _, dir := range append(append([]string(nil), mg.SeedDirs...), mg.CacheDir) {
		p := filepath.Join(dir, file)
		if _, err := os.Stat(p); err != nil {
			continue
		}
		want := expectedSHA(dir, file)
		if err := verify(p, want); err != nil {
			if dir == mg.CacheDir && !mg.Offline {
				mg.Logger.Printf("discarding corrupt cached %s: %v", file, err)
				os.Remove(p)
				break
			}
			return "", err
		}
		if want == "" {
			mg.Logger.Printf("warning: %s has no pinned checksum or .sha256 sidecar; using it unverified", p)
		}
		return p, nil
	}
	if mg.Offline {
		return "", fmt.Errorf("%w: put %s into %s (create it with `fetch-assets` on a connected machine)",
			ErrMissingArtifact, file, strings.Join(append(append([]string(nil), mg.SeedDirs...), mg.CacheDir), " or "))
	}
	if err := os.MkdirAll(mg.CacheDir, 0o755); err != nil {
		return "", err
	}
	mg.Logger.Printf("downloading %s", url)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := (&http.Client{Timeout: 30 * time.Minute}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	tmp, err := os.CreateTemp(mg.CacheDir, ".dl-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	total := resp.ContentLength
	var done int64
	buf := make([]byte, 256<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, err := tmp.Write(buf[:n]); err != nil {
				tmp.Close()
				return "", err
			}
			h.Write(buf[:n])
			done += int64(n)
			if progress != nil {
				progress(done, total)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			tmp.Close()
			return "", rerr
		}
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if want := expectedSHA(mg.CacheDir, file); want != "" && got != want {
		return "", fmt.Errorf("%s: downloaded sha256 %s does not match expected %s", file, got, want)
	} else if want == "" {
		mg.Logger.Printf("warning: no pinned checksum for %s; recorded sha256 %s (trust on first use)", file, got)
	}
	path := filepath.Join(mg.CacheDir, file)
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", err
	}
	_ = os.WriteFile(path+".sha256", []byte(got+"  "+file+"\n"), 0o644)
	return path, nil
}

func (mg *Manager) tarball(ctx context.Context, asset string, progress func(done, total int64)) (string, error) {
	file := TarballFile(mg.Version, asset)
	url := expandURL(mg.TarballURL, map[string]string{"version": mg.Version, "asset": asset, "file": file})
	return mg.artifact(ctx, file, url, progress)
}

func (mg *Manager) extension(ctx context.Context, e Extension) (string, error) {
	publisher, name, ok := strings.Cut(e.ID, ".")
	if !ok {
		return "", fmt.Errorf("bad extension id %q", e.ID)
	}
	url := expandURL(mg.ExtensionURL, map[string]string{"publisher": publisher, "name": name, "version": e.Version, "file": e.File()})
	return mg.artifact(ctx, e.File(), url, nil)
}

// AllAssets lists the code-server platform assets herdr-ide can install.
var AllAssets = []string{"linux-amd64", "linux-arm64", "macos-amd64", "macos-arm64"}

// FetchAssets downloads (or verifies) everything needed for the given assets
// into dir, with .sha256 sidecars, for carrying into an air-gapped network.
func (mg *Manager) FetchAssets(ctx context.Context, dir string, assets []string) ([]string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	var files []string
	copyOut := func(src string) error {
		name := filepath.Base(src)
		dst := filepath.Join(dir, name)
		if src != dst {
			if err := copyFile(src, dst); err != nil {
				return err
			}
		}
		sum, err := fileSHA256(dst)
		if err != nil {
			return err
		}
		files = append(files, name)
		return os.WriteFile(dst+".sha256", []byte(sum+"  "+name+"\n"), 0o644)
	}
	for _, a := range assets {
		p, err := mg.tarball(ctx, a, nil)
		if err != nil {
			return files, err
		}
		if err := copyOut(p); err != nil {
			return files, err
		}
	}
	for _, e := range mg.Extensions {
		p, err := mg.extension(ctx, e)
		if err != nil {
			return files, err
		}
		if err := copyOut(p); err != nil {
			return files, err
		}
	}
	return files, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// RemoveLegacyCaches deletes download caches left under previous product
// names (brand.LegacySlugs).
func (mg *Manager) RemoveLegacyCaches() {
	cache, err := os.UserCacheDir()
	if err != nil {
		return
	}
	for _, old := range brand.LegacySlugs {
		dir := filepath.Join(cache, old)
		if _, err := os.Stat(dir); err == nil {
			mg.Logger.Printf("removing legacy cache %s", dir)
			os.RemoveAll(dir)
		}
	}
}

// vsixContentHash identifies a VSIX by the names and contents of its files,
// ignoring zip metadata such as timestamps, so a rebuilt but identical
// extension is not reinstalled on every machine.
func vsixContentHash(b []byte) string {
	h := sha256.New()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		h.Write(b)
		return hex.EncodeToString(h.Sum(nil))[:16]
	}
	files := append([]*zip.File(nil), zr.File...)
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	for _, f := range files {
		rc, err := f.Open()
		if err != nil {
			continue
		}
		h.Write([]byte(f.Name + "\x00"))
		io.Copy(h, rc)
		rc.Close()
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}
