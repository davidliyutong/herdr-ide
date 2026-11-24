//go:build !machine

package main

import (
	"testing"

	"veldr/internal/machines"
)

func TestSelectSpecsDedup(t *testing.T) {
	specs := []machines.Spec{
		{ID: "local", Label: "mac (local)", Kind: machines.KindLocal},
		{ID: "a1", Label: "gpu", Target: "gpu.example.com"},
		{ID: "b2", Label: "robot", Target: "robot"},
		{ID: "x", Label: "x", Target: "x"},
	}
	got := selectSpecs(specs, false, nil, []string{"a1", "gpu", "gpu.example.com", "local"})
	if len(got) != 2 || got[0].ID != "local" || got[1].ID != "a1" {
		t.Fatalf("--machine selection = %+v", got)
	}
	got = selectSpecs(specs, true, []string{"x", "x"}, nil)
	if len(got) != 2 || got[1].ID != "x" {
		t.Fatalf("--local-only with --ssh = %+v", got)
	}
	// One machine at a time is taken the same way.
	if selectSpec(specs[2], false, true, nil, nil) || !selectSpec(specs[2], false, false, nil, nil) ||
		!selectSpec(specs[1], false, false, nil, []string{"gpu"}) || selectSpec(specs[2], false, false, nil, []string{"gpu"}) {
		t.Fatal("selectSpec disagrees with --local-only or --machine")
	}
}
