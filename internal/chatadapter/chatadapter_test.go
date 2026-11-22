package chatadapter

import (
	"context"
	"slices"
	"strconv"
	"strings"
	"testing"

	"herdr-ide/internal/chatproto"
)

type fakeAdapter struct{ name string }

func (fakeAdapter) Start(context.Context, StartParams, Sink) (Session, error) { return nil, nil }
func (fakeAdapter) Sessions(context.Context, SessionsParams) ([]chatproto.Session, string, error) {
	return nil, "", nil
}
func (fakeAdapter) History(context.Context, HistoryParams, func(chatproto.Event)) error { return nil }

func panics(f func()) (did bool) {
	defer func() { did = recover() != nil }()
	f()
	return false
}

// runs numbers the test's runs (go test -count): a name is registered once
// per process.
var runs int

func TestRegistry(t *testing.T) {
	runs++
	name := "test-" + strconv.Itoa(runs)
	a := fakeAdapter{"one"}
	Register(name, a)
	if got, ok := Lookup(name); !ok || got != a {
		t.Fatalf("Lookup = %v, %v", got, ok)
	}
	if _, ok := Lookup("test-none"); ok {
		t.Error("an adapter nobody registered")
	}
	if !slices.Contains(Names(), name) || !slices.IsSorted(Names()) {
		t.Errorf("names %v", Names())
	}
	if !panics(func() { Register(name, fakeAdapter{"two"}) }) {
		t.Error("a name registered twice")
	}
	if !panics(func() { Register("", a) }) || !panics(func() { Register("test-nil", nil) }) {
		t.Error("an adapter without a name, or none")
	}
	if got, _ := Lookup(name); got != a {
		t.Error("a refused registration replaced the adapter")
	}
}

// The options the host shows for agents without their own are the
// protocol's kinds of options, and a plan's approval names a mode.
func TestOptions(t *testing.T) {
	if OptionAllowOnce != chatproto.AllowOnce || OptionRejectOnce != chatproto.RejectOnce || OptionAllowSession != "allow_session" {
		t.Error("the host's permission options changed")
	}
	for _, m := range chatproto.Modes {
		if o := PlanOption(m); o != "plan:"+m || !strings.HasPrefix(o, OptionPlanPrefix) {
			t.Errorf("PlanOption(%s) = %s", m, o)
		}
	}
}
