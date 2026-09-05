import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 1,
  use: {
    baseURL: 'http://localhost:5175',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx http-server . -p 5175 -c-1 --silent',
    url: 'http://localhost:5175',
    reuseExistingServer: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // This disables the very gesture policy the harness's button clicks
        // exist to satisfy, so this suite never exercises gesture-required
        // autoplay. It's here only so playback can start under automation
        // without a genuine OS-level user gesture behind the click.
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
    },
  ],
});
