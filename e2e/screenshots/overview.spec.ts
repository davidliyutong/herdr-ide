import { expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '../harness/fixtures';
import { TermClient } from '../harness/term';
import { cdInTerminal, newTerminalTab, terminalOfPane } from '../harness/ui';
import { waitFor } from '../harness/wait';
import { wants } from './manifest';
import { addRemote, capture, installMonitorData, newChat, newTerminal, prepare, seedWorkspace, sendChat, showMachine } from './support';

(wants('overview') ? test : test.skip)('multi-machine overview screenshot', async ({ app, instance, sshd, term }) => {
  test.setTimeout(300_000);
  await prepare(app, instance);
  await seedWorkspace(instance);
  await newTerminal(app);
  const claude = await terminalOfPane(term, 1);
  await cdInTerminal(app, term, claude, instance.work);
  await app.keyboard.type('claude');
  await app.keyboard.press('Enter');
  await waitFor(() => term.agent(claude).agent_status === 'working', { what: 'Claude to work', timeout: 30_000 });
  await newTerminalTab(app);
  await terminalOfPane(term, 2);
  writeFileSync(join(instance.work, 'block'), '');
  await expect(app.locator('.sidebar')).toContainText(/1 (?:need you|个需要处理)/);
  await installMonitorData(app);

  const remote = await addRemote(app, instance);
  await showMachine(app, 'gpu-server');
  const selected = app
    .locator('.machine')
    .filter({ has: app.locator('.machine-label', { hasText: 'gpu-server' }) })
    .locator('.ws-item.selected');
  await selected.dblclick();
  await selected.locator('input').fill('nanogpt');
  await selected.locator('input').press('Enter');
  const pane = await newChat(app);
  await sendChat(pane, 'demo review');
  await expect(pane).toContainText('Training review');

  const remoteTerm = new TermClient(instance.baseURL, remote);
  try {
    await app.getByRole('button', { name: 'Split Right' }).first().click();
    const addr = await terminalOfPane(remoteTerm, 1);
    await sshd.user(
      `cat > status.sh <<'EOF'\n#!/bin/sh\nprintf '\\033[1;36mnanoGPT\\033[0m  run 042  ·  worker-03  ·  400/400 steps\\n\\n'\nprintf 'GPU 0  NVIDIA RTX 6000   42°C   187W / 300W\\n'\nprintf 'GPU 1  NVIDIA RTX 6000   38°C    94W / 300W\\n\\n'\nprintf 'step=400  loss=2.1470  lr=3.0e-4  val/loss=2.1438\\n'\nprintf '\\033[1;32m✓ checkpoint saved\\033[0m  ·  18,432 samples/s  ·  31.0 GiB VRAM\\n'\nEOF\nchmod +x status.sh`,
    );
    await app.keyboard.type('bash status.sh');
    await app.keyboard.press('Enter');
    await remoteTerm.waitScreen(addr, /checkpoint saved/);
    await capture(app, instance, 'overview', async () => {
      await expect(app.locator('.chat-pane')).toContainText('Training review');
      await expect(app.locator('.sidebar')).toContainText(/1 (?:need you|个需要处理)/);
      const status = app.locator('.monitor-status-item');
      if ((await status.getAttribute('aria-expanded')) !== 'true') await status.click();
      await expect(app.locator('.monitor-popover')).toContainText('NVIDIA RTX 6000');
    });
  } finally {
    remoteTerm.close();
  }
});
