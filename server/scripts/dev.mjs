// Development server: esbuild rebuilds `dist/main.js` on every change under `src/` (and `../lib`),
// and `node --watch` restarts on the new bundle. Reads `server/.env` when there is one.
import { spawn } from 'node:child_process';
import { context } from 'esbuild';

const build = await context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: 'dist/main.js',
  logLevel: 'info',
});
await build.rebuild();
await build.watch();

const server = spawn(process.execPath, ['--watch', '--env-file-if-exists=.env', 'dist/main.js'], {
  stdio: 'inherit',
});
const stop = () => {
  server.kill();
  void build.dispose().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
