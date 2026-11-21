import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 55_000,
  expect: { timeout: 10_000 },
  reporter: 'list'
})
