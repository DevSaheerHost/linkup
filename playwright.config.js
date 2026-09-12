// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  webServer: {
    command: 'node tests/static-server.js',
    port: 8420,
    reuseExistingServer: true,
    cwd: __dirname,
  },
  use: {
    baseURL: 'http://localhost:8420',
  },
});
