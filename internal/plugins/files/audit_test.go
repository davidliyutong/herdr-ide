package files

import (
	"fmt"
	"testing"

	"herdr-ide/internal/plugin"
)

// A change's audit record names the paths it acts on, at most
// maxAuditPaths of them with their count.
func TestAuditTargets(t *testing.T) {
	c := &plugin.Call{}
	auditTargets(c, params{Path: "/a", To: "/b"})
	if f := c.AuditFields(); f["path"] != "/a" || f["to"] != "/b" || f["paths"] != nil {
		t.Fatalf("rename %v", f)
	}
	c = &plugin.Call{}
	var many []string
	for i := 0; i < 60; i++ {
		many = append(many, fmt.Sprintf("/d/%d", i))
	}
	auditTargets(c, params{Paths: many, Dir: "/to"})
	f := c.AuditFields()
	if len(f["paths"].([]string)) != maxAuditPaths || f["count"] != 60 || f["dir"] != "/to" {
		t.Fatalf("copy %v", f)
	}
}
