//go:build unix

package agent

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
)

// fakeGPUs makes the kernel's description of a machine's GPUs below a
// directory of the test: NVIDIA ones as "pci=minor" in gpus, render nodes
// as "pci=driver" in nodes (renderD128 and up, regular files that open).
func fakeGPUs(t *testing.T, gpus, nodes []string) {
	t.Helper()
	dir := t.TempDir()
	oldProc, oldSys, oldDev := nvidiaProc, drmSys, drmDev
	nvidiaProc, drmSys, drmDev = filepath.Join(dir, "proc"), filepath.Join(dir, "sys"), filepath.Join(dir, "dev")
	t.Cleanup(func() { nvidiaProc, drmSys, drmDev = oldProc, oldSys, oldDev })
	os.MkdirAll(nvidiaProc, 0o755)
	for i, g := range gpus {
		pci, minor, _ := strings.Cut(g, "=")
		os.MkdirAll(filepath.Join(nvidiaProc, pci), 0o755)
		info := fmt.Sprintf("Model: \t\t NVIDIA RTX PRO 6000\nIRQ:   \t\t 292\nGPU UUID: \t GPU-%08d-ef14-0f75-9eae-00d68420e0d7\nBus Location: \t %s\nDevice Minor: \t %s\nGPU Excluded:\t No\n", i, pci, minor)
		os.WriteFile(filepath.Join(nvidiaProc, pci, "information"), []byte(info), 0o644)
	}
	os.MkdirAll(drmDev, 0o755)
	for i, n := range nodes {
		pci, driver, _ := strings.Cut(n, "=")
		name := fmt.Sprintf("renderD%d", 128+i)
		os.WriteFile(filepath.Join(drmDev, name), nil, 0o600)
		dev := filepath.Join(dir, "devices", pci)
		drv := filepath.Join(dir, "drivers", driver)
		os.MkdirAll(dev, 0o755)
		os.MkdirAll(drv, 0o755)
		os.Symlink(drv, filepath.Join(dev, "driver"))
		os.MkdirAll(filepath.Join(drmSys, name), 0o755)
		os.Symlink(dev, filepath.Join(drmSys, name, "device"))
	}
}

// NVIDIA GPUs are listed in bus order with the driver's own numbering;
// the display draws with the driver's first one, whose render node need
// not be the first.
func TestGPUNode(t *testing.T) {
	// As on a machine seen: the driver's first GPU is the second on the bus.
	fakeGPUs(t, []string{"0000:11:00.0=1", "0000:61:00.0=0", "0000:91:00.0=3", "0000:E1:00.0=2"},
		[]string{"0000:61:00.0=nvidia", "0000:11:00.0=nvidia", "0000:e1:00.0=nvidia", "0000:91:00.0=nvidia"})
	gpus := nvidiaGPUs()
	if len(gpus) != 4 || gpus[1].Index != 1 || gpus[1].Minor != 0 || gpus[1].PCI != "0000:61:00.0" || gpus[3].PCI != "0000:e1:00.0" ||
		gpus[0].UUID != "GPU-00000000-ef14-0f75-9eae-00d68420e0d7" || gpus[0].Model != "NVIDIA RTX PRO 6000" {
		t.Fatalf("gpus = %+v", gpus)
	}
	node, nvidia, minor := gpuNode(gpus)
	if node != filepath.Join(drmDev, "renderD128") || !nvidia || minor == nil || *minor != 0 {
		t.Errorf("node %q, nvidia %v, minor %v", node, nvidia, minor)
	}
	// Its node cannot be opened: the first one that can.
	os.Remove(filepath.Join(drmDev, "renderD128"))
	if node, nvidia, minor := gpuNode(gpus); node != filepath.Join(drmDev, "renderD129") || !nvidia || minor == nil || *minor != 1 {
		t.Errorf("without the first GPU's node: %q, %v, %v", node, nvidia, minor)
	}

	// No NVIDIA GPU: the first render node, with no layouts of NVIDIA's.
	fakeGPUs(t, nil, []string{"0000:00:02.0=i915", "0000:01:00.0=amdgpu"})
	if node, nvidia, minor := gpuNode(nvidiaGPUs()); node != filepath.Join(drmDev, "renderD128") || nvidia || minor != nil {
		t.Errorf("Mesa GPUs: %q, %v, %v", node, nvidia, minor)
	}
	// No GPU at all.
	fakeGPUs(t, nil, nil)
	if node, _, _ := gpuNode(nvidiaGPUs()); node != "" {
		t.Errorf("no GPU: %q", node)
	}
}

// A GPU whose description lacks the minor or a well-formed UUID, or that
// the driver excludes, is not listed: its UUID goes into environments.
func TestNvidiaGPUsMalformed(t *testing.T) {
	fakeGPUs(t, []string{"0000:11:00.0=1", "0000:61:00.0=0"}, nil)
	os.WriteFile(filepath.Join(nvidiaProc, "0000:11:00.0", "information"), []byte("Model: X\nGPU UUID: GPU-12345678' ; rm -rf\nDevice Minor: 1\n"), 0o644)
	os.MkdirAll(filepath.Join(nvidiaProc, "0000:91:00.0"), 0o755)
	os.WriteFile(filepath.Join(nvidiaProc, "0000:91:00.0", "information"), []byte("Model: X\nGPU UUID: GPU-12345678-aaaa\nDevice Minor: 2\nGPU Excluded: Yes\n"), 0o644)
	gpus := nvidiaGPUs()
	if len(gpus) != 1 || gpus[0].PCI != "0000:61:00.0" || gpus[0].Index != 0 {
		t.Errorf("gpus = %+v", gpus)
	}
}

// The plain display is started when it is asked for, where there is no
// Xwayland or GPU, and after the GPU display failed to start.
func TestWantedDisplay(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("virtual displays are provided on Linux only")
	}
	g := newGUI(testAgent(t))
	bin := filepath.Join(t.TempDir(), "Xwayland")
	os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("PATH", filepath.Dir(bin)+":"+os.Getenv("PATH"))
	fakeGPUs(t, nil, []string{"0000:00:02.0=i915"})
	if got := g.wanted(agentproto.GUIDisplayAuto); got != agentproto.GUIXwayland {
		t.Errorf("auto with Xwayland and a GPU: %s", got)
	}
	if got := g.wanted(agentproto.GUIXvfb); got != agentproto.GUIXvfb {
		t.Errorf("xvfb asked for: %s", got)
	}
	g.accelErr = "glamor"
	if got := g.wanted(agentproto.GUIDisplayAuto); got != agentproto.GUIXvfb {
		t.Errorf("after the GPU display failed: %s", got)
	}
	g.accelErr = ""
	fakeGPUs(t, nil, nil)
	if got := g.wanted(agentproto.GUIDisplayAuto); got != agentproto.GUIXvfb {
		t.Errorf("without a GPU: %s", got)
	}
}

// gpupick, preloaded, leaves a program the GPUs of its
// CUDA_VISIBLE_DEVICES: other device nodes do not open, indices count
// among the GPUs left, and programs it starts keep the set.
func TestGPUPick(t *testing.T) {
	if len(pickLib) == 0 {
		t.Skip("no gpupick for this platform")
	}
	g := newGUI(testAgent(t))
	if g.pickPath() != "" {
		t.Fatal("installed before installing")
	}
	if err := g.installPick(); err != nil {
		t.Fatal(err)
	}
	lib := g.pickPath()
	if info, err := os.Stat(lib); err != nil || info.Mode().Perm() != 0o600 || !strings.HasPrefix(lib, g.pickRoot()) {
		t.Fatalf("library %q: %v", lib, err)
	}
	// A damaged copy is not offered, and installing replaces it.
	os.WriteFile(lib, []byte("damaged"), 0o600)
	g.pickOK = ""
	if g.pickPath() != "" {
		t.Error("a damaged library is offered")
	}
	if err := g.installPick(); err != nil || g.pickPath() != lib {
		t.Fatalf("installing over a damaged copy: %v", err)
	}
	// Concurrent installs serialize and leave the library usable.
	os.RemoveAll(filepath.Dir(lib))
	g.pickOK = ""
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- g.installPick()
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent installPick: %v", err)
		}
	}
	if g.pickPath() != lib {
		t.Fatalf("pickPath after concurrent installs = %q, want %q", g.pickPath(), lib)
	}

	table := "GPU-70987003-ef14=1,GPU-dd0ff3fe-3db4=0,GPU-46f915f8-3cfa=3,GPU-b1b5b6db-ca22=2"
	// What a program sees: its CUDA_VISIBLE_DEVICES, the minors kept, the
	// GLX vendor, and what opening /dev/nvidia0 says ("hidden" or else).
	script := `r=$( (: < /dev/nvidia0) 2>&1 ); case "$r" in *"not permitted"*) r=hidden;; *) r=open;; esac
echo "$CUDA_VISIBLE_DEVICES|$GPUPICK_KEEP|$__GLX_VENDOR_LIBRARY_NAME|$r"`
	for _, c := range []struct {
		env  []string
		want string
	}{
		{nil, "|||open"},
		{[]string{"CUDA_VISIBLE_DEVICES=2"}, "0|3||hidden"},
		{[]string{"CUDA_VISIBLE_DEVICES=1"}, "0|0||open"},
		{[]string{"CUDA_VISIBLE_DEVICES=3,0"}, "1,0|2,1||hidden"},
		{[]string{"CUDA_VISIBLE_DEVICES= 2 , 1"}, "1,0|3,0||open"},
		{[]string{"CUDA_VISIBLE_DEVICES=GPU-46f915f8"}, "GPU-46f915f8|3||hidden"},
		{[]string{"CUDA_VISIBLE_DEVICES=GPU-46f915f8,0"}, "GPU-46f915f8,0|3,1||hidden"},
		// The display's GPU out of sight: OpenGL through Mesa, unless said.
		{[]string{"CUDA_VISIBLE_DEVICES=0", "GPUPICK_DISPLAY=0"}, "0|1|mesa|hidden"},
		{[]string{"CUDA_VISIBLE_DEVICES=0", "GPUPICK_DISPLAY=0", "__GLX_VENDOR_LIBRARY_NAME=nvidia"}, "0|1|nvidia|hidden"},
		{[]string{"CUDA_VISIBLE_DEVICES=1", "GPUPICK_DISPLAY=0"}, "0|0||open"},
		// Nothing changes for a value that names no GPU, one twice, all of
		// them, none, or a UUID two GPUs could have.
		{[]string{"CUDA_VISIBLE_DEVICES=7"}, "7|||open"},
		{[]string{"CUDA_VISIBLE_DEVICES=1,1"}, "1,1|||open"},
		{[]string{"CUDA_VISIBLE_DEVICES=0,1,2,3"}, "0,1,2,3|||open"},
		{[]string{"CUDA_VISIBLE_DEVICES="}, "|||open"},
		{[]string{"CUDA_VISIBLE_DEVICES=-1"}, "-1|||open"},
		{[]string{"CUDA_VISIBLE_DEVICES=GPU-"}, "GPU-|||open"},
		{[]string{"CUDA_VISIBLE_DEVICES=MIG-46f915f8"}, "MIG-46f915f8|||open"},
		// GPUs of several models: indices only in bus order.
		{[]string{"CUDA_VISIBLE_DEVICES=2", "GPUPICK_MIXED=1"}, "2|||open"},
		{[]string{"CUDA_VISIBLE_DEVICES=2", "GPUPICK_MIXED=1", "CUDA_DEVICE_ORDER=PCI_BUS_ID"}, "0|3||hidden"},
		{[]string{"CUDA_VISIBLE_DEVICES=GPU-46f915f8", "GPUPICK_MIXED=1"}, "GPU-46f915f8|3||hidden"},
		// A set inherited is kept whatever CUDA_VISIBLE_DEVICES says then.
		{[]string{"CUDA_VISIBLE_DEVICES=1", "GPUPICK_KEEP=3,2"}, "1|3,2||hidden"},
	} {
		cmd := exec.Command("/bin/sh", "-c", script)
		cmd.Env = append([]string{"PATH=" + os.Getenv("PATH"), "LD_PRELOAD=" + lib, "GPUPICK_TABLE=" + table}, c.env...)
		out, err := cmd.CombinedOutput()
		if got := strings.TrimSpace(string(out)); err != nil || got != c.want {
			t.Errorf("%v: %q, %v; want %q", c.env, got, err, c.want)
		}
	}
	// Without the table (a machine with one GPU) nothing happens.
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "LD_PRELOAD=" + lib, "CUDA_VISIBLE_DEVICES=2"}
	if out, _ := cmd.CombinedOutput(); strings.TrimSpace(string(out)) != "2|||open" {
		t.Errorf("without a table: %q", out)
	}
	// Files other than GPUs open, are created with their mode, and are
	// found relative to a directory.
	dir := t.TempDir()
	cmd = exec.Command("/bin/sh", "-c", `umask 022; cd "$1" && echo x > new && cat new && ls -l new | cut -c1-10`, "sh", dir)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "LD_PRELOAD=" + lib, "GPUPICK_TABLE=" + table, "CUDA_VISIBLE_DEVICES=2"}
	if out, err := cmd.CombinedOutput(); err != nil || string(out) != "x\n-rw-r--r--\n" {
		t.Errorf("ordinary files: %q, %v", out, err)
	}
}

// An Xwayland that does not come up leaves the machine with Xvfb: the
// display starts as the plain one, and this agent does not try the GPU
// display again.
func TestGPUDisplayFallsBack(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("virtual displays are provided on Linux only")
	}
	g := newGUI(testAgent(t))
	if g.findXvfb() == "" {
		t.Skip("no Xvfb on this machine")
	}
	// An Xwayland that knows -terminate's delay and exits when started.
	bin := filepath.Join(t.TempDir(), "Xwayland")
	os.WriteFile(bin, []byte("#!/bin/sh\ncase \"$1\" in -help) echo '-terminate [delay]';; *) echo 'no GPU today' >&2; exit 1;; esac\n"), 0o755)
	t.Setenv("PATH", filepath.Dir(bin)+":"+os.Getenv("PATH"))
	fakeGPUs(t, nil, []string{"0000:00:02.0=i915"})
	old := compositorCommand
	compositorCommand = func(string, bool) (*exec.Cmd, error) { return exec.Command("/bin/sh", "-c", "cat <&3 >/dev/null"), nil }
	t.Cleanup(func() { compositorCommand = old })
	if st := g.status(); !st.GPUDisplay {
		t.Fatalf("status before = %+v", st)
	}
	if err := g.start(agentproto.GUIDisplayAuto); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { g.stop(g.readState().Display, g.readState()) })
	st := g.status()
	if !st.Running || st.Kind != agentproto.GUIXvfb || st.GPUDisplay || st.DisplayMinor != nil {
		t.Errorf("status after = %+v", st)
	}
	if !strings.Contains(g.accelErr, "no GPU today") {
		t.Errorf("reason kept: %q", g.accelErr)
	}
	// Asked again, the display that runs is kept.
	pid := g.readState().Pid
	if err := g.start(agentproto.GUIDisplayAuto); err != nil || g.readState().Pid != pid {
		t.Errorf("second start: %v, pid %d → %d", err, pid, g.readState().Pid)
	}
}

// A display changes kind only while no program uses it.
func TestDisplayChangesKindWhenUnused(t *testing.T) {
	g := guiTestDisplay(t, agentproto.GUIXwayland)
	if g.findXvfb() == "" {
		t.Skip("no Xvfb on this machine")
	}
	n, _ := g.display()
	first := g.readState()
	// A program on the display: it stays what it is.
	cookie, _ := g.serverCookie()
	helper := exec.Command(os.Args[0], "-test.run=^TestHelperXClient$")
	helper.Env = append(os.Environ(), "GUI_TEST_SOCKET="+xSocket(n), "GUI_TEST_COOKIE="+fmt.Sprintf("%x", cookie))
	out, _ := helper.StdoutPipe()
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	defer helper.Process.Kill()
	out.Read(make([]byte, 64)) // it says when its window is there
	if pid := g.user(n); pid != helper.Process.Pid {
		t.Fatalf("user = %d, the program is %d", pid, helper.Process.Pid)
	}
	if err := g.start(agentproto.GUIXvfb); err != nil || g.readState().Pid != first.Pid {
		t.Fatalf("with a program on it: %v, %+v", err, g.readState())
	}
	helper.Process.Kill()
	helper.Wait()
	for i := 0; i < 50 && g.user(n) != 0; i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if err := g.start(agentproto.GUIXvfb); err != nil {
		t.Fatal(err)
	}
	if st := g.readState(); st.kind() != agentproto.GUIXvfb || st.Pid == first.Pid || st.Display != n || !g.running(n) {
		t.Errorf("state after the change = %+v", st)
	}
	if pidExists(first.Pid) {
		t.Error("the first display still runs")
	}
}
