package userfile

// syncDir does nothing on Windows, whose directories cannot be flushed
// through a handle; NTFS journals the rename itself.
func syncDir(string) error { return nil }
