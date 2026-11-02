import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const chrome = process.env.SHIYU_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = Number(process.env.SHIYU_UI_PORT ?? 4341);

export default defineConfig({
  testDir: '.', testMatch: ['client.spec.js', 'model-verification.spec.js', 'tasks.spec.js', 'task-validation.spec.js', 'goal-verification.spec.js'], fullyParallel: false, workers: 1,
  timeout: 30000, expect: { timeout: 10000 }, retries: 0, reporter: 'list',
  outputDir: '../../.local/ui/results',
  use: {
    baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium', viewport: { width: 1440, height: 1000 },
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node tests/ui/server.mjs', cwd: packageRoot, url: `http://127.0.0.1:${port}`,
    timeout: 30000, reuseExistingServer: false, env: { SHIYU_UI_PORT: String(port) },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
