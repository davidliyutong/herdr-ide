//go:build unix && !darwin && !linux

package files

import "os"

// linksRefused reports whether openNoLinks refuses links in every
// directory of the path: not here.
var linksRefused = false

// openNoLinks is os.OpenFile: only flag's own O_NOFOLLOW applies.
func openNoLinks(path string, flag int, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(path, flag, perm)
}
