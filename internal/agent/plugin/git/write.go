//go:build unix

package git

import (
	"context"
	"strings"

	"herdr-ide/internal/agent/plugin"
)

// Done answers a change: what git printed.
type Done struct {
	Output string `json:"output,omitempty"`
}

// change runs a change: its runs of git, in order, each an argument
// vector built from checked values; the first that fails ends it.
func (r *repo) change(ctx context.Context, action string, p Params) (*Done, error) {
	runs, err := r.runs(ctx, action, p)
	if err != nil {
		return nil, err
	}
	var out strings.Builder
	for _, rn := range runs {
		if rn.timeout == 0 {
			rn.timeout = NetTimeout
		}
		res, err := r.git(ctx, rn)
		if err != nil {
			return nil, err
		}
		if out.Len() < 4000 {
			out.WriteString(strings.TrimSpace(string(res.out) + "\n" + string(res.err)))
			out.WriteString("\n")
		}
	}
	s := strings.TrimSpace(out.String())
	if len(s) > 4000 {
		s = s[:4000] + "…"
	}
	return &Done{Output: s}, nil
}

// runs builds the runs of a change: the paths of stage, unstage and
// discard as literal pathspecs, over several runs when there are many
// (pathRuns); every other change is one run (argv).
func (r *repo) runs(ctx context.Context, action string, p Params) ([]run, error) {
	paths := func(ps []string) ([]string, error) {
		c, err := cleanPaths(ps)
		if err == nil && len(c) == 0 {
			err = plugin.Errorf("bad_params", "no paths")
		}
		return c, err
	}
	switch action {
	case "stage":
		if p.All {
			if p.Tracked {
				// The tracked files' changes only (Changes while untracked
				// files are shown apart).
				return []run{{args: []string{"add", "--update"}}}, nil
			}
			return []run{{args: []string{"add", "--all"}}}, nil
		}
		ps, err := paths(p.Paths)
		if err != nil {
			return nil, err
		}
		return pathRuns([]string{"add", "--all"}, ps), nil

	case "unstage":
		var ps []string
		if !p.All {
			var err error
			if ps, err = paths(p.Paths); err != nil {
				return nil, err
			}
		}
		if !r.hasHead(ctx) {
			// Before the first commit nothing is in HEAD to restore: the
			// index loses the paths (-f also those changed since they
			// were staged; the working tree keeps them).
			if p.All {
				return []run{{args: []string{"rm", "--cached", "-r", "-f", "-q", "--", "."}}}, nil
			}
			return pathRuns([]string{"rm", "--cached", "-r", "-f", "-q"}, ps), nil
		}
		if p.All {
			return []run{{args: []string{"reset", "-q", "HEAD", "--"}}}, nil
		}
		return pathRuns([]string{"restore", "--staged"}, ps), nil

	case "discard":
		tracked, err := cleanPaths(p.Paths)
		if err != nil {
			return nil, err
		}
		untracked, err := cleanPaths(p.Untracked)
		if err != nil {
			return nil, err
		}
		if len(tracked)+len(untracked) == 0 {
			return nil, plugin.Errorf("bad_params", "no paths")
		}
		if len(tracked)+len(untracked) > maxPaths {
			return nil, plugin.Errorf("bad_params", "at most %d paths", maxPaths)
		}
		// clean removes untracked files only, never a tracked one (nor an
		// untracked repository: that needs a second -f).
		return append(pathRuns([]string{"clean", "-f", "-q"}, untracked), pathRuns([]string{"restore", "--worktree"}, tracked)...), nil
	}
	rn, err := r.argv(ctx, action, p)
	if err != nil {
		return nil, err
	}
	return []run{rn}, nil
}

// argv builds the run of a change without paths. Values from the request
// are checked: revisions and names never start with "-", and no option is
// taken from the request.
func (r *repo) argv(ctx context.Context, action string, p Params) (run, error) {
	if build := argvBuilders[action]; build != nil {
		return build(r, ctx, action, p)
	}
	return run{}, plugin.Errorf("bad_params", "unknown action %q", action)
}

// hasHead reports whether HEAD names a commit (not before the first one).
func (r *repo) hasHead(ctx context.Context) bool {
	res, err := r.git(ctx, run{args: []string{"rev-parse", "-q", "--verify", "HEAD"}, ok: []int{1, 128}})
	return err == nil && res.code == 0
}
