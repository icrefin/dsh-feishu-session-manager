import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Tests render real components, so JSX must compile with the automatic runtime
  // rather than whatever esbuild defaults to.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.spec.ts'],
  },
})