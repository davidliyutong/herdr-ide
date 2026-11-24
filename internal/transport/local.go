//go:build unix

package transport

import (
	"context"
	"log"
	"net"
	"os"
	"syscall"
	"time"

	"herdr-ide/internal/agent"
)

// DialNode connects to the local machine's node of this build, which it
// starts from this executable when none answers (agent.DialNode), as
// `node dial` does for a core that comes over ssh.
func DialNode(ctx context.Context, instance, sshConn string, logger *log.Logger) (*Session, error) {
	c, err := agent.DialNode(ctx, instance, ClientID, sshConn, logger)
	if err != nil {
		return nil, err
	}
	s, err := newSession(c, c, logger, nil)
	if err != nil {
		c.Close()
		return nil, err
	}
	return s, nil
}

// DialLocal starts an agent in this process, connected through a
// socketpair: the tests' agent, which ends with the session. A nil
// opts.Logger logs to stderr.
func DialLocal(ctx context.Context, opts agent.Options) (*Session, error) {
	logger := opts.Logger
	if logger == nil {
		logger = log.New(os.Stderr, "", log.LstdFlags)
	}
	if opts.SSHConnection == "" {
		opts.SSHConnection = os.Getenv("SSH_CONNECTION")
	}
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, err
	}
	f0 := os.NewFile(uintptr(fds[0]), "agent-core")
	f1 := os.NewFile(uintptr(fds[1]), "agent-local")
	c0, err := net.FileConn(f0)
	f0.Close()
	if err != nil {
		f1.Close()
		return nil, err
	}
	c1, err := net.FileConn(f1)
	f1.Close()
	if err != nil {
		c0.Close()
		return nil, err
	}
	actx, cancel := context.WithCancel(context.Background())
	served := make(chan struct{})
	go func() {
		defer close(served)
		opts.Logger = log.New(logger.Writer(), "agent[local]: ", log.LstdFlags)
		if err := agent.Serve(actx, c1, opts); err != nil {
			logger.Printf("local agent: %v", err)
		}
		c1.Close()
	}()
	// Closing waits for the agent's cleanup (it stops the code-server it
	// started), which a remote agent does after its ssh session ends.
	s, err := newSession(c0, closerFunc(func() error {
		cancel()
		err := c1.Close()
		select {
		case <-served:
		case <-time.After(10 * time.Second):
			logger.Printf("local agent did not finish cleaning up")
		}
		return err
	}), logger, nil)
	if err != nil {
		cancel()
		c0.Close()
		c1.Close()
		return nil, err
	}
	return s, nil
}
