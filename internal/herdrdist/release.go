// Package herdrdist describes the upstream herdr executables that release
// archives ship beside the core. Downloads are verified at build time only.
package herdrdist

import (
	"fmt"

	"herdr-ide/internal/checksum"
)

const Version = "0.9.5"

// Artifact names use upstream's OS and architecture vocabulary, not Go's.
type Artifact struct {
	Name   string
	SHA256 string
}

// These digests come from the immutable upstream GitHub release asset metadata.
var artifacts = map[string]Artifact{
	"linux/amd64":  {"herdr-linux-x86_64", "14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d"},
	"linux/arm64":  {"herdr-linux-aarch64", "17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c"},
	"darwin/amd64": {"herdr-macos-x86_64", "5fb0a908ec7f6745e3e245738b06bfad56c46391c391ab3c0955fbead01f1369"},
	"darwin/arm64": {"herdr-macos-aarch64", "fb77c2232a05a8035421382c894392f4174e4e38a18e48af3dd0290157c3a7e2"},
}

func ForPlatform(platform string) (Artifact, error) {
	a, ok := artifacts[platform]
	if !ok {
		return Artifact{}, fmt.Errorf("unsupported herdr platform %q (linux/darwin on amd64/arm64)", platform)
	}
	return a, nil
}

func (a Artifact) URL() string {
	return "https://github.com/herdrdev/herdr/releases/download/v" + Version + "/" + a.Name
}

// Verify checks a downloaded file against the pinned digest.
func (a Artifact) Verify(path string) error {
	return checksum.Verify(path, a.SHA256)
}
