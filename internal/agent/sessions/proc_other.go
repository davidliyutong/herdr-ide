//go:build unix && !darwin

package sessions

import (
	"errors"
	"time"
)

// sysTable is not used where processes are read from /proc (Linux); other
// systems have no process table here.
func sysTable(int) ([]procEntry, error) { return nil, errors.ErrUnsupported }

// sysStart is not used where processes are read from /proc (Linux); other
// systems have no start times here.
func sysStart(int) (time.Time, bool) { return time.Time{}, false }
