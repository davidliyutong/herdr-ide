//go:build machine

package main

// A machine build has no server: with no command it prints the usage.
const (
	defaultCommand = ""
	coreUsage      = ""
)

func coreCommand(string, []string) bool { return false }
