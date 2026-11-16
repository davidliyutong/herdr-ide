//go:build unix

package files

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// removeTree removes a tree as os.RemoveAll does: directories of more
// entries than one read takes, links removed and never followed.
func TestRemoveTree(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(root, "outside")
	os.MkdirAll(outside, 0o755)
	write(t, filepath.Join(outside, "keep"), "k")
	tree := filepath.Join(root, "tree")
	os.MkdirAll(filepath.Join(tree, "a", "b"), 0o755)
	for i := 0; i < 2500; i++ {
		write(t, filepath.Join(tree, "a", fmt.Sprintf("f%d", i)), "x")
	}
	write(t, filepath.Join(tree, "a", "b", "deep"), "d")
	os.Symlink(outside, filepath.Join(tree, "link"))
	os.Symlink(outside, filepath.Join(tree, "a", "b", "link"))
	if err := removeTree(context.Background(), tree); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(tree); !os.IsNotExist(err) {
		t.Fatalf("tree still there: %v", err)
	}
	if read(t, filepath.Join(outside, "keep")) != "k" {
		t.Fatal("followed a link")
	}
	// A file and a link alone.
	f := filepath.Join(root, "f")
	write(t, f, "f")
	l := filepath.Join(root, "l")
	os.Symlink(outside, l)
	if removeTree(context.Background(), f) != nil || removeTree(context.Background(), l) != nil {
		t.Fatal("file or link")
	}
	if _, err := os.Lstat(outside); err != nil {
		t.Fatal("removed a link's target")
	}
}

// A removal or copy the core gave up on stops before the next entry or
// chunk.
func TestRemoveAndCopyStopWhenCancelled(t *testing.T) {
	root := t.TempDir()
	tree := filepath.Join(root, "tree")
	os.MkdirAll(filepath.Join(tree, "sub"), 0o755)
	write(t, filepath.Join(tree, "sub", "f"), strings.Repeat("x", 3<<20))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := removeTree(ctx, tree); !errors.Is(err, context.Canceled) {
		t.Fatalf("remove: %v", err)
	}
	if read(t, filepath.Join(tree, "sub", "f")) == "" {
		t.Fatal("removed after the cancel")
	}
	if _, err := copyTree(ctx, tree, filepath.Join(root, "copy")); !errors.Is(err, context.Canceled) {
		t.Fatalf("copy: %v", err)
	}
	if err := copyFile(ctx, filepath.Join(tree, "sub", "f"), filepath.Join(root, "one"), 0o644); !errors.Is(err, context.Canceled) {
		t.Fatalf("copy a file: %v", err)
	}
	// Through the guard, as the action runs it.
	env := testEnv(t)
	d := filepath.Join(env.Home, "d")
	os.MkdirAll(filepath.Join(d, "x"), 0o755)
	g := guard{env: env}
	if _, err := g.remove(ctx, d); err == nil {
		t.Fatal("guard's remove ran cancelled")
	}
	if _, err := os.Stat(filepath.Join(d, "x")); err != nil {
		t.Fatal("removed after the cancel")
	}
}
