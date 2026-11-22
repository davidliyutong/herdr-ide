package store

// removeUnheld removes nothing on Windows, whose SQLite locks are not
// looked at here: another host's database stays.
func removeUnheld(p string, still func() bool) (bool, error) { return false, nil }
