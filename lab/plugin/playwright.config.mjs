import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const chrome = process.env.LAB_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = Number(process.env.GYM_UI_PORT ?? 4339);

export default defineConfig({
  testDir: './tests', testMatch: 'client.spec.js', fullyParallel: false, workers: 1,
  timeout: 60000, expect: { timeout: 15000 }, retries: 0, reporter: 'list',
  outputDir: '../test-results/plugin',
  use: {
    baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node plugin/tests/ui/server.mjs', cwd: root,
    url: `http://127.0.0.1:${port}`, timeout: 30000, reuseExistingServer: false,
    env: { GYM_UI_PORT: String(port) }, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
