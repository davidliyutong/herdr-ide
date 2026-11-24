//go:build !unix

package main

// The agent runs on Linux and macOS only.
const machineUsage = ""

func machineCommand(string, []string) bool { return false }
