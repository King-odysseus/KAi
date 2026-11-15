#!/usr/bin/env node
/**
 * One command for a desktop release: bump the version, clear the old installers and build leftovers, build into
 * apps/desktop/release, and check the installer is there.
 *
 *   npm run desktop:release              next patch version (1.2.7 -> 1.2.8)
 *   npm run desktop:release -- minor     next minor version
 *   npm run desktop:release -- 1.4.0     an exact version
 *   npm run desktop:release -- keep      build the current version again, without bumping
 *
 * It does not commit, push or install: those stay a decision. It stops, and says why, if the unpacked folder is held
 * open (usually an Explorer window on it), because the build cannot replace a folder Windows will not let go of.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installerName, nextVersion, readVersion, staleReleaseFiles, withVersion } from './desktop-release-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const release = path.join(desktop, 'release');
const packagePath = path.join(desktop, 'package.json');

function fail(message) {
  console.error(`\ndesktop:release stopped: ${message}`);
  process.exit(1);
}

const request = process.argv[2] ?? 'patch';
const text = fs.readFileSync(packagePath, 'utf8');
const current = readVersion(text);
const version = request === 'keep' ? current : nextVersion(current, request);

// The unpacked folder has to be replaceable. A rename and back is a harmless way to ask Windows whether it is held open.
const unpacked = path.join(release, 'win-unpacked');
if (fs.existsSync(unpacked)) {
  const probe = `${unpacked}.probe`;
  try {
    fs.renameSync(unpacked, probe);
    fs.renameSync(probe, unpacked);
  } catch {
    fail(`${unpacked} is held open, probably by an Explorer window or a program started from it. Close it and run this again.`);
  }
}

if (version !== current) {
  fs.writeFileSync(packagePath, withVersion(text, version));
  console.log(`Version ${current} -> ${version}`);
} else {
  console.log(`Building version ${version} again.`);
}

fs.mkdirSync(release, { recursive: true });
for (const name of staleReleaseFiles(fs.readdirSync(release))) {
  fs.rmSync(path.join(release, name), { recursive: true, force: true });
  console.log(`Removed ${name}`);
}

// `ELECTRON_RUN_AS_NODE` is set by some editors and makes the packaged app run as plain Node, so it is dropped here.
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
console.log('Building. This takes a few minutes.\n');
const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dist', '--workspace', '@kai/desktop'], {
  cwd: root, env: environment, stdio: 'inherit', shell: process.platform === 'win32',
});
if (build.status !== 0) fail('the build failed. The version in package.json was already changed; run with "keep" to build it again.');

const installer = path.join(release, installerName(version));
if (!fs.existsSync(installer)) fail(`the build finished but ${installerName(version)} is not in ${release}.`);
if (!fs.existsSync(path.join(release, 'win-unpacked', 'resources', 'app.asar'))) fail('the build has no app.asar to install.');

const megabytes = (fs.statSync(installer).size / 1024 / 1024).toFixed(0);
console.log(`\nDone. ${installer} (${megabytes} MB)`);
