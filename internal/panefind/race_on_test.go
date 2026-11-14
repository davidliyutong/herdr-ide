//go:build race

package panefind

// slowdown is how much slower code runs under the race detector, for the
// tests that time it.
const slowdown = 20
