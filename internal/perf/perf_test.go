package perf

import "testing"

func TestSample(t *testing.T) {
	a := Sample()
	if a.Memory == 0 || a.Goroutines < 1 || a.CPUs < 1 || a.CPUMs < 0 || a.UptimeMs < 0 {
		t.Fatalf("sample: %+v", a)
	}
	// Work shows as processor time that does not go back.
	x := 0
	for i := 0; i < 50_000_000; i++ {
		x += i % 7
	}
	_ = x
	b := Sample()
	if b.CPUMs < a.CPUMs || b.UptimeMs < a.UptimeMs {
		t.Fatalf("time went back: %+v then %+v", a, b)
	}
}
