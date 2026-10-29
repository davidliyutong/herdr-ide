package main

import (
	"testing"

	"webherdr/internal/machines"
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
}
