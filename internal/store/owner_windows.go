package store

import "os"

// modeBits: Windows has no group and other mode bits; the user's
// profile's access control list keeps its files the user's.
const modeBits = false

// noFollow: os.OpenFile with O_CREATE|O_EXCL does not follow a link on
// Windows.
const noFollow = 0

// owned reports whether st is of a file of this user: a link is not.
func owned(st os.FileInfo) bool { return st.Mode()&os.ModeSymlink == 0 }
