/**
 * The pure parts of `npm run desktop:release`: which version comes next, how it is written into package.json, and
 * which files in the release folder are leftovers. Kept apart from the script so they can be tested without a build.
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The next version: "patch", "minor" or "major" counts up from the current one, or an exact x.y.z is used as given. */
export function nextVersion(current, request = 'patch') {
  const match = VERSION.exec(current);
  if (!match) throw new Error(`The current version "${current}" is not x.y.z.`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (request === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (request === 'minor') return `${major}.${minor + 1}.0`;
  if (request === 'major') return `${major + 1}.0.0`;
  if (VERSION.test(request)) return request;
  throw new Error(`"${request}" is not patch, minor, major or an exact x.y.z version.`);
}

/** Writes the version into package.json text, changing nothing else, so the file's line endings and layout survive. */
export function withVersion(text, version) {
  const pattern = /("version"\s*:\s*")[^"]*(")/;
  if (!pattern.test(text)) throw new Error('package.json has no "version" field to change.');
  return text.replace(pattern, `$1${version}$2`);
}

export function readVersion(text) {
  const match = /"version"\s*:\s*"([^"]*)"/.exec(text);
  if (!match) throw new Error('package.json has no "version" field.');
  return match[1];
}

/**
 * What to delete from the release folder before a build: every earlier installer and its blockmap, and the files an
 * interrupted or earlier build leaves behind. The unpacked folder is the builder's own to replace, so it is not listed.
 */
export function staleReleaseFiles(names) {
  return names.filter((name) => (
    /^KAI-Setup-.*\.exe(\.blockmap)?$/i.test(name)
    || /^@kaidesktop-.*\.7z$/i.test(name)
    || name === 'win-unpacked.tmp'
    || name === 'builder-debug.yml'
    || name === 'latest.yml'
  ));
}

/** The installer a build of this version should leave behind. */
export function installerName(version) {
  return `KAI-Setup-${version}.exe`;
}
