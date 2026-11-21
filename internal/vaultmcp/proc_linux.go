package vaultmcp

import "syscall"

// parentDeathSignal has the kernel kill the command's shell when the server
// dies, however it dies; the rest of its group is the watcher's
// (watcherScript).
func parentDeathSignal(a *syscall.SysProcAttr) { a.Pdeathsig = syscall.SIGKILL }
