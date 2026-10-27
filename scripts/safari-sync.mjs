// Copies the Safari build (`.output/safari-mv3`) into the extension target of the committed Xcode
// project. The project is generated once by `safari-web-extension-converter`; only the web
// extension files change from one build to the next, so they are synced rather than committed.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const source = join(root, '.output/safari-mv3');
const project = join(root, 'safari/Fripon/Fripon.xcodeproj/project.pbxproj');
const target = join(root, 'safari/Fripon/Fripon Extension/Resources');

function fail(message) {
  console.error(`safari:sync: ${message}`);
  process.exit(1);
}

if (!existsSync(join(source, 'manifest.json'))) {
  fail(`no Safari build in ${relative(root, source)}. Run "npm run build:safari" first.`);
}

// The converter lists every top-level entry of the extension in the project (files one by one,
// folders as folder references), so the project only knows the entries that existed when it was
// generated. Content inside a folder (hashed chunk names...) is free to change.
const referenced = new Map();
for (const match of readFileSync(project, 'utf8').matchAll(
  /lastKnownFileType = (\S+); name = [^;]+; path = "?Resources\/([^";]+)"?;/g,
)) {
  referenced.set(match[2], match[1] === 'folder');
}
const built = readdirSync(source).filter((name) => name !== '.DS_Store');

const unknown = built.filter((name) => !referenced.has(name));
const missingFiles = [...referenced].filter(
  ([name, isFolder]) => !isFolder && !built.includes(name),
);
if (unknown.length > 0 || missingFiles.length > 0) {
  fail(
    [
      'the build output no longer matches the Xcode project.',
      unknown.length > 0 ? `  not in the project: ${unknown.join(', ')}` : '',
      missingFiles.length > 0
        ? `  missing from the build: ${missingFiles.map(([n]) => n).join(', ')}`
        : '',
      'Regenerate the project as described in README.md ("Régénérer le projet Xcode").',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
// A folder the project references but this build does not produce (no shared chunk, say) must
// still exist, or Xcode stops on a missing reference.
for (const [name, isFolder] of referenced) {
  if (isFolder) mkdirSync(join(target, name), { recursive: true });
}
console.log(`safari:sync: ${relative(root, source)} -> ${relative(root, target)}`);
