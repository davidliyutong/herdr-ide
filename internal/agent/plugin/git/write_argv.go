//go:build unix

package git

import (
	"context"
	"strconv"
	"strings"

	"herdr-ide/internal/agent/plugin"
)

// argvBuilders are the changes without paths, each with what builds its run
// from the action's name and the request's checked values.
var argvBuilders = map[string]func(r *repo, ctx context.Context, action string, p Params) (run, error){
	"applyPatch":   (*repo).argvApplyPatch,
	"commit":       (*repo).argvCommit,
	"checkout":     (*repo).argvCheckout,
	"branchCreate": (*repo).argvBranchCreate,
	"branchDelete": (*repo).argvBranchDelete,
	"branchRename": (*repo).argvBranchRename,
	"merge":        (*repo).argvMerge,
	"rebase":       (*repo).argvRebase,
	"abort":        (*repo).argvOperation,
	"continue":     (*repo).argvOperation,
	"cherryPick":   (*repo).argvPick,
	"revert":       (*repo).argvPick,
	"reset":        (*repo).argvReset,
	"tagCreate":    (*repo).argvTagCreate,
	"tagDelete":    (*repo).argvTagDelete,
	"stashPush":    (*repo).argvStashPush,
	"stashApply":   (*repo).argvStashEntry,
	"stashPop":     (*repo).argvStashEntry,
	"stashDrop":    (*repo).argvStashEntry,
	"fetch":        (*repo).argvFetch,
	"pull":         (*repo).argvPull,
	"push":         (*repo).argvPush,
}

// argvApplyPatch applies a patch from the request to the working tree or,
// cached, to the index, also in reverse.
func (r *repo) argvApplyPatch(_ context.Context, _ string, p Params) (run, error) {
	if p.Patch == "" || len(p.Patch) > MaxPatch {
		return run{}, plugin.Errorf("bad_params", "no patch or a patch over %d bytes", MaxPatch)
	}
	args := []string{"apply", "--whitespace=nowarn"}
	if p.Cached {
		args = append(args, "--cached")
	}
	if p.Reverse {
		args = append(args, "--reverse")
	}
	return run{args: append(args, "-"), stdin: []byte(p.Patch)}, nil
}

// argvCommit commits what is staged with the message on stdin; amending
// without a message keeps the commit's own.
func (r *repo) argvCommit(_ context.Context, _ string, p Params) (run, error) {
	if len(p.Message) > MaxPatch {
		return run{}, plugin.Errorf("bad_params", "message too long")
	}
	// The message is the user's as typed: whitespace is tidied, lines
	// starting with "#" are kept (no editor added comments).
	args := []string{"commit", "--cleanup=whitespace"}
	if p.Amend {
		args = append(args, "--amend")
	}
	if p.Signoff {
		args = append(args, "--signoff")
	}
	if strings.TrimSpace(p.Message) == "" {
		if !p.Amend {
			return run{}, plugin.Errorf("empty_message", "no commit message")
		}
		return run{args: append(args, "--no-edit")}, nil
	}
	return run{args: append(args, "--file=-"), stdin: []byte(p.Message)}, nil
}

// argvCheckout switches to a local branch, or detached to a commit.
func (r *repo) argvCheckout(ctx context.Context, _ string, p Params) (run, error) {
	if p.Rev != "" {
		// A commit, detached.
		rev, err := r.rev(ctx, p.Rev)
		if err != nil {
			return run{}, err
		}
		return run{args: []string{"checkout", "--detach", rev, "--"}}, nil
	}
	if err := plainName(p.Name); err != nil {
		return run{}, err
	}
	if err := r.refExists(ctx, "refs/heads/"+p.Name); err != nil {
		return run{}, err
	}
	return run{args: []string{"checkout", p.Name, "--"}}, nil
}

// argvBranchCreate makes a branch of a new name at a revision (HEAD when
// none is given), also checked out.
func (r *repo) argvBranchCreate(ctx context.Context, _ string, p Params) (run, error) {
	if err := r.newName(ctx, "heads", p.Name); err != nil {
		return run{}, err
	}
	at := "HEAD"
	if p.At != "" {
		var err error
		if at, err = r.rev(ctx, p.At); err != nil {
			return run{}, err
		}
	}
	if p.Checkout {
		return run{args: []string{"checkout", "-b", p.Name, at, "--"}}, nil
	}
	return run{args: []string{"branch", p.Name, at}}, nil
}

// argvBranchDelete deletes a local branch, or a branch of a remote there.
func (r *repo) argvBranchDelete(ctx context.Context, _ string, p Params) (run, error) {
	if err := plainName(p.Name); err != nil {
		return run{}, err
	}
	if p.Remote != "" {
		if err := r.remote(ctx, p.Remote); err != nil {
			return run{}, err
		}
		return run{args: []string{"push", p.Remote, "--delete", "refs/heads/" + p.Name}}, nil
	}
	if err := r.refExists(ctx, "refs/heads/"+p.Name); err != nil {
		return run{}, err
	}
	flag := "-d"
	if p.Force {
		flag = "-D"
	}
	return run{args: []string{"branch", flag, p.Name}}, nil
}

// argvBranchRename renames a local branch to a new name.
func (r *repo) argvBranchRename(ctx context.Context, _ string, p Params) (run, error) {
	if err := plainName(p.Name); err != nil {
		return run{}, err
	}
	if err := r.refExists(ctx, "refs/heads/"+p.Name); err != nil {
		return run{}, err
	}
	if err := r.newName(ctx, "heads", p.To); err != nil {
		return run{}, err
	}
	return run{args: []string{"branch", "-m", p.Name, p.To}}, nil
}

// argvMerge merges a revision into the current branch.
func (r *repo) argvMerge(ctx context.Context, _ string, p Params) (run, error) {
	ref, err := r.rev(ctx, p.Ref)
	if err != nil {
		return run{}, err
	}
	args := []string{"merge", "--no-edit"}
	if p.NoFF {
		args = append(args, "--no-ff")
	}
	return run{args: append(args, ref)}, nil
}

// argvRebase rebases the current branch onto a revision.
func (r *repo) argvRebase(ctx context.Context, _ string, p Params) (run, error) {
	onto, err := r.rev(ctx, p.Onto)
	if err != nil {
		return run{}, err
	}
	return run{args: []string{"rebase", onto}}, nil
}

// argvOperation aborts or continues (the action) a merge, rebase,
// cherry-pick or revert.
func (r *repo) argvOperation(_ context.Context, action string, p Params) (run, error) {
	sub := map[string]string{"merge": "merge", "rebase": "rebase", "cherryPick": "cherry-pick", "revert": "revert"}[p.Op]
	if sub == "" {
		return run{}, plugin.Errorf("bad_params", "unknown operation %q", p.Op)
	}
	return run{args: []string{sub, "--" + action}}, nil
}

// argvPick picks or reverts (the action) a commit, of a merge against the
// parent given.
func (r *repo) argvPick(ctx context.Context, action string, p Params) (run, error) {
	rev, err := r.rev(ctx, p.Rev)
	if err != nil {
		return run{}, err
	}
	args := []string{"cherry-pick"}
	if action == "revert" {
		args = []string{"revert", "--no-edit"}
	}
	if p.Parent > 0 {
		args = append(args, "--mainline", strconv.Itoa(p.Parent))
	}
	return run{args: append(args, rev)}, nil
}

// argvReset resets the current branch to a revision in one of the modes.
func (r *repo) argvReset(ctx context.Context, _ string, p Params) (run, error) {
	mode := map[string]string{"soft": "--soft", "mixed": "--mixed", "hard": "--hard"}[p.Mode]
	if mode == "" {
		return run{}, plugin.Errorf("bad_params", "unknown mode %q", p.Mode)
	}
	rev, err := r.rev(ctx, p.Rev)
	if err != nil {
		return run{}, err
	}
	return run{args: []string{"reset", "-q", mode, rev, "--"}}, nil
}

// argvTagCreate makes a tag of a new name at a revision (HEAD when none is
// given), annotated when there is a message.
func (r *repo) argvTagCreate(ctx context.Context, _ string, p Params) (run, error) {
	if err := r.newName(ctx, "tags", p.Name); err != nil {
		return run{}, err
	}
	at := "HEAD"
	if p.At != "" {
		var err error
		if at, err = r.rev(ctx, p.At); err != nil {
			return run{}, err
		}
	}
	if strings.TrimSpace(p.Message) != "" {
		if len(p.Message) > MaxPatch {
			return run{}, plugin.Errorf("bad_params", "message too long")
		}
		return run{args: []string{"tag", "--annotate", "--file=-", p.Name, at}, stdin: []byte(p.Message)}, nil
	}
	return run{args: []string{"tag", p.Name, at}}, nil
}

// argvTagDelete deletes a local tag, or a tag of a remote there.
func (r *repo) argvTagDelete(ctx context.Context, _ string, p Params) (run, error) {
	if err := plainName(p.Name); err != nil {
		return run{}, err
	}
	if p.Remote != "" {
		if err := r.remote(ctx, p.Remote); err != nil {
			return run{}, err
		}
		return run{args: []string{"push", p.Remote, "--delete", "refs/tags/" + p.Name}}, nil
	}
	if err := r.refExists(ctx, "refs/tags/"+p.Name); err != nil {
		return run{}, err
	}
	return run{args: []string{"tag", "-d", p.Name}}, nil
}

// argvStashPush stashes the changes, also the untracked files.
func (r *repo) argvStashPush(_ context.Context, _ string, p Params) (run, error) {
	args := []string{"stash", "push"}
	if p.IncludeUntracked {
		args = append(args, "--include-untracked")
	}
	if m := strings.TrimSpace(p.Message); m != "" {
		if strings.ContainsAny(m, "\x00") || len(m) > 4096 {
			return run{}, plugin.Errorf("bad_params", "bad message")
		}
		args = append(args, "--message="+m)
	}
	return run{args: args}, nil
}

// argvStashEntry applies, pops or drops (the action) a stash entry, which
// must still be the commit the request names.
func (r *repo) argvStashEntry(ctx context.Context, action string, p Params) (run, error) {
	if p.Index < 0 || p.Index > 100000 {
		return run{}, plugin.Errorf("bad_params", "bad stash index")
	}
	if !fullHash.MatchString(p.Hash) {
		return run{}, plugin.Errorf("bad_params", "no stash commit")
	}
	// The entry is the one the UI showed: a stash pushed or dropped
	// meanwhile renumbers them.
	entry := "stash@{" + strconv.Itoa(p.Index) + "}"
	res, err := r.git(ctx, run{args: []string{"rev-parse", "-q", "--verify", entry}, ok: []int{1, 128}})
	if err != nil {
		return run{}, err
	}
	if res.code != 0 || !strings.EqualFold(strings.TrimSpace(string(res.out)), p.Hash) {
		return run{}, plugin.Errorf("stale", "%s is not %s", entry, p.Hash)
	}
	sub := strings.ToLower(strings.TrimPrefix(action, "stash"))
	return run{args: []string{"stash", sub, entry}}, nil
}

// argvFetch fetches from a remote, or from all.
func (r *repo) argvFetch(ctx context.Context, _ string, p Params) (run, error) {
	args := []string{"fetch"}
	if p.Prune {
		args = append(args, "--prune")
	}
	if p.Remote == "" || p.All {
		return run{args: append(args, "--all")}, nil
	}
	if err := r.remote(ctx, p.Remote); err != nil {
		return run{}, err
	}
	return run{args: append(args, p.Remote)}, nil
}

// argvPull pulls from the upstream, a remote or a remote's branch.
func (r *repo) argvPull(ctx context.Context, _ string, p Params) (run, error) {
	// As the user's configuration says (pull.rebase, pull.ff) unless
	// asked to rebase; branches that diverged without one fail with
	// diverged. From the upstream, or from a remote's branch named by
	// its full ref.
	args := []string{"pull"}
	if p.Rebase {
		args = append(args, "--rebase")
	}
	if p.Remote == "" {
		if p.Branch != "" {
			return run{}, plugin.Errorf("bad_params", "a branch needs a remote")
		}
		return run{args: args}, nil
	}
	if err := r.remote(ctx, p.Remote); err != nil {
		return run{}, err
	}
	if p.Branch == "" {
		return run{args: append(args, p.Remote)}, nil
	}
	if err := r.newName(ctx, "heads", p.Branch); err != nil {
		return run{}, err
	}
	return run{args: append(args, p.Remote, "refs/heads/"+p.Branch)}, nil
}

// argvPush pushes to the upstream, a remote, or a branch or tag to a remote.
func (r *repo) argvPush(ctx context.Context, _ string, p Params) (run, error) {
	args := []string{"push"}
	if p.ForceWithLease {
		args = append(args, "--force-with-lease")
	}
	if p.Remote == "" {
		if p.Branch != "" || p.Tag != "" || p.SetUpstream {
			return run{}, plugin.Errorf("bad_params", "a branch or tag needs a remote")
		}
		return run{args: args}, nil
	}
	if err := r.remote(ctx, p.Remote); err != nil {
		return run{}, err
	}
	switch {
	case p.Tag != "":
		if err := plainName(p.Tag); err != nil {
			return run{}, err
		}
		if err := r.refExists(ctx, "refs/tags/"+p.Tag); err != nil {
			return run{}, err
		}
		return run{args: append(args, p.Remote, "refs/tags/"+p.Tag)}, nil
	case p.Branch != "":
		if err := plainName(p.Branch); err != nil {
			return run{}, err
		}
		if err := r.refExists(ctx, "refs/heads/"+p.Branch); err != nil {
			return run{}, err
		}
		if p.SetUpstream {
			args = append(args, "--set-upstream")
		}
		return run{args: append(args, p.Remote, "refs/heads/"+p.Branch+":refs/heads/"+p.Branch)}, nil
	}
	return run{args: append(args, p.Remote)}, nil
}
