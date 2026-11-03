package agent

import (
	"runtime"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/shm"
	"golang.org/x/sys/unix"
)

// Capturing through MIT-SHM: the X server copies window contents into a
// System V shared memory segment instead of sending them over the socket,
// about ten times faster for a whole window. The segment is private to
// this user (0600) and marked for removal as soon as the agent attached it
// (Linux lets the server attach it afterwards; elsewhere once the server
// attached it), so it goes away with the agent's and the server's
// attachments however they end.

type shmBuf struct {
	id   shm.Seg
	data []byte
}

// shmInit reports whether the display offers MIT-SHM.
func shmInit(x *xgb.Conn) bool {
	if shm.Init(x) != nil {
		return false
	}
	_, err := shm.QueryVersion(x).Reply()
	return err == nil
}

// newShmBuf makes a segment of size bytes that the server writes to.
func newShmBuf(x *xgb.Conn, size int) (*shmBuf, error) {
	id, err := unix.SysvShmGet(unix.IPC_PRIVATE, size, unix.IPC_CREAT|0o600)
	if err != nil {
		return nil, err
	}
	data, err := unix.SysvShmAttach(id, 0, 0)
	early := runtime.GOOS == "linux"
	if err != nil || early {
		unix.SysvShmCtl(id, unix.IPC_RMID, nil)
	}
	if err != nil {
		return nil, err
	}
	var seg shm.Seg
	if seg, err = shm.NewSegId(x); err == nil {
		err = shm.AttachChecked(x, seg, uint32(id), false).Check()
	}
	if !early {
		unix.SysvShmCtl(id, unix.IPC_RMID, nil)
	}
	if err != nil {
		unix.SysvShmDetach(data)
		return nil, err
	}
	return &shmBuf{id: seg, data: data}, nil
}

func (b *shmBuf) free(x *xgb.Conn) {
	shm.Detach(x, b.id)
	unix.SysvShmDetach(b.data)
}
