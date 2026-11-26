export const DEMO_NOW = Date.parse('2026-11-26T12:00:00.000Z');
export const NOW = DEMO_NOW / 1000;
const GiB = 1024 ** 3;

export const chartSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760">
<rect width="1200" height="760" fill="#10151d"/><style>text{font-family:-apple-system,BlinkMacSystemFont,sans-serif;fill:#dbe7f5}.muted{fill:#8193a8}.grid{stroke:#2b3949;stroke-width:1}.line{fill:none;stroke:#62a8ff;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}.eval{fill:none;stroke:#69d5ae;stroke-width:4;stroke-linecap:round}</style>
<text x="70" y="74" font-size="30" font-weight="650">nanoGPT · training run 042</text><text class="muted" x="70" y="110" font-size="18">Validation loss · 400 steps · fixed demonstration data</text>
<path class="grid" d="M100 180H1130M100 300H1130M100 420H1130M100 540H1130M100 660H1130"/>
<text class="muted" x="48" y="188" font-size="17">3.6</text><text class="muted" x="48" y="308" font-size="17">3.2</text><text class="muted" x="48" y="428" font-size="17">2.8</text><text class="muted" x="48" y="548" font-size="17">2.4</text><text class="muted" x="48" y="668" font-size="17">2.0</text>
<path class="line" d="M110 192 L140 235 L170 284 L200 323 L230 354 L260 380 L290 400 L320 418 L350 434 L380 448 L410 461 L440 472 L470 482 L500 491 L530 500 L560 508 L590 516 L620 523 L650 530 L680 536 L710 542 L740 548 L770 553 L800 558 L830 563 L860 568 L890 572 L920 576 L950 580 L980 584 L1010 588 L1040 591 L1070 594 L1100 597"/>
<path class="eval" d="M110 214 L170 302 L230 365 L290 407 L350 441 L410 468 L470 490 L530 510 L590 527 L650 541 L710 553 L770 563 L830 572 L890 580 L950 587 L1010 593 L1070 598 L1100 601"/>
<circle cx="1100" cy="597" r="7" fill="#62a8ff"/><circle cx="1100" cy="601" r="6" fill="#69d5ae"/>
<path stroke="#62a8ff" stroke-width="5" d="M770 132h34"/><text x="818" y="139" font-size="17">train / loss</text><path stroke="#69d5ae" stroke-width="4" d="M960 132h34"/><text x="1008" y="139" font-size="17">val / loss</text>
<text class="muted" x="96" y="704" font-size="16">0</text><text class="muted" x="340" y="704" font-size="16">100</text><text class="muted" x="590" y="704" font-size="16">200</text><text class="muted" x="840" y="704" font-size="16">300</text><text class="muted" x="1080" y="704" font-size="16">400</text>
</svg>`;

export const sourceFiles: Record<string, string> = {
  'README.md':
    '# nanoGPT demo\n\nA small, deterministic workspace used for documentation screenshots.\n\n## Training\n\nRun `python train.py --config configs/base.toml`.\n',
  'train.py': `"""A deterministic training-loop illustration."""\nfrom dataclasses import dataclass\nfrom pathlib import Path\n\n@dataclass\nclass Metrics:\n    step: int\n    loss: float\n    learning_rate: float = 3e-4\n\ndef log_interval(step: int) -> bool:\n    return step % 10 == 0\n\ndef train(steps: int = 400):\n    history: list[Metrics] = []\n    for step in range(steps):\n        loss = 2.0 + 1.6 * (0.985 ** step)\n        metrics = Metrics(step, loss)\n        history.append(metrics)\n        if log_interval(step):\n            print(f"step={step:03d} loss={loss:.4f} lr={metrics.learning_rate:.1e}")\n    return history\n\nif __name__ == "__main__":\n    train()\n`,
  'model.py': `import math\nfrom dataclasses import dataclass\n\n@dataclass\nclass AttentionConfig:\n    heads: int = 12\n    dimensions: int = 768\n    dropout: float = 0.1\n    learning_rate: float = 3e-4\n\ndef scaled_dot_product(score: float, config: AttentionConfig) -> float:\n    """Scale attention logits before the softmax."""\n    return score / math.sqrt(config.dimensions // config.heads)\n`,
  'configs/base.toml': 'batch_size = 64\nlearning_rate = 0.0003\nsteps = 400\neval_interval = 20\n',
  'docs/optimization.md':
    '# Optimization notes\n\nThe learning rate follows a cosine decay after a ten-step warmup.\n\n$$\\eta_t = \\eta_{min} + \\frac{1}{2}(\\eta_{max}-\\eta_{min})(1+\\cos(t\\pi/T))$$\n',
  'plots/loss.svg': chartSvg,
  'plots/interference.svg': chartSvg
    .replaceAll('nanoGPT · training run 042', 'Two-source interference')
    .replaceAll('Validation loss · 400 steps · fixed demonstration data', 'Amplitude · phase-aligned sources · fixed demonstration data'),
};

export const browserPage = `<!doctype html><html><head><meta charset="utf-8"><title>nanoGPT · Run 042</title><style>
*{box-sizing:border-box}body{margin:0;background:#0f1720;color:#dce8f5;font:16px -apple-system,BlinkMacSystemFont,sans-serif}main{max-width:1100px;margin:0 auto;padding:54px}header{display:flex;justify-content:space-between;align-items:center}h1{font-size:32px;margin:0 0 8px}h2{font-size:19px;margin:0 0 22px}.muted{color:#8499ae}.ok{background:#143b31;color:#75ddb3;padding:8px 14px;border-radius:18px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:34px 0}.card,.panel{background:#172330;border:1px solid #2b3b4d;border-radius:12px;padding:22px}.value{font-size:30px;font-weight:650;margin:10px 0 5px}.blue{color:#71b3ff}.green{color:#73dab4}.violet{color:#bd9cff}.amber{color:#f0c877}.panel{padding:28px}svg{width:100%;height:300px}.gridline{stroke:#314255}.line{fill:none;stroke:#71b3ff;stroke-width:4}.line2{fill:none;stroke:#73dab4;stroke-width:3}.foot{margin-top:24px;color:#8499ae;font-size:14px}
</style></head><body><main><header><div><h1>nanoGPT · training run 042</h1><div class="muted">gpu-server · worker-03 · fixed demonstration service</div></div><span class="ok">● Running</span></header><section class="grid"><div class="card"><div class="muted">Step</div><div class="value blue">400 / 400</div><div>Complete</div></div><div class="card"><div class="muted">Validation loss</div><div class="value green">2.147</div><div>↓ 0.083 this run</div></div><div class="card"><div class="muted">GPU utilization</div><div class="value violet">87%</div><div>RTX 6000 · 42°C</div></div><div class="card"><div class="muted">Samples / second</div><div class="value amber">18,432</div><div>Stable</div></div></section><section class="panel"><h2>Loss history</h2><svg viewBox="0 0 960 300"><path class="gridline" d="M30 40H930M30 110H930M30 180H930M30 250H930"/><path class="line" d="M35 42 L80 66 L125 94 L170 117 L215 139 L260 156 L305 171 L350 184 L395 195 L440 204 L485 213 L530 220 L575 226 L620 232 L665 237 L710 241 L755 245 L800 249 L845 252 L890 255 L925 258"/><path class="line2" d="M35 55 L80 85 L125 111 L170 134 L215 153 L260 170 L305 184 L350 196 L395 207 L440 216 L485 224 L530 231 L575 237 L620 242 L665 247 L710 251 L755 255 L800 258 L845 261 L890 264 L925 266"/></svg><div class="foot">Forwarded from localhost:3000 on gpu-server · No external network required</div></section></main></body></html>`;

export const metrics = {
  hostname: 'gpu-server',
  os: 'linux',
  arch: 'amd64',
  uptimeSec: 16 * 86400 + 7 * 3600 + 42 * 60,
  timestampMs: DEMO_NOW,
  cpu: { usagePct: 67.4, cores: 32, load1: 18.4, load5: 15.7, load15: 12.2, perCore: [42, 67, 81, 58] },
  memory: {
    totalBytes: 128 * GiB,
    usedBytes: 82 * GiB,
    availableBytes: 46 * GiB,
    usedPct: 64.1,
    swapTotalBytes: 16 * GiB,
    swapUsedBytes: 2 * GiB,
  },
  gpus: [
    {
      index: 0,
      name: 'NVIDIA RTX 6000',
      vendor: 'nvidia',
      utilPct: 87,
      memUsedBytes: 31 * GiB,
      memTotalBytes: 48 * GiB,
      memPct: 64.6,
      tempC: 42,
      powerW: 187,
      powerLimitW: 300,
    },
    {
      index: 1,
      name: 'NVIDIA RTX 6000',
      vendor: 'nvidia',
      utilPct: 36,
      memUsedBytes: 12 * GiB,
      memTotalBytes: 48 * GiB,
      memPct: 25,
      tempC: 38,
      powerW: 94,
      powerLimitW: 300,
    },
  ],
  network: {
    rxBytesPerSec: (842 * 1024 * 1024) / 8,
    txBytesPerSec: (126 * 1024 * 1024) / 8,
    rxBytes: 18.4 * 1024 ** 4,
    txBytes: 4.8 * 1024 ** 4,
    interfaces: [
      {
        name: 'eth0',
        rxBytesPerSec: (842 * 1024 * 1024) / 8,
        txBytesPerSec: (126 * 1024 * 1024) / 8,
        rxBytes: 18.4 * 1024 ** 4,
        txBytes: 4.8 * 1024 ** 4,
      },
    ],
  },
  diskIO: { readBytesPerSec: 428 * 1024 ** 2, writeBytesPerSec: 186 * 1024 ** 2, readBytes: 42 * 1024 ** 4, writeBytes: 19 * 1024 ** 4 },
  disks: [
    {
      mount: '/datasets',
      device: '/dev/nvme1n1p1',
      fsType: 'ext4',
      totalBytes: 4 * 1024 ** 4,
      usedBytes: 2.7 * 1024 ** 4,
      availBytes: 1.3 * 1024 ** 4,
      usedPct: 67.5,
    },
  ],
  sensors: {
    temps: [
      { chip: 'coretemp', label: 'Package', tempC: 64, highC: 82, critC: 100 },
      { chip: 'nvme', label: 'Composite', tempC: 47, highC: 75, critC: 85 },
    ],
    fans: [{ chip: 'nct6798', label: 'CPU fan', rpm: 1240, minRpm: 400, maxRpm: 2200 }],
  },
};

const process = (
  pid: number,
  ppid: number,
  name: string,
  command: string,
  cpuPct: number,
  rssBytes: number,
  state = 'R',
  gpuMemBytes?: number,
) => ({
  pid,
  ppid,
  name,
  command,
  user: 'researcher',
  cpuPct,
  memPct: (rssBytes / (128 * GiB)) * 100,
  rssBytes,
  state,
  elapsed: '04:17:26',
  ...(gpuMemBytes ? { gpuMemBytes } : {}),
});
export const processes = {
  total: 9,
  cores: 32,
  memTotalBytes: 128 * GiB,
  timestampMs: DEMO_NOW,
  processes: [
    process(101, 1, 'systemd', '/sbin/init', 0.1, 180 * 1024 ** 2, 'S'),
    process(820, 101, 'sshd', 'sshd: researcher@pts/2', 0.2, 24 * 1024 ** 2, 'S'),
    process(1200, 820, 'bash', '-bash', 0.1, 8 * 1024 ** 2, 'S'),
    process(2400, 1200, 'python', 'python train.py --config configs/base.toml', 684.2, 38 * GiB, 'R', 29 * GiB),
    process(2401, 2400, 'dataloader', 'python train.py --worker 0', 82.4, 3.2 * GiB, 'S'),
    process(2402, 2400, 'dataloader', 'python train.py --worker 1', 79.8, 3.1 * GiB, 'S'),
    process(2403, 2400, 'dataloader', 'python train.py --worker 2', 76.1, 3 * GiB, 'S'),
    process(2510, 1200, 'tensorboard', 'tensorboard --logdir runs --port 3000', 4.8, 620 * 1024 ** 2, 'S'),
    process(2600, 1200, 'nvidia-smi', 'nvidia-smi --query-gpu=utilization --loop=5', 0.3, 18 * 1024 ** 2, 'S'),
  ],
};

const costRow = (
  day: string,
  provider: string,
  model: string,
  project: string,
  machine: string,
  input: number,
  cached: number,
  output: number,
  requests: number,
  cost: number,
) => ({
  day,
  provider,
  model,
  project,
  machine,
  input,
  cached,
  cacheWrite: Math.round(input * 0.08),
  output,
  reasoning: Math.round(output * 0.2),
  requests,
  cost,
  priced: true,
});
export const costReport = {
  generatedAt: NOW,
  days: 90,
  weekHours: 112,
  monthHours: 480,
  machines: { local: { files: 18 }, 'm-demo-gpu': { files: 12 } },
  rows: [
    costRow('2026-11-20', 'claude', 'claude-opus-5-5', 'nanogpt', 'local', 2800000, 6200000, 380000, 42, 18.42),
    costRow('2026-11-21', 'codex', 'gpt-6-codex', 'nanogpt', 'm-demo-gpu', 3400000, 8100000, 460000, 51, 15.84),
    costRow('2026-11-22', 'claude', 'claude-sonnet-5', 'docs', 'local', 1200000, 4800000, 240000, 36, 7.26),
    costRow('2026-11-23', 'kimi', 'kimi-for-coding', 'nanogpt', 'm-demo-gpu', 5200000, 2400000, 620000, 44, 9.72),
    costRow('2026-11-24', 'grok', 'grok-code-fast-1', 'visualization', 'local', 1800000, 1200000, 280000, 29, 5.38),
    costRow('2026-11-25', 'claude', 'claude-opus-5-5', 'nanogpt', 'local', 4200000, 9800000, 720000, 68, 26.18),
    costRow('2026-11-25', 'codex', 'gpt-6-codex', 'nanogpt', 'm-demo-gpu', 2600000, 5400000, 390000, 38, 12.64),
    costRow('2026-11-26', 'claude', 'claude-sonnet-5', 'nanogpt', 'local', 1600000, 4200000, 310000, 31, 8.92),
    costRow('2026-11-26', 'kimi', 'kimi-for-coding', 'visualization', 'm-demo-gpu', 2200000, 1800000, 260000, 24, 4.76),
  ],
  recentSince: NOW - 8 * 86400,
  recent: [
    { at: NOW - 5400, provider: 'claude', machine: 'local', tokens: 1280000, requests: 24, cost: 8.42, priced: true },
    { at: NOW - 3600, provider: 'claude', machine: 'local', tokens: 940000, requests: 18, cost: 6.28, priced: true },
  ],
};

export const usageSnapshot = {
  updatedAt: NOW,
  refresh: 'manual',
  interval: 1800,
  nextAt: NOW + 1800,
  polling: false,
  machines: { local: { status: 'ok', at: NOW }, 'm-demo-gpu': { status: 'ok', at: NOW } },
  status: {},
  alerts: [],
  accounts: [
    {
      key: 'claude:demo',
      provider: 'claude',
      id: 'demo',
      email: 'research@example.com',
      plan: 'Claude Max',
      status: 'ok',
      machines: ['local', 'm-demo-gpu'],
      fetchedAt: NOW,
      seenAt: NOW,
      windows: [
        { id: 'session', kind: 'session', usedPct: 62, resetsAt: NOW + 10080, windowSec: 18000, pace: { expectedPct: 55 } },
        { id: 'weekly', kind: 'weekly', usedPct: 38, resetsAt: NOW + 345600, windowSec: 604800, pace: { expectedPct: 41 } },
        { id: 'opus', kind: 'model', label: 'Opus', usedPct: 47, resetsAt: NOW + 259200, windowSec: 604800, pace: { expectedPct: 43 } },
      ],
      credits: { enabled: true, used: 42.18, limit: 100, unit: 'USD' },
    },
    {
      key: 'codex:demo',
      provider: 'codex',
      id: 'demo',
      email: 'research@example.com',
      plan: 'ChatGPT Pro',
      status: 'ok',
      machines: ['m-demo-gpu'],
      fetchedAt: NOW,
      seenAt: NOW,
      windows: [
        {
          id: 'session',
          kind: 'session',
          usedPct: 81,
          resetsAt: NOW + 5400,
          windowSec: 18000,
          pace: { expectedPct: 70, beforeReset: true, exhaustsAt: NOW + 4200 },
        },
        { id: 'weekly', kind: 'weekly', usedPct: 56, resetsAt: NOW + 432000, windowSec: 604800, pace: { expectedPct: 52 } },
      ],
    },
    {
      key: 'kimi:demo',
      provider: 'kimi',
      id: 'demo',
      plan: 'Coding',
      status: 'ok',
      machines: ['m-demo-gpu'],
      fetchedAt: NOW,
      seenAt: NOW,
      windows: [
        { id: 'weekly', kind: 'weekly', usedPct: 24, resetsAt: NOW + 388800, windowSec: 604800, pace: { expectedPct: 31 } },
        { id: 'monthly', kind: 'monthly', usedPct: 31, resetsAt: NOW + 1036800, windowSec: 2592000, pace: { expectedPct: 28 } },
      ],
      balances: [{ currency: 'USD', total: 38.5, granted: 20, toppedUp: 18.5 }],
    },
    {
      key: 'grok:demo',
      provider: 'grok',
      id: 'demo',
      plan: 'SuperGrok',
      status: 'ok',
      machines: ['local'],
      fetchedAt: NOW,
      seenAt: NOW,
      windows: [{ id: 'weekly', kind: 'weekly', usedPct: 18, resetsAt: NOW + 302400, windowSec: 604800, pace: { expectedPct: 25 } }],
    },
  ],
};
