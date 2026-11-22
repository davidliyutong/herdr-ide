import { defineConfig } from '@playwright/test';

// Every test starts an instance of its own (harness/instance.ts), so tests
// run in parallel. Chromium only: the full build (channel "chromium"),
// whose new headless mode has WebGL for the terminals.
export default defineConfig({
  testDir: './tests',
  globalSetup: './harness/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../dist/e2e/report' }]] : 'list',
  outputDir: '../dist/e2e/results',
  use: {
    browserName: 'chromium',
    channel: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
