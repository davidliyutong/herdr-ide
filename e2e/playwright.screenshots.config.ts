import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testDir: './screenshots',
  globalSetup: './screenshots/global-setup.ts',
  reporter: [['list'], ['./screenshots/publish.ts']],
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: `../dist/e2e/screenshots-results/${process.pid}`,
  use: {
    ...base.use,
    viewport: { width: 2000, height: 1141 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  },
});
