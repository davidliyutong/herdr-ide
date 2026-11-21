//go:build unix && !linux

package vaultmcp

import "syscall"

// parentDeathSignal does nothing where the kernel has no parent death
// signal (macOS): the watcher (watcherScript) ends the group.
func parentDeathSignal(*syscall.SysProcAttr) {}
