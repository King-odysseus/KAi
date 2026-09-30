#!/usr/bin/env node
// kai: run one prompt through KAI from a terminal, a script or another agent.
//
//   kai run "fix the failing tests" --project . --agent claude --full
//
// KAI must be installed, and the project must already be open in KAI once. If KAI is running, it does the work in
// place; if not, KAI starts without a window, does the work, and exits. Exit codes: 0 done, 1 the run failed,
// 2 bad usage, 3 timed out waiting for KAI.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AGENTS = ['claude', 'codex', 'qwen', 'gemini', 'kimi'];

export const USAGE = `Usage: kai run [options] <prompt>
       echo "prompt" | kai run [options] -

Options:
  -C, --project <dir>   Project folder (default: the current folder). It must already be open in KAI.
  -a, --agent <name>    ${AGENTS.join(', ')} (default: claude)
  -m, --model <name>    Model for this run
      --api             Use the direct API from KAI's settings instead of the agent's own CLI
      --proxy           Send the run through the Universal Proxy (default: direct sign-in)
      --plan            Read-only run (default)
      --full            Let the agent edit files and run commands without asking
      --timeout <min>   How long to wait for KAI (default: 60)
      --json            Print the whole result as JSON
  -h, --help            Show this help
`;

/** Turn command-line arguments into a job, or an error message. Pure, so it can be tested. */
export function parseArguments(argv, cwd = process.cwd(), readStdin = () => '') {
  const options = { agent: 'claude', execution: 'cli', route: 'direct', autonomy: 'plan', project: cwd, timeoutMinutes: 60, json: false };
  const words = [];
  const args = argv[0] === 'run' ? argv.slice(1) : [...argv];
  const need = (index, flag) => {
    const value = args[index + 1];
    if (value === undefined || (value.startsWith('-') && value !== '-')) throw new Error(`${flag} needs a value.`);
    return value;
  };
  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-h' || arg === '--help') return { help: true };
      else if (arg === '-C' || arg === '--project') { options.project = path.resolve(cwd, need(index, arg)); index += 1; }
      else if (arg === '-a' || arg === '--agent') { options.agent = need(index, arg); index += 1; }
      else if (arg === '-m' || arg === '--model') { options.model = need(index, arg); index += 1; }
      else if (arg === '--timeout') { options.timeoutMinutes = Number(need(index, arg)); index += 1; }
      else if (arg === '--api') options.execution = 'api';
      else if (arg === '--proxy') options.route = 'proxy';
      else if (arg === '--plan') options.autonomy = 'plan';
      else if (arg === '--full') options.autonomy = 'full';
      else if (arg === '--json') options.json = true;
      else if (arg === '-') words.push(readStdin());
      else if (arg.startsWith('-') && arg.length > 1) throw new Error(`Unknown option ${arg}.`);
      else words.push(arg);
    }
  } catch (error) {
    return { error: error.message };
  }
  if (!AGENTS.includes(options.agent)) return { error: `Unknown agent "${options.agent}". Choose one of: ${AGENTS.join(', ')}.` };
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) return { error: '--timeout must be a number of minutes above zero.' };
  const prompt = words.join(' ').trim();
  if (!prompt) return { error: 'Say what the agent should do.' };
  return { options, prompt };
}

/** Where KAI is installed: KAI_EXE, the app this script ships inside, or the usual per-user install. */
export function findKaiExecutable(env = process.env, platform = process.platform, scriptDirectory = path.dirname(fileURLToPath(import.meta.url)), exists = fs.existsSync) {
  const candidates = [];
  if (env.KAI_EXE) candidates.push(env.KAI_EXE);
  if (platform === 'win32') {
    candidates.push(path.resolve(scriptDirectory, '..', '..', 'KAI.exe'));
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'KAI', 'KAI.exe'));
  } else if (platform === 'darwin') {
    candidates.push('/Applications/KAI.app/Contents/MacOS/KAI');
  } else {
    candidates.push(path.resolve(scriptDirectory, '..', '..', 'kai'), '/opt/KAI/kai');
  }
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2), process.cwd(), () => fs.readFileSync(0, 'utf8'));
  if (parsed.help) { process.stdout.write(USAGE); return 0; }
  if (parsed.error) { process.stderr.write(`kai: ${parsed.error}\n\n${USAGE}`); return 2; }
  const executable = findKaiExecutable();
  if (!executable) { process.stderr.write('kai: could not find KAI. Install it, or set KAI_EXE to its path.\n'); return 2; }

  const id = randomUUID();
  const jobFile = path.join(os.tmpdir(), `kai-job-${id}.json`);
  const resultFile = path.join(os.tmpdir(), `kai-result-${id}.json`);
  const { options, prompt } = parsed;
  fs.writeFileSync(jobFile, JSON.stringify({
    id, prompt, project: options.project, agent: options.agent, execution: options.execution, route: options.route,
    autonomy: options.autonomy, ...(options.model ? { model: options.model } : {}), resultFile,
  }));
  spawn(executable, ['--kai-job', jobFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

  const deadline = Date.now() + options.timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      let result;
      try {
        result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      fs.rmSync(resultFile, { force: true });
      if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else if (result.status === 'completed') process.stdout.write(`${result.output}\n`);
      else process.stderr.write(`kai: ${result.error || 'the run failed'}\n${result.output ? `${result.output}\n` : ''}`);
      return result.status === 'completed' ? 0 : 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stderr.write(`kai: KAI did not finish within ${options.timeoutMinutes} minutes. The run may still be going inside KAI.\n`);
  return 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (error) => { process.stderr.write(`kai: ${error.message}\n`); process.exit(1); });
}
