// Package hcdist describes the upstream herdr-core executables the core
// embeds for machines. Downloads are verified at build time only.
package hcdist

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"

	"herdr-ide/internal/checksum"
)

const Version = "0.1.21"

const (
	// Executable, License and Notices are the archive members the build uses;
	// they sit at the archive's root.
	Executable = "herdr-core"
	License    = "LICENSE"
	Notices    = "THIRD-PARTY-NOTICES"

	// MaxExecutable bounds the executable (releases are about 8 MB); the
	// agent accepts uploads up to the same size.
	MaxExecutable = 64 << 20
	// MaxNotice bounds a license or notices file (upstream's notices are
	// about 1 MB).
	MaxNotice = 16 << 20
)

// Artifact is a release archive. Names use upstream's OS and architecture
// vocabulary, not Go's.
type Artifact struct {
	Name   string
	SHA256 string
}

// These digests are those of the archives published for the release.
var artifacts = map[string]Artifact{
	"linux/amd64":  {"herdr-core-linux-x86_64.tar.gz", "78424755c10a40dde38a0bdb55c20ac19706e9ae05ed68fc2acf1fcff0d941c1"},
	"linux/arm64":  {"herdr-core-linux-aarch64.tar.gz", "e844a2bfab48a226097679d076bc83042fe57fccef5387ef802e5b24e78b529a"},
	"darwin/amd64": {"herdr-core-macos-x86_64.tar.gz", "e377e1d342cddce0346da5b2f3c281b9701e4731c00024c7c5028265e77a217f"},
	"darwin/arm64": {"herdr-core-macos-aarch64.tar.gz", "1ab38dd9270f63a8f794d6d60e8702eb0d1c85a72bda85d735e5eea43f05ffed"},
}

func ForPlatform(platform string) (Artifact, error) {
	a, ok := artifacts[platform]
	if !ok {
		return Artifact{}, fmt.Errorf("unsupported herdr-core platform %q (linux/darwin on amd64/arm64)", platform)
	}
	return a, nil
}

func (a Artifact) URL() string {
	return "https://releases.herdr.dev/core/" + Version + "/" + a.Name
}

// Verify checks a downloaded archive against the pinned digest.
func (a Artifact) Verify(path string) error {
	return checksum.Verify(path, a.SHA256)
}

// Extract returns the member name at the root of the archive at archivePath,
// which must have the pinned digest. The member must be one regular file of
// at most limit bytes: a link, a directory, a second entry of that name or a
// larger file fails, and nothing is written to disk.
func (a Artifact) Extract(archivePath, name string, limit int64) ([]byte, error) {
	data, err := os.ReadFile(archivePath)
	if err != nil {
		return nil, err
	}
	// The digest is checked on the bytes that are then unpacked, so a file
	// replaced between a check and a second read cannot pass.
	sum := sha256.Sum256(data)
	if got := hex.EncodeToString(sum[:]); got != a.SHA256 {
		return nil, fmt.Errorf("%s: sha256 %s does not match expected %s", path.Base(archivePath), got, a.SHA256)
	}
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", a.Name, err)
	}
	tr := tar.NewReader(zr)
	var out []byte
	found := false
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", a.Name, err)
		}
		if path.Clean(h.Name) != name {
			continue
		}
		if found {
			return nil, fmt.Errorf("%s: more than one %s", a.Name, name)
		}
		if h.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("%s: %s is not a regular file", a.Name, name)
		}
		if h.Size > limit {
			return nil, fmt.Errorf("%s: %s is larger than %d bytes", a.Name, name, limit)
		}
		out, err = io.ReadAll(io.LimitReader(tr, limit+1))
		if err != nil {
			return nil, fmt.Errorf("%s: %s: %w", a.Name, name, err)
		}
		if int64(len(out)) > limit {
			return nil, fmt.Errorf("%s: %s is larger than %d bytes", a.Name, name, limit)
		}
		found = true
	}
	if !found {
		return nil, fmt.Errorf("%s: no %s", a.Name, name)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: %s is empty", a.Name, name)
	}
	return out, nil
}
