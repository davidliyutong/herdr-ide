// Package checksum computes and checks SHA-256 digests of downloaded files.
package checksum

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// File returns the lowercase hex SHA-256 digest of the file at path.
func File(path string) (string, error) {
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

// Verify fails unless the file at path has the digest want.
func Verify(path, want string) error {
	got, err := File(path)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("%s: sha256 %s does not match expected %s", filepath.Base(path), got, want)
	}
	return nil
}
