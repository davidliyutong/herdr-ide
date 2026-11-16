//go:build unix

package userfile

import "os"

// syncDir makes a rename in dir durable: the directory's entry is flushed
// to disk as the file's content was.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
