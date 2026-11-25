# Test machines: old kernels and C libraries

Containers share the host's kernel, so they can only vary the C library.
Whether something works on an old kernel (a system call that is missing,
a flag it does not know) needs a machine that boots that kernel. This
harness gives a test payload both, from one manifest:

- `local`: the host itself;
- `docker`: a container of an old distribution (its glibc or musl, the
  host's kernel);
- `vm`: a KVM guest booted from the distribution's official cloud image
  (its own kernel and C library).

`machines.py` downloads and verifies the images, boots them, runs a
payload in each and writes one result file per machine.

## Requirements

On the host that runs the machines (Linux x86_64, KVM): `/dev/kvm`
readable by the user (group `kvm`), `qemu-system-x86_64`, `qemu-img`,
`python3` (3.8 or later), `ssh`, `ssh-keygen`, `tar`, `curl`, and `docker`
for the container kinds. No root: VMs use QEMU's user-mode network, and
cloud-init gets its NoCloud seed over HTTP from the harness itself (the
guest reaches the host's loopback at 10.0.2.2 and finds the URL in the
SMBIOS serial number), so no ISO tools are needed.

## Use

```sh
./machines.py fetch vm-centos-7              # download, verify sha256
./machines.py up vm-centos-7                 # boot, wait for ssh
./machines.py ssh vm-centos-7 -- uname -r
./machines.py copy vm-centos-7 ./dist --to work
./machines.py status
./machines.py down vm-centos-7               # or: down --all
./machines.py run-matrix payloads/bun-probe/run.sh vm-centos-7 docker-centos-7 -j 3
./machines.py clean                          # down --all, pulled images, work dir
```

`run-matrix SCRIPT [IMAGE...]` (all images without names) takes the
script's directory as the payload (`--payload DIR` for another one),
copies it into each machine (a container gets it mounted read-only at
`/payload`), runs `sh SCRIPT` there with `MACHINE_NAME` and
`MACHINE_KIND` set, and writes its output to `RESULTS/<image>.txt`
(`--results`, default `$MACHINES_WORK/results`), headed by the machine's
`uname` and `ldd --version`. `-j N` runs N machines at a time; machines
it started are stopped afterwards unless `--keep`. Its exit status is 0
when every payload exited 0.

Everything the harness creates is under one work directory:

| Variable | Default | |
| --- | --- | --- |
| `MACHINES_WORK` | `./.machines-work` | VM overlays, console logs, the ssh key, results |
| `MACHINES_CACHE` | `$MACHINES_WORK/cache` | downloaded images |
| `MACHINES_PREFIX` | the product's slug + `-machines` | names of VMs and containers; label `<prefix>.image` |
| `MACHINES_TTL` | `7200` | seconds after which a machine left running stops by itself |
| `MACHINES_MANIFEST` | `images.json` beside the script | |

`down --all` and `clean` touch only QEMU processes of the user named
`<prefix>-*` and containers with the label; `clean` removes only the
Docker images the harness pulled itself (`$MACHINES_WORK/docker-pulled`).
On exit or interruption the harness stops what it started, except what
`up` was asked to leave running; that ends after `MACHINES_TTL`.

A VM gets a copy-on-write overlay over the cached image (the image is
never written), 2 vCPUs and 2 GiB, `-cpu host` unless the entry names a
CPU model (QEMU's default model, qemu64, lacks SSE4.2, and Bun then stops
with `error: this CPU is missing SSE4.2 support, which Bun requires.`),
and the
image's default user with a key generated in the work directory. ssh
never consults the caller's ssh agent. `ssh` passes its standard input
through (`docker exec -i`, ssh), so a script that runs it should give it
`</dev/null` unless it means to pipe something in. A VM's serial console is
`vms/<image>/console.log`; the seed server's requests are in
`vms/<image>/seed.log`.

## On a remote KVM host

```sh
host=kvm-host
tar -C e2e/machines -cf - . | ssh $host 'mkdir -p ~/machines && tar -xf - -C ~/machines'
ssh $host 'cd ~/machines && payloads/bun-probe/fetch-runtimes.sh'
ssh $host 'cd ~/machines && MACHINES_WORK=~/machines/.work setsid nohup \
  ./machines.py run-matrix payloads/bun-probe/run.sh -j 3 >matrix.log 2>&1 </dev/null &'
ssh $host 'tail -f ~/machines/matrix.log'
scp "$host:machines/.work/results/*" results/
ssh $host 'cd ~/machines && MACHINES_WORK=~/machines/.work ./machines.py clean && cd && rm -rf ~/machines'
```

Run it detached (`setsid nohup`) so a dropped connection does not end
the matrix; outside the copied directory set `MACHINES_PREFIX`, since
the product's slug is read from `backend/shared/lib/brand.ts` of the checkout.

## Adding an image

Add an entry to `images.json`:

- `name`: unique; by convention `vm-<distro>-<version>` or
  `docker-<distro>-<version>`.
- `kind`: `vm`, `docker` or `local`.
- `vm`: `url` of the qcow2 cloud image (pin a dated release directory,
  not `current` or `latest`), `fallback` URLs (archive mirrors), `sha256`
  of the file (verified on download; `sha512` too where the publisher
  lists only that), `user` (the image's default cloud-init user),
  optionally `cpu`, `memory` (MiB), `cpus`, `boot_timeout` (seconds).
- `docker`: `image` and `digest` (the registry's manifest digest, from
  `docker buildx imagetools inspect <image>`), optionally `prepare`, a
  command run as root before the payload (e.g. installing a library).
- `expect`: `kernel` (a prefix of `uname -r`, checked for VMs) and `libc`,
  what the machine should report.

The image must run cloud-init with the NoCloud data source (official
cloud images do) and an ssh server.

## Payloads

- `payloads/bun-probe`: whether the Bun runtime and the system calls the
  machine agent makes through `bun:ffi` work on the machine (peer
  credentials, flock, fcntl locks, SQLite locking, openat2, renameat2,
  process groups, PTYs). `fetch-runtimes.sh [DIR]` downloads the runtimes
  into `rt/` (or `DIR`, pinned digests) before a run.
- `payloads/machine-node`: the TypeScript machine side driven as a core
  drives it over ssh (`node dial`, yamux on its standard input and output):
  the node answers, the terminal core it installs and starts runs a
  terminal, a file is written and read back, links are refused where they
  must be (by the system calls and by the files feature), peer credentials
  name the user, `node stop --terminal-core` ends it all. `build.sh` (on a
  computer with the repository) bundles `machine.js` and `driver.js` and
  fetches herdr-core and the runtimes; `build.sh --no-rt` leaves the
  runtimes to `../bun-probe/fetch-runtimes.sh payloads/machine-node/rt` on
  the KVM host (`RUNTIMES="bun-linux-x64-baseline
  bun-linux-x64-musl-baseline"`). A machine the core would refuse (musl
  without libstdc++ and libgcc, no SSE4.2) passes as refused.
