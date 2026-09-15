import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './src/tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 180000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    actionTimeout: 15000,
    baseURL: 'http://127.0.0.1:3597',
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node src/apps/studio/dist/server.js',
    url: 'http://127.0.0.1:3597',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      PORT: '3597',
      AGENTFLOW_STUDIO_FIXTURE: '1',
      AGENTFLOW_STUDIO_DATA: '.local/studio-browser-tests',
    },
  },
});
