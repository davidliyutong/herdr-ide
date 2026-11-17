//go:build linux

package browser

import (
	"bufio"
	"context"
	"encoding/hex"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// maxFDs bounds the descriptors looked at to name the listening programs.
const maxFDs = 20000

// listening reads the listening TCP sockets of the user from the kernel
// (/proc/net/tcp, tcp6): those bound to loopback or to every address,
// which a dial to loopback reaches. Their programs are named by looking
// for the sockets among the descriptors of the user's processes.
func listening(ctx context.Context) []Port {
	uid := strconv.Itoa(os.Getuid())
	inodes := map[string]int{}
	for _, name := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(name)
		if err != nil {
			continue
		}
		listeners(f, uid, inodes)
		f.Close()
	}
	names := processes(ctx, inodes)
	var out []Port
	for inode, port := range inodes {
		out = append(out, Port{Port: port, Process: names[inode]})
	}
	return out
}

// listeners reads the kernel's table of TCP sockets (the text of
// /proc/net/tcp or tcp6) and adds the listening sockets of user uid that a
// dial to loopback reaches to inodes: the port of each by its inode.
func listeners(table io.Reader, uid string, inodes map[string]int) {
	sc := bufio.NewScanner(table)
	sc.Scan() // the header
	for sc.Scan() {
		// sl local_address rem_address st tx rx tr tm->when retrnsmt uid timeout inode
		fields := strings.Fields(sc.Text())
		if len(fields) < 10 || fields[3] != "0A" || fields[7] != uid {
			continue
		}
		addr, port, ok := strings.Cut(fields[1], ":")
		n, err := strconv.ParseUint(port, 16, 16)
		if !ok || err != nil || !reachable(addr) {
			continue
		}
		inodes[fields[9]] = int(n)
	}
}

// reachable reports whether a socket bound to the kernel's hex address
// answers on loopback: every address, 127.0.0.0/8, ::1 or a mapped
// 127.0.0.0/8.
func reachable(hexAddr string) bool {
	b, err := hex.DecodeString(hexAddr)
	if err != nil {
		return false
	}
	// The kernel prints each 32-bit word in host byte order.
	for i := 0; i+4 <= len(b); i += 4 {
		b[i], b[i+1], b[i+2], b[i+3] = b[i+3], b[i+2], b[i+1], b[i]
	}
	ip := net.IP(b)
	return ip.IsUnspecified() || ip.IsLoopback()
}

// processes names the programs holding the sockets of these inodes.
func processes(ctx context.Context, inodes map[string]int) map[string]string {
	names := map[string]string{}
	if len(inodes) == 0 {
		return names
	}
	uid := uint32(os.Getuid())
	dirs, _ := os.ReadDir("/proc")
	seen := 0
	for _, d := range dirs {
		if ctx.Err() != nil || len(names) == len(inodes) || seen > maxFDs {
			break
		}
		if _, err := strconv.Atoi(d.Name()); err != nil {
			continue
		}
		dir := filepath.Join("/proc", d.Name())
		info, err := os.Stat(dir)
		if err != nil {
			continue
		}
		if st, ok := info.Sys().(*syscall.Stat_t); !ok || st.Uid != uid {
			continue
		}
		fds, _ := os.ReadDir(filepath.Join(dir, "fd"))
		for _, fd := range fds {
			seen++
			link, err := os.Readlink(filepath.Join(dir, "fd", fd.Name()))
			if err != nil || !strings.HasPrefix(link, "socket:[") {
				continue
			}
			inode := strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")
			if _, want := inodes[inode]; want && names[inode] == "" {
				if comm, err := os.ReadFile(filepath.Join(dir, "comm")); err == nil {
					names[inode] = strings.TrimSpace(string(comm))
				}
			}
		}
	}
	return names
}
