//go:build !unix

package testexec

import "io/fs"

func ownedByMe(fs.FileInfo) bool { return true }
