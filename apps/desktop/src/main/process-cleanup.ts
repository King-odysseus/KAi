import { execFile } from 'node:child_process';
import * as path from 'node:path';

/**
 * What an agent is told when it tries to leave something running in its copy of the project.
 *
 * Agents started preview servers (`node scripts/preview.js &`) in their copies and left them running for hours. A server
 * holds its folder open, so Windows refused to remove the copy (EBUSY) and Autopilot gave up on side-by-side work; it
 * also holds its port, which fails the next check that wants the same one.
 */
export const BACKGROUND_REFUSAL =
  'Not run: this is a copy of the project that KAI deletes when the card is finished, and a process left running in it keeps the folder and its port locked. '
  + 'Do not start servers or anything in the background here. The project\'s check starts and stops what it needs, so run that instead.';

/** Whether a command leaves a process running after it returns: a trailing `&`, nohup, setsid, start /b, Start-Process. */
export function launchesBackgroundProcess(command: string): boolean {
  const text = command.trim();
  if (/(?:^|[^&])&\s*\)?\s*(?:;|\n|$)/.test(text)) return true;
  if (/(?:^|[\s;&|(])(?:nohup|setsid|disown)\b/.test(text)) return true;
  if (/(?:^|[\s;&|(])start\s+\/b\b/i.test(text)) return true;
  return /\bStart-Process\b/i.test(text);
}

/**
 * The part of a copy's path that is the same whichever way Windows spells the rest of it. `os.tmpdir()` can give the
 * short form (`MEGA-M~1`) while a shell command line carries the long one, so only `kai-parallel/<wave>` is compared.
 */
function needlesFor(folder: string): string[] {
  const name = path.basename(folder);
  const parent = path.basename(path.dirname(folder));
  if (!name || !parent) return [];
  return [`${parent}\\${name}`.toLowerCase(), `${parent}/${name}`.toLowerCase()];
}

const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Reads a process's working folder, which Windows keeps in the process itself and does not offer through WMI. A preview
 * server is started as `node scripts/preview.js`, so nothing in its command line says which copy it is holding; its
 * working folder is the only thing that does. Reading it needs the process to be the same user and the same width as
 * the reader, which every process KAI's agents start is; one that cannot be read is simply passed over.
 */
const WORKING_FOLDER_READER = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KaiCwd {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr A; public IntPtr Peb; public IntPtr B; public IntPtr C; public IntPtr Id; public IntPtr D; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref Basic b, int n, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, int n, out IntPtr r);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      Basic b = new Basic(); int r;
      if (NtQueryInformationProcess(h, 0, ref b, Marshal.SizeOf(b), out r) != 0) return null;
      IntPtr n; byte[] p = new byte[8];
      if (!ReadProcessMemory(h, IntPtr.Add(b.Peb, 0x20), p, 8, out n)) return null;
      byte[] u = new byte[16];
      if (!ReadProcessMemory(h, IntPtr.Add((IntPtr)BitConverter.ToInt64(p, 0), 0x38), u, 16, out n)) return null;
      int len = BitConverter.ToUInt16(u, 0);
      if (len <= 0) return null;
      byte[] s = new byte[len];
      if (!ReadProcessMemory(h, (IntPtr)BitConverter.ToInt64(u, 8), s, len, out n)) return null;
      return Encoding.Unicode.GetString(s);
    } catch { return null; } finally { CloseHandle(h); }
  }
}
`;

/**
 * The PowerShell that stops every process whose command line names one of the folders, and everything those started.
 * It never stops itself or anything above it, so KAI is out of reach whatever its own command line says.
 */
/** What to leave alone: with `windowsOnly`, only browsers and apps that were started at or after `since` are stopped. */
export interface CleanupOptions {
  /** Milliseconds since the epoch. Nothing started before this is touched. */
  since?: number;
  /** Only browsers and Electron apps, not servers or tools a person may have running in the project. */
  windowsOnly?: boolean;
}

/** The programs that put a window on the desktop, the mess a finished test leaves behind. */
const WINDOWED_PROGRAMS = '^(?:chrome|msedge|chromium|firefox|brave|electron)(?:\\.exe)?$';

export function processCleanupScript(folders: readonly string[], options: CleanupOptions = {}): string {
  const needles = [...new Set(folders.flatMap(needlesFor))];
  return [
    `$needles = @(${needles.map(quote).join(', ')})`,
    `$windowsOnly = ${options.windowsOnly ? '$true' : '$false'}`,
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.max(0, Math.floor(options.since ?? 0))}).LocalDateTime`,
    `$windowed = ${quote(WINDOWED_PROGRAMS)}`,
    'Add-Type -TypeDefinition @"',
    WORKING_FOLDER_READER.trim(),
    '"@',
    '$self = $PID',
    '$all = @(Get-CimInstance Win32_Process)',
    '$keep = New-Object System.Collections.Generic.HashSet[int]',
    '$cursor = $self',
    'while ($cursor -and $keep.Add([int]$cursor)) { $parent = $all | Where-Object { $_.ProcessId -eq $cursor } | Select-Object -First 1; $cursor = if ($parent) { $parent.ParentProcessId } else { 0 } }',
    '$ids = New-Object System.Collections.Generic.HashSet[int]',
    'foreach ($p in $all) {',
    '  if ($keep.Contains([int]$p.ProcessId)) { continue }',
    '  $line = if ($p.CommandLine) { $p.CommandLine.ToLower() } else { "" }',
    '  $cwd = ([KaiCwd]::Get([int]$p.ProcessId)); $cwd = if ($cwd) { $cwd.ToLower() } else { "" }',
    '  $hit = $false',
    '  foreach ($n in $needles) {',
    "    if ($line.Contains($n + '\\') -or $line.Contains($n + '/') -or $line.EndsWith($n) -or $line.Contains($n + '\"') -or $line.Contains($n + \"'\") -or $cwd.Contains($n + '\\') -or $cwd.EndsWith($n)) { $hit = $true; break }",
    '  }',
    '  if ($hit -and $windowsOnly) { $hit = ($p.Name -match $windowed) -and ($p.CreationDate -ge $since) }',
    '  if ($hit) { [void]$ids.Add([int]$p.ProcessId) }',
    '}',
    '$grew = $true',
    'while ($grew) {',
    '  $grew = $false',
    '  foreach ($p in $all) { if (-not $keep.Contains([int]$p.ProcessId) -and $ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $grew = $true } }',
    '}',
    'foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }',
    'Write-Output $ids.Count',
  ].join('\n');
}

/**
 * Closes what an agent run opened, once the run is over, so a day of testing does not leave the desktop covered in
 * browser windows and half-started apps.
 *
 * In a copy of the project (a card in Autopilot) everything still running in that folder is the card's, and is stopped.
 * In the project itself the folder is shared with the person, so only browsers and apps started since this run began
 * are closed, and the caller does this only when no other run is working there. Windows only, and best effort.
 */
export function closeWhatARunOpened(folder: string, startedAt: number, inACopy: boolean): Promise<number> {
  return stopProcessesInFolders([folder], inACopy ? {} : { since: startedAt - 2_000, windowsOnly: true });
}

/**
 * Stops whatever is still running inside these copies of the project, so Windows lets them be removed. Windows only,
 * and best effort: it returns how many processes it stopped, and zero when it could not tell.
 */
export function stopProcessesInFolders(folders: readonly string[], options: CleanupOptions = {}): Promise<number> {
  if (process.platform !== 'win32' || folders.length === 0) return Promise.resolve(0);
  const encoded = Buffer.from(processCleanupScript(folders, options), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 30_000, windowsHide: true },
      (error, stdout) => resolve(error ? 0 : Number.parseInt(String(stdout).trim(), 10) || 0),
    );
  });
}
