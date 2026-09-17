import { defineConfig } from '@playwright/test';
const visual = process.env['AGENTFLOW_VISUAL'] === '1';
const port = visual ? 3598 : 3597;
export default defineConfig({
  testDir: './src/tests/browser',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  updateSnapshots: 'none',
  timeout: 180000,
  expect: { timeout: 15000, toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 80, threshold: 0.2 } },
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env['PLAYWRIGHT_HTML_OUTPUT_DIR'] ?? 'playwright-report' }], ['junit', { outputFile: process.env['PLAYWRIGHT_JUNIT_OUTPUT_FILE'] ?? 'test-results/browser.xml' }]],
  outputDir: process.env['PLAYWRIGHT_OUTPUT_DIR'] ?? 'test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  projects: visual
    ? [{ name: 'visual', testMatch: /visual\.spec\.ts/, use: { locale: 'zh-CN', timezoneId: 'Asia/Singapore', colorScheme: 'light', reducedMotion: 'reduce', deviceScaleFactor: 1 } }]
    : [{ name: 'journeys', testIgnore: /visual\.spec\.ts/ }],
  use: {
    actionTimeout: 15000,
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1453, height: 874 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node src/apps/studio/dist/server.js',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      PORT: String(port),
      AGENTFLOW_STUDIO_FIXTURE: '1',
      AGENTFLOW_STUDIO_DATA: process.env['AGENTFLOW_BROWSER_DATA'] ?? '.local/studio-browser-tests',
    },
  },
});
