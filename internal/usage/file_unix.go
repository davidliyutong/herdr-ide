//go:build unix

package usage

import (
	"os"
	"syscall"
)

// openRegular opens a regular file for reading and refuses anything else.
// It opens without blocking (O_NONBLOCK, which a regular file's reads
// ignore), so a FIFO or a device put at the name, also after the name was
// looked at, cannot hold up the scan: it is seen in the open file's mode
// and closed.
func openRegular(p string) (*os.File, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, errNotRegular
	}
	return f, nil
}
