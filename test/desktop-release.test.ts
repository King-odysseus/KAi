import { describe, expect, it } from 'vitest';
// @ts-expect-error The release helpers are plain ESM for the script, with no type declarations.
import { installerName, nextVersion, readVersion, staleReleaseFiles, withVersion } from '../scripts/desktop-release-lib.mjs';

describe('choosing the next desktop version', () => {
  it('counts up a patch, a minor or a major version', () => {
    expect(nextVersion('1.2.6', 'patch')).toBe('1.2.7');
    expect(nextVersion('1.2.6')).toBe('1.2.7');
    expect(nextVersion('1.2.6', 'minor')).toBe('1.3.0');
    expect(nextVersion('1.2.6', 'major')).toBe('2.0.0');
  });

  it('takes an exact version as given, and refuses anything else', () => {
    expect(nextVersion('1.2.6', '1.4.0')).toBe('1.4.0');
    expect(() => nextVersion('1.2.6', 'soon')).toThrow(/not patch, minor, major/);
    expect(() => nextVersion('banana', 'patch')).toThrow(/not x.y.z/);
  });
});

describe('writing the version into package.json', () => {
  const text = '{\r\n  "name": "@kai/desktop",\r\n  "version": "1.2.6",\r\n  "dependencies": { "x": "1.2.6" }\r\n}\r\n';

  it('changes only the version and keeps the file\'s line endings', () => {
    const next = withVersion(text, '1.2.7');
    expect(next).toBe(text.replace('"version": "1.2.6"', '"version": "1.2.7"'));
    expect(next).toContain('"x": "1.2.6"');
    expect(next).toContain('\r\n');
    expect(readVersion(next)).toBe('1.2.7');
  });

  it('refuses a file with no version', () => {
    expect(() => withVersion('{}', '1.0.0')).toThrow(/no "version"/);
  });
});

describe('what the release command clears out first', () => {
  it('lists old installers, their blockmaps and the build leftovers, and nothing else', () => {
    const names = [
      'KAI-Setup-1.2.5.exe', 'KAI-Setup-1.2.5.exe.blockmap', '@kaidesktop-1.2.0-x64.nsis.7z', 'win-unpacked.tmp',
      'builder-debug.yml', 'latest.yml', 'win-unpacked', 'notes.txt', 'KAI-Portable.zip',
    ];
    expect(staleReleaseFiles(names)).toEqual(['KAI-Setup-1.2.5.exe', 'KAI-Setup-1.2.5.exe.blockmap', '@kaidesktop-1.2.0-x64.nsis.7z', 'win-unpacked.tmp', 'builder-debug.yml', 'latest.yml']);
  });

  it('names the installer a build should leave', () => {
    expect(installerName('1.2.7')).toBe('KAI-Setup-1.2.7.exe');
  });
});
