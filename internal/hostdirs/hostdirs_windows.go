package hostdirs

import "os"

// userRuntime: Windows has none; the agent does not run there.
func userRuntime() (string, bool) { return "", false }

func ownDir(os.FileInfo) bool { return true }
