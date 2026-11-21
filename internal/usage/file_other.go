//go:build !unix

package usage

import "os"

// openRegular opens a regular file for reading and refuses anything else
// (a path there names no FIFO: pipes have a namespace of their own).
func openRegular(p string) (*os.File, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, errNotRegular
	}
	return f, nil
}
