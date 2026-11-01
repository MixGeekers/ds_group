import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.LAB_UI_PORT ?? 4329);
const chrome = process.env.LAB_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const runtime = path.join(root, 'runtime', `browser-test-${Date.now()}`);

export default defineConfig({
  testDir: './tests', testMatch: 'ui.spec.ts', fullyParallel: false, workers: 1,
  timeout: 90000, expect: { timeout: 15000 }, retries: 0,
  reporter: 'list', outputDir: './test-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium',
    viewport: { width: 1440, height: 1100 },
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run build && npm start', cwd: root,
    url: `http://127.0.0.1:${port}`, timeout: 60000,
    reuseExistingServer: false,
    env: { LAB_PORT: String(port), LAB_RUNTIME_DIR: runtime },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
