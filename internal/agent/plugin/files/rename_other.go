//go:build unix && !linux && !darwin

package files

// renameNoReplace renames from to to, failing with fs.ErrExist when to
// exists.
func renameNoReplace(from, to string) error { return renameChecked(from, to) }
