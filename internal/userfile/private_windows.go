package userfile

// private leaves dir as it is: the configuration directory under
// %AppData% is the user's own by its access control list, and Windows has
// no group and other mode bits.
func private(string) error { return nil }
