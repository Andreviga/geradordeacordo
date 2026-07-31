// playwright.config.js
// Configuração dos smoke tests end-to-end.
//
// Pré-requisito (uma vez por máquina):
//   npx playwright install chromium
//
// Executar:
//   npm run test:e2e
//   ou: npx playwright test

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir:  './tests/e2e',
  reporter: 'list',
  timeout:  30_000,

  use: {
    baseURL:          'http://localhost:4321',
    headless:         true,
    screenshot:       'only-on-failure',
    video:            'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command:             'node tests/e2e/servidor.js',
    port:                4321,
    reuseExistingServer: !process.env.CI,
    timeout:             10_000,
    stdout:              'pipe',
    stderr:              'pipe',
  },
});
