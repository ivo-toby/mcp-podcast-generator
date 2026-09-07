import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // TinySDD retains isolated worker candidates under this controller-only
    // directory. They are evidence, never project test inputs.
    exclude: [...configDefaults.exclude, '**/.tinysdd/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
