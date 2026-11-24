//go:build unix

package history

import (
	"testing"
	"time"

	"veldr/internal/agent/plugin"
)

// Another core's capture of the data directory stands for this core's for
// captureShare; the same core's, another directory's or an unnamed core's
// does not.
func TestCapturesSharedBetweenCores(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	old := clock
	clock = func() time.Time { return now }
	t.Cleanup(func() { clock = old })
	a := &plugin.Env{Base: "/h/.x", Client: "a"}
	b := &plugin.Env{Base: "/h/.x", Client: "b"}
	other := &plugin.Env{Base: "/h/.y", Client: "b"}
	capturedBy(a)
	if !sharedCapture(b) || sharedCapture(a) || sharedCapture(other) || sharedCapture(&plugin.Env{Base: "/h/.x"}) {
		t.Fatal("shared")
	}
	now = now.Add(captureShare)
	if sharedCapture(b) {
		t.Fatal("still shared after captureShare")
	}
}
