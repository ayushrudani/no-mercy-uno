import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript sources, so they must be bundled in --
  // otherwise the deployed box would need the whole monorepo to run one file.
  noExternal: ['@nmu/engine', '@nmu/shared'],
});
