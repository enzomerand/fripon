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

if (!existsSync(project)) {
  fail(
    `Xcode project not found: ${relative(root, project)}. See docs/safari.md ("Régénérer le projet Xcode").`,
  );
}
const pbxproj = readFileSync(project, 'utf8');

// The converter targets the macOS of the machine that ran it (27.0 today), which would stop the
// app from launching on any older macOS: every deployment target must stay at the supported one.
const tooHigh = new Set();
for (const match of pbxproj.matchAll(/MACOSX_DEPLOYMENT_TARGET = "?([\d.]+)"?;/g)) {
  if (parseFloat(match[1]) > 13) tooHigh.add(match[1]);
}
if (tooHigh.size > 0) {
  fail(
    `the Xcode project targets macOS ${[...tooHigh].join(', ')}: set MACOSX_DEPLOYMENT_TARGET back to ` +
      `13.0 everywhere in ${relative(root, project)} (project and Fripon Extension target), or the ` +
      'app will not launch on an older macOS.',
  );
}

// The converter lists every top-level entry of the extension in the project (files one by one,
// folders as folder references), so the project only knows the entries that existed when it was
// generated. Content inside a folder (hashed chunk names...) is free to change.
const referenced = new Map();
for (const match of pbxproj.matchAll(
  /lastKnownFileType = (\S+);(?: name = [^;]+;)? path = "?Resources\/([^";]+)"?;/g,
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
      'Regenerate the project as described in docs/safari.md ("Régénérer le projet Xcode").',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

try {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
  // A folder the project references but this build does not produce (no shared chunk, say) must
  // still exist, or Xcode stops on a missing reference.
  for (const [name, isFolder] of referenced) {
    if (isFolder) mkdirSync(join(target, name), { recursive: true });
  }
} catch (error) {
  fail(`could not copy the build into ${relative(root, target)}: ${error.message}`);
}
console.log(`safari:sync: ${relative(root, source)} -> ${relative(root, target)}`);
