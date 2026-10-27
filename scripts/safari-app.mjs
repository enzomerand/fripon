// Builds the Safari app (container app + web extension) for macOS, Debug, ad-hoc signed: no Apple
// Developer account or team needed. Run `npm run safari:app` rather than this file: it builds and
// syncs the extension first.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const project = join(root, 'safari/Fripon/Fripon.xcodeproj');
const derivedData = join(root, '.output/safari-xcode');
const app = join(derivedData, 'Build/Products/Debug/Fripon.app');

const result = spawnSync(
  'xcodebuild',
  [
    '-project',
    project,
    '-scheme',
    'Fripon',
    '-configuration',
    'Debug',
    '-derivedDataPath',
    derivedData,
    // Ad-hoc signature ("-"), no team: enough for Safari's "Allow unsigned extensions".
    'CODE_SIGN_IDENTITY=-',
    'CODE_SIGN_STYLE=Manual',
    'DEVELOPMENT_TEAM=',
    'build',
  ],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd().split('\n');
if (result.error) {
  console.error(`safari:app: cannot run xcodebuild (${result.error.message}). Is Xcode installed?`);
  process.exit(1);
}
if (result.status !== 0 || !existsSync(app)) {
  console.error(lines.slice(-60).join('\n'));
  console.error('safari:app: xcodebuild failed.');
  process.exit(result.status || 1);
}
console.log(lines.find((line) => line.includes('BUILD SUCCEEDED')) ?? 'Done.');
console.log(`\nsafari:app: ${relative(root, app)}\n  ${app}`);
