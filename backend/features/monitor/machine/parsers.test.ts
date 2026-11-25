// The parsers of what Linux's /proc and macOS's programs print, over
// samples of their output.
import { describe, expect, test } from 'bun:test';
import {
  parseBlockStorage,
  parseBoottime,
  parseDF,
  parseIOAccelerator,
  parseLoadAvg,
  parseNetstat,
  parsePS,
  parseSized,
  parseSwapUsage,
  parseTopCPU,
  parseVMStat,
  splitN,
} from './darwin.ts';
import { parseNvidiaApps, parseNvidiaGPUs } from './gpu.ts';
import {
  formatCmdline,
  formatElapsed,
  pageSizeOf,
  parseDiskstats,
  parseLoadavg,
  parseMeminfo,
  parseMounts,
  parseNetDev,
  parsePasswd,
  parsePidStat,
  parseProcStat,
  wholeDisk,
} from './linux.ts';
import { clampPct, parseNum, round1, truncateBytes } from './num.ts';
import { cpuDeltaPct, Rates } from './rates.ts';
import { normalizeState } from './sample.ts';

describe('numbers', () => {
  test('one decimal, halves away from zero; percentages within 0–100; strict parsing', () => {
    expect([round1(1.25), round1(2.5), round1(3.75), round1(-0.05), round1(NaN), round1(Infinity)]).toEqual([1.3, 2.5, 3.8, -0.1, 0, 0]);
    expect([clampPct(-1), clampPct(150), clampPct(66.666), clampPct(NaN)]).toEqual([0, 100, 66.7, 0]);
    expect([parseNum('12.5'), parseNum(' 7 '), parseNum(''), parseNum('0x10'), parseNum('1e3'), parseNum('N/A')]).toEqual([
      12.5,
      7,
      null,
      null,
      1000,
      null,
    ]);
    expect(truncateBytes('aé', 2)).toBe('a�');
    expect(truncateBytes('abc', 5)).toBe('abc');
  });
});

describe('NVIDIA', () => {
  test("nvidia-smi's GPUs; what it does not know is left out", () => {
    const gpus = parseNvidiaGPUs(`0, NVIDIA GeForce RTX 4090, 74, 16384, 24564, 68, 312.5, 450.0
1, NVIDIA GeForce RTX 4090, 12, 1024, 24564, 41, [N/A], 450.0
`);
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toEqual({
      index: 0,
      name: 'NVIDIA GeForce RTX 4090',
      vendor: 'nvidia',
      utilPct: 74,
      memUsedBytes: 16384 * 1024 * 1024,
      memTotalBytes: 24564 * 1024 * 1024,
      memPct: 66.7,
      tempC: 68,
      powerW: 312.5,
      powerLimitW: 450,
    });
    expect(gpus[1].powerW).toBeUndefined();
    expect(JSON.parse(JSON.stringify(gpus[1]))).not.toHaveProperty('powerW');
  });

  test('the GPU memory of processes, summed over their GPUs', () => {
    const m = parseNvidiaApps('1234, 4096\n1234, 1024\n5678, [N/A]\n');
    expect(m.get(1234)).toBe(5120 * 1024 * 1024);
    expect(m.has(5678)).toBe(false);
  });
});

describe('Linux', () => {
  test("/proc/stat's ticks and the busy share between two samples", () => {
    const a = parseProcStat('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\n')!;
    const b = parseProcStat('cpu  200 0 150 950 0 0 0 0 0 0\ncpu0 100 0 100 450 0 0 0 0 0 0\n')!;
    expect(a.cores).toHaveLength(1);
    // total delta 300, idle 150 -> 50%; cpu0: 150 and 50 -> 66.7%
    expect(cpuDeltaPct(a.total, b.total)).toBe(50);
    expect(cpuDeltaPct(a.cores[0], b.cores[0])).toBe(66.7);
    expect(cpuDeltaPct(b.total, a.total)).toBe(0);
    expect(parseProcStat('intr 1 2 3\n')).toBeNull();
  });

  test('/proc/meminfo: used is total less available', () => {
    const m = parseMeminfo(`MemTotal:       16000000 kB
MemFree:         2000000 kB
MemAvailable:    6000000 kB
SwapTotal:       4000000 kB
SwapFree:        3000000 kB
`);
    expect(m).toEqual({
      totalBytes: 16000000 * 1024,
      usedBytes: 10000000 * 1024,
      availableBytes: 6000000 * 1024,
      usedPct: 62.5,
      swapTotalBytes: 4000000 * 1024,
      swapUsedBytes: 1000000 * 1024,
    });
    // Without MemAvailable (older kernels): free, buffers and cache.
    expect(parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 100 kB\nCached: 200 kB\n').usedBytes).toBe(600 * 1024);
  });

  test('/proc/net/dev without the loopback; /proc/diskstats of whole disks only', () => {
    const net = parseNetDev(`Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999999   100 0 0 0 0 0 0 999999 100 0 0 0 0 0 0
  eth0: 100000    10 0 0 0 0 0 0 200000  20 0 0 0 0 0 0
`);
    expect([...net]).toEqual([['eth0', { rx: 100000, tx: 200000 }]]);
    expect(
      parseDiskstats(`   8       0 sda 100 0 2000 0 50 0 1000 0 0 0 0
   8       1 sda1 100 0 2000 0 50 0 1000 0 0 0 0
 259       0 nvme0n1 10 0 400 0 20 0 600 0 0 0 0
 259       1 nvme0n1p1 10 0 400 0 20 0 600 0 0 0 0
   7       0 loop0 1 0 100 0 0 0 0 0 0 0 0
`),
    ).toEqual({ read: (2000 + 400) * 512, write: (1000 + 600) * 512 });
    expect(['sda', 'vdb', 'xvda', 'nvme0n1', 'mmcblk0', 'hdc'].every(wholeDisk)).toBe(true);
    expect(['sda1', 'nvme0n1p2', 'mmcblk0p1', 'loop3', 'zram0', 'sr0', 'dm-0', 'sd'].some(wholeDisk)).toBe(false);
  });

  test("/proc/mounts' disks: devices once, no pseudo file systems, snaps or EFI; escaped names", () => {
    expect(
      parseMounts(`/dev/sda1 / ext4 rw 0 0
proc /proc proc rw 0 0
tmpfs /run tmpfs rw 0 0
/dev/sda1 /var/lib/docker ext4 rw 0 0
/dev/loop0 /snap/core/1 squashfs ro 0 0
/dev/sdb1 /boot/efi vfat rw 0 0
nas:/export /mnt/my\\040nas nfs4 rw 0 0
/dev/sdc1 /snap/x ext4 rw 0 0
overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0
`),
    ).toEqual([
      { device: '/dev/sda1', mount: '/', fsType: 'ext4' },
      { device: 'nas:/export', mount: '/mnt/my nas', fsType: 'nfs4' },
    ]);
  });

  test("a process's stat, command line, age, owner and the page size", () => {
    const st = parsePidStat(
      '4242 (my (odd) prog) S 1 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 1 0 12345 1000000 256 18446744073709551615',
    )!;
    expect(st).toEqual({ comm: 'my (odd) prog', state: 'S', ppid: 1, utime: 250, stime: 50, start: 12345, rssPages: 256 });
    expect(parsePidStat('1 (x) S 0')).toBeNull();
    expect(formatCmdline(Buffer.from('python3\0train.py\0--epochs\0\0'))).toBe('python3 train.py --epochs');
    expect([formatElapsed(83), formatElapsed(3723), formatElapsed(2 * 86400 + 3723), formatElapsed(0)]).toEqual([
      '01:23',
      '01:02:03',
      '2-01:02:03',
      '00:00',
    ]);
    expect(parsePasswd('# x\nroot:x:0:0::/root:/bin/sh\nalice:x:1000:1000::/home/alice:/bin/bash\n')).toEqual(
      new Map([
        [0, 'root'],
        [1000, 'alice'],
      ]),
    );
    const auxv = Buffer.alloc(48);
    auxv.writeBigUInt64LE(3n, 0); // AT_PHDR
    auxv.writeBigUInt64LE(6n, 16); // AT_PAGESZ
    auxv.writeBigUInt64LE(16384n, 24);
    expect(pageSizeOf(auxv)).toBe(16384);
    expect(pageSizeOf(null)).toBe(4096);
    expect(parseLoadavg('1.25 2.50 3.75 2/300 4242\n')).toEqual([1.3, 2.5, 3.8]);
    expect(['R', 'S', 'D', 'U', 'T', 't', 'Z', 'I', 'X', ''].map(normalizeState)).toEqual([
      'R',
      'S',
      'D',
      'D',
      'T',
      'T',
      'Z',
      'I',
      'X',
      '?',
    ]);
  });
});

describe('macOS', () => {
  test("vm_stat's memory as Activity Monitor counts it; swap; top's CPU; load; boot time", () => {
    const mem = parseVMStat(
      `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages wired down:                             100000.
Pages purgeable:                                5000.
Anonymous pages:                              305000.
Pages occupied by compressor:                 100000.
`,
      16 * 1024 ** 3,
    );
    expect(mem.usedBytes).toBe(500000 * 16384);
    expect(parseSwapUsage('total = 4096.00M  used = 1024.00M  free = 3072.00M  (encrypted)')).toEqual({
      total: 4096 * 1024 ** 2,
      used: 1024 * 1024 ** 2,
    });
    expect([parseSized('1.5G'), parseSized('512K'), parseSized('7'), parseSized('x')]).toEqual([1.5 * 1024 ** 3, 512 * 1024, 7, 0]);
    expect(parseTopCPU('Processes: 1\nCPU usage: 10.5% user, 14.5% sys, 75.0% idle\n')).toBe(25);
    expect(parseTopCPU('nothing')).toBeNull();
    expect(parseLoadAvg('{ 1.25 2.50 3.75 }')).toEqual([1.3, 2.5, 3.8]);
    expect(parseBoottime('{ sec = 1000, usec = 156604 } Thu Jan  1 00:16:40 1970', 4_000_000)).toBe(3000);
    expect(parseBoottime('garbage', 4_000_000)).toBe(0);
  });

  test("the GPUs of the IOAccelerator registry, the drives' bytes, netstat's interfaces", () => {
    const gpus = parseIOAccelerator(
      `+-o AGXAcceleratorG16G  <class AGXAcceleratorG16G>
  {
    "model" = "Apple M4"
    "PerformanceStatistics" = {"Device Utilization %"=22,"In use system memory"=1073741824,"Alloc system memory"=2147483648}
  }
`,
      16 * 1024 ** 3,
    );
    // Apple's GPU shares the host's memory.
    expect(gpus).toEqual([
      { index: 0, name: 'Apple M4', vendor: 'apple', utilPct: 22, memUsedBytes: 1073741824, memTotalBytes: 16 * 1024 ** 3, memPct: 6.3 },
    ]);
    expect(
      parseIOAccelerator(
        '+-o X\n  {\n    "model" = "AMD Radeon Pro 5500M"\n    "PerformanceStatistics" = {"vramUsedBytes"=100,"vramFreeBytes"=300}\n  }\n',
        1,
      ),
    ).toEqual([
      { index: 0, name: 'AMD Radeon Pro 5500M', vendor: 'amd', utilPct: undefined, memUsedBytes: 100, memTotalBytes: 400, memPct: 25 },
    ]);
    expect(
      parseBlockStorage(`    "Statistics" = {"Bytes (Read)"=1000,"Operations (Write)"=3,"Bytes (Write)"=500}
    "Statistics" = {"Bytes (Read)"=24,"Bytes (Write)"=12}
`),
    ).toEqual({ read: 1024, write: 512 });
    const net = parseNetstat(`Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                        100     0      10000      100     0      10000     0
en0        1500  <Link#11>   aa:bb:cc:dd:ee:ff   500     0     123456      400     0      65432     0
en0        1500  192.168.1     192.168.1.2       500     -     123456      400     -      65432     -
utun0      1380  <Link#16>                       10     0       1000       20     0       2000     0
`);
    expect([...net]).toEqual([
      ['en0', { rx: 123456, tx: 65432 }],
      ['utun0', { rx: 1000, tx: 2000 }],
    ]);
  });

  test("df's file systems: APFS's data volume as /, the system's volumes left out", () => {
    const disks = parseDF(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1s1 1000000 100000 400000 10% /
/dev/disk3s5 1000000 500000 400000 56% /System/Volumes/Data
/dev/disk3s6 1000000 50000 400000 5% /System/Volumes/VM
/dev/disk4s1 200000 100000 100000 50% /Volumes/My Disk
map auto_home 0 0 0 100% /System/Volumes/Data/home
`)!;
    expect(disks.map((d) => [d.mount, d.usedPct])).toEqual([
      ['/', 60],
      ['/Volumes/My Disk', 50],
    ]);
    expect(parseDF('Filesystem 1024-blocks Used Available Capacity Mounted on\n')).toBeNull();
  });

  test("ps's processes with their whole command lines", () => {
    const procs = parsePS(
      '  100     1 alice  12.5  3.2  65536 R   01:23 /usr/bin/python3\n  101   100 bob 0.0 0.1 10 Ss 1-02:03:04 /Applications/My App.app/Contents/MacOS/My App\n',
      '  100 /usr/bin/python3 train.py --epochs 10\n',
    );
    expect(procs[0]).toEqual({
      pid: 100,
      ppid: 1,
      name: 'python3',
      command: '/usr/bin/python3 train.py --epochs 10',
      user: 'alice',
      cpuPct: 12.5,
      memPct: 3.2,
      rssBytes: 65536 * 1024,
      state: 'R',
      elapsed: '01:23',
    });
    expect(procs[1]).toMatchObject({ name: 'My App', command: '/Applications/My App.app/Contents/MacOS/My App', state: 'S' });
    expect(splitN('a  b\tc d e', 3)).toEqual(['a', 'b', 'c d e']);
  });
});

describe('rates', () => {
  test('between samples of a recent previous one; the first has none', () => {
    const r = new Rates();
    const t0 = 1_000_000;
    const first = r.network(t0, new Map([['eth0', { rx: 1000, tx: 500 }]]));
    expect(first).toMatchObject({ rxBytesPerSec: 0, rxBytes: 1000 });
    const next = r.network(
      t0 + 2000,
      new Map([
        ['eth0', { rx: 3000, tx: 500 }],
        ['idle0', { rx: 0, tx: 0 }],
      ]),
    );
    expect(next).toEqual({
      rxBytesPerSec: 1000,
      txBytesPerSec: 0,
      rxBytes: 3000,
      txBytes: 500,
      interfaces: [{ name: 'eth0', rxBytesPerSec: 1000, txBytesPerSec: 0, rxBytes: 3000, txBytes: 500 }],
    });
    // A counter that went back (an interface reset) gives no rate.
    expect(r.network(t0 + 3000, new Map([['eth0', { rx: 10, tx: 1 }]])).rxBytesPerSec).toBe(0);
    // A previous sample over a minute old gives none either.
    r.diskIO(t0, 0, 0);
    expect(r.diskIO(t0 + 120_000, 1 << 20, 0).readBytesPerSec).toBe(0);
    expect(r.diskIO(t0 + 121_000, 2 << 20, 512).readBytesPerSec).toBe(1 << 20);
  });
});
