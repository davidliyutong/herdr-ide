# Test machines: old kernels, C libraries, and Windows VMs

Containers share the host's kernel, so they can only vary the C library. Whether something works on an old kernel (a system call that is missing, a flag it does not know) needs a machine that boots that kernel. This harness gives a test payload both, from one manifest, on **Linux (KVM)** and **macOS (HVF)**:

- `local`: the host itself;
- `docker`: a container of an old distribution (its glibc or musl, the host's kernel; `--platform` pinned explicitly);
- `vm`: a hardware-accelerated guest booted from the distribution's official cloud image (Linux KVM on `amd64`/`arm64`, macOS HVF on Apple Silicon `arm64` or Intel `amd64`, or QEMU TCG with `--emulate`).

`machines.py` downloads and verifies the images, boots them, runs a payload in each (locally or on a remote KVM/GPU host via `remote`) and writes one result file per machine. `winvm.py` provides the same disposable CoW-overlay workflow for Windows test VMs (macOS HVF, Linux KVM, Linux KVM `dockurr/windows`, or remote SSH Windows hosts).

## Requirements

- **Linux (KVM)**: `/dev/kvm` readable/writable by the user (group `kvm`), `qemu-system-x86_64` and/or `qemu-system-aarch64`, `qemu-img`, UEFI firmware for arm64 (`qemu-efi-aarch64` / `AAVMF`) or Windows UEFI (`OVMF`), `python3` (3.8+), `ssh`, `ssh-keygen`, `tar`, `curl`, and `docker` for container kinds.
- **macOS (HVF)**: Homebrew `qemu` (`qemu-system-aarch64`, `qemu-system-x86_64`, `qemu-img`, and its bundled `edk2-aarch64-code.fd` UEFI firmware), `python3`, `ssh`, `ssh-keygen`, `tar`, `curl`, and `docker` (e.g. OrbStack or Docker Desktop) for container kinds. Apple Silicon runs ARM64 Linux cloud images (`vm-ubuntu-18.04-arm64`, `vm-ubuntu-20.04-arm64`, `vm-ubuntu-24.04-arm64`) natively with HVF acceleration; x86_64 old-kernel VMs (such as `vm-centos-7`) can run via `machines.py remote <kvm-host>` or locally with `--emulate` (TCG).

No root: VMs use QEMU's user-mode network (`127.0.0.1` port forwarding only), and cloud-init gets its NoCloud seed over HTTP from the harness itself (the guest reaches the host's loopback at `10.0.2.2` and finds the URL in the SMBIOS serial number), so no ISO tools are needed.

## Use (`machines.py`)

```sh
./machines.py fetch vm-ubuntu-24.04-arm64     # download, verify sha256 (macOS arm64 HVF)
./machines.py up vm-ubuntu-24.04-arm64        # boot with HVF (macOS) or KVM (Linux), wait for ssh
./machines.py ssh vm-ubuntu-24.04-arm64 -- uname -a
./machines.py copy vm-ubuntu-24.04-arm64 ./dist --to work
./machines.py status
./machines.py down vm-ubuntu-24.04-arm64      # or: down --all
./machines.py run-matrix payloads/machine-node/run.sh vm-ubuntu-24.04-arm64 docker-alpine-3.20-libstdcxx -j 2
./machines.py run-matrix payloads/bun-probe/run.sh vm-centos-7 --emulate   # TCG cross-arch fallback
./machines.py clean                           # down --all, pulled images, work dir
```

`run-matrix SCRIPT [IMAGE...]` (without image names: all images natively runnable on this host; `--all-arch` includes every architecture) takes the script's directory as the payload (`--payload DIR` for another one), copies it into each machine (a container gets it mounted read-only at `/payload`), runs `sh SCRIPT` there with `MACHINE_NAME` and `MACHINE_KIND` set, and writes its output to `RESULTS/<image>.txt` (`--results`, default `$MACHINES_WORK/results`), headed by the machine's `uname` and `ldd --version`. `-j N` runs N machines at a time; machines it started are stopped afterwards unless `--keep`. Its exit status is 0 when every payload exited 0.

Everything the harness creates is under one work directory:

| Variable | Default | |
| --- | --- | --- |
| `MACHINES_WORK` | `./.machines-work` | VM overlays, console logs, the ssh key, results |
| `MACHINES_CACHE` | `$MACHINES_WORK/cache` | downloaded images |
| `MACHINES_PREFIX` | the product's slug + `-machines` | names of VMs and containers; label `<prefix>.image` |
| `MACHINES_TTL` | `7200` | seconds after which a machine left running stops by itself (built-in watchdog) |
| `MACHINES_MANIFEST` | `images.json` beside the script | |
| `MACHINES_ARCH` | host/Docker arch | override target arch (`amd64`/`arm64`) for multi-arch Docker images |
| `MACHINES_EMULATE` | unset (`1` enables) | allow QEMU TCG emulation when KVM/HVF is unavailable |
| `MACHINES_UEFI_CODE` | auto-detected | override ARM64 UEFI firmware path |

`down --all` and `clean` touch only QEMU processes of the user named `<prefix>-*` and containers with the label; `clean` removes only the Docker images the harness pulled itself (`$MACHINES_WORK/docker-pulled`). On exit or interruption the harness stops what it started, except what `up` was asked to leave running; that ends after `MACHINES_TTL`.

A VM gets a copy-on-write overlay over the cached image (the image is never written), 2 vCPUs and 2 GiB, `-cpu host` under KVM/HVF (and `Nehalem` for x86_64 TCG so SSE4.2 is present for Bun) unless the entry names a CPU model, and the image's default user with a key generated in the work directory. ssh never consults the caller's ssh agent. `ssh` passes its standard input through (`docker exec -i`, ssh), so a script that runs it should give it `</dev/null` unless it means to pipe something in. A VM's serial console is `vms/<image>/console.log`; the seed server's requests are in `vms/<image>/seed.log`.

## On a remote KVM or GPU host

`machines.py remote` automates uploading the harness and payload, executing `run-matrix` on a remote Linux KVM/GPU host while reusing a persistent image cache (`~/<prefix>-cache`), pulling the results back, and cleaning the remote run directory. Pass an SSH alias, or `-` to use `LINUX_TEST_HOST` from the gitignored root `.env` (see [`.env.example`](../../.env.example); optional SSH flags go in `MACHINES_SSH_OPTS` / `LINUX_TEST_SSH_OPTS`):

```sh
./e2e/machines/payloads/machine-node/build.sh
./e2e/machines/machines.py remote kvm-host e2e/machines/payloads/machine-node/run.sh \
  vm-centos-7 vm-ubuntu-18.04 docker-centos-7 -j 3
# Or using LINUX_TEST_HOST configured in gitignored .env:
./e2e/machines/machines.py remote - e2e/machines/payloads/machine-node/run.sh
# Run native Linux suites (doctor, it, e2e, ci-e2e, win-dockur) on LINUX_TEST_HOST:
make test-remote SUITE=doctor
```

## Disposable Windows VMs (`winvm.py` / `make test-win`)

`winvm.py` runs Windows hub, web, desktop and packaging checks across three backends using one interface:

1. **QEMU CoW overlay (`--base <windows-base.qcow2>`)**: boots a disposable overlay over a read-only golden Windows disk image using **macOS HVF** (ARM64 Windows 11/Server on Apple Silicon, or x64 on Intel Mac) or **Linux KVM** (`x86_64` or `arm64`). Loopback-only SSH (`127.0.0.1:<port> -> :22`), optional loopback RDP (`--rdp`), optional `swtpm` TPM 2.0 auto-detection, and TTL watchdog.
2. **Ephemeral Linux KVM container (`--dockur`)**: on Linux with `/dev/kvm` and Docker, starts a temporary `dockurr/windows` container bound only to `127.0.0.1`, injects `/oem/install.bat` to provision OpenSSH + throwaway SSH key + Git for Windows + Node + pnpm + Bun, runs the test suite, and removes the container.
3. **Remote Windows SSH host (`--host <ssh-alias>` or `WIN_TEST_HOST`)**: runs the same test workflow from macOS or Linux against an existing Proxmox/lab Windows VM with OpenSSH Server and Git for Windows.

```sh
# 1. One-time bootstrap of a golden Windows qcow2 base image (macOS HVF arm64 or Linux KVM x64/arm64)
./e2e/machines/winvm.py bootstrap --iso /path/to/windows.iso --virtio /path/to/virtio-win.iso --out ~/.cache/win-base.qcow2 --display

# 2. Run disposable CoW overlay tests (base image is never modified)
WINVM_BASE=~/.cache/win-base.qcow2 make test-win

# 3. Ephemeral Linux KVM container (no prebuilt base image needed)
make test-win WIN_ARGS='--dockur --suite all'

# 4. Existing remote Windows VM (e.g. Proxmox)
WIN_TEST_HOST=my-win-vm make test-win
```

## Adding an image

Add an entry to `images.json`:

- `name`: unique; by convention `vm-<distro>-<version>[-arm64]` or `docker-<distro>-<version>`.
- `kind`: `vm`, `docker` or `local`.
- `arch` / `arches`: `amd64` or `arm64` (multi-arch Docker images list `"arches": ["amd64", "arm64"]`).
- `vm`: `url` of the qcow2 cloud image (pin a dated release directory, not `current` or `latest`), `fallback` URLs (archive mirrors), `sha256` of the file (verified on download; `sha512` too where the publisher lists only that), `user` (the image's default cloud-init user), optionally `cpu`, `memory` (MiB), `cpus`, `boot_timeout` (seconds).
- `docker`: `image` and `digest` (the registry's manifest digest, from `docker buildx imagetools inspect <image>`), optionally `prepare`, a command run as root before the payload (e.g. installing a library).
- `expect`: `kernel` (a prefix of `uname -r`, checked for VMs) and `libc`, what the machine should report.

The image must run cloud-init with the NoCloud data source (official cloud images do) and an ssh server.

## Payloads

All payloads support both `amd64` and `arm64` (`MATRIX_ARCHS="amd64 arm64"` by default; `run.sh` selects the executable matching `uname -m` and C library):

- `payloads/bun-probe`: whether the Bun runtime and the system calls the machine agent makes through `bun:ffi` work on the machine (peer credentials, flock, fcntl locks, SQLite locking, openat2, renameat2, process groups, PTYs). `fetch-runtimes.sh [DIR]` downloads the pinned runtimes for `ARCHS` (default `amd64 arm64`) into `rt/` before a run.
- `payloads/machine-node`: the TypeScript build's executable driven as a hub drives it over ssh (`node dial`, yamux on stdin/stdout): `Op.Hello`, embedded `herdr-core` install and terminal execution, file read/write, symlink refusals, `SO_PEERCRED`, and `node stop --terminal-core`. `build.sh` builds glibc and musl executables for `MATRIX_ARCHS` and bundles `driver.js`. A machine the hub would refuse (musl without libstdc++ and libgcc, x86-64 without SSE4.2) passes as refused.
- `payloads/gui`: program windows of the TypeScript machine side with its GUI helper, driven over ssh: Xvfb, window capture/pixels/input/closing, keeper, GPU display (Xwayland + render node), video through the encoder of `scripts/build-ffmpeg.sh` when present (`enc/encoder-linux-<arch>.gz`), and `gpupick`. `GUI_MATRIX_GL=1` also checks OpenGL (`glxinfo`, `glxgears`) and Vulkan (`vkcube`); `GUI_MATRIX_PICK` selects a GPU index; `GUI_MATRIX_NO_GPU=1` keeps it off the GPU.
