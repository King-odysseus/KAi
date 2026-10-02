/**
 * The commands worth knowing, in the words of someone who has not used a terminal.
 *
 * This is a reference, not a cheat sheet: each entry says what the command does, what a real use looks like, and the
 * moment you would reach for it. Commands that can destroy work are marked, because the difference between `rm` and
 * `rm -rf` is not something a beginner can be expected to know.
 */

export interface CommandExample {
  /** A line to type, exactly as it would be typed. */
  line: string;
  /** What that line does, in one sentence. */
  explains: string;
}

export interface CommandEntry {
  name: string;
  /** One line: what it is for. */
  summary: string;
  /** What it actually does, for someone who has never run it. */
  detail: string;
  examples: CommandExample[];
  /** When to reach for it. */
  useWhen: string;
  /** Says plainly when a command can lose work. */
  caution?: string;
}

export interface CommandGroup {
  title: string;
  /** Why this group is worth knowing, in a sentence. */
  note: string;
  commands: CommandEntry[];
}

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    title: 'Looking around',
    note: 'The three commands you will type more than any others. They change nothing — they only tell you where you are.',
    commands: [
      {
        name: 'pwd',
        summary: 'Print the folder you are currently in.',
        detail: 'Stands for "print working directory". A terminal is always sitting inside one folder, and this says which. When a command fails for no obvious reason, this is the first thing to check.',
        examples: [{ line: 'pwd', explains: 'Shows the full path of the folder you are in, such as /c/Users/you/projects/app.' }],
        useWhen: 'A file you expected is "missing" — you are probably in the wrong folder.',
      },
      {
        name: 'ls',
        summary: 'List what is in a folder.',
        detail: 'On its own it lists the folder you are in. Given a path, it lists that one. It hides files that start with a dot, which is where configuration usually lives.',
        examples: [
          { line: 'ls', explains: 'Lists the visible files and folders here.' },
          { line: 'ls -a', explains: 'Includes the hidden ones, such as .env and .gitignore.' },
        ],
        useWhen: 'You want to know what a project contains before touching it.',
      },
      {
        name: 'cd',
        summary: 'Move into another folder.',
        detail: 'Changes which folder the terminal is working in. Two dots mean "the folder above", and a lone dash means "the one I was just in".',
        examples: [
          { line: 'cd app', explains: 'Moves into the folder called app inside this one.' },
          { line: 'cd ..', explains: 'Moves up one folder.' },
          { line: 'cd -', explains: 'Goes back to the folder you were in before.' },
        ],
        useWhen: 'Before running a project command — they almost always expect to be run from the project root.',
      },
      {
        name: 'cat',
        summary: 'Print a file to the screen.',
        detail: 'Reads a file and shows it. It does not open an editor and cannot change anything, which makes it a safe way to look at a configuration file.',
        examples: [{ line: 'cat package.json', explains: 'Prints that file, so you can see the project scripts and dependencies.' }],
        useWhen: 'You want a quick look at a small file without leaving the terminal.',
      },
    ],
  },
  {
    title: 'Finding things',
    note: 'Once a project has more than a handful of files, you stop browsing and start searching.',
    commands: [
      {
        name: 'grep',
        summary: 'Search for text inside files.',
        detail: 'The single most useful command in an unfamiliar codebase: it finds where a word is used without you knowing which file it is in. It matches part of a line, so searching for "user" also finds "username".',
        examples: [
          { line: 'grep -r "TODO" .', explains: 'Searches every file under this folder for TODO and prints the matching lines with their file names.' },
          { line: 'grep -rn "apiKey" src/', explains: 'Adds line numbers, and searches only the src folder — the -n and the narrower path both help on a big project.' },
          { line: 'grep -ri "postgres" .', explains: 'The -i makes it case-insensitive, so it also matches Postgres and POSTGRES.' },
        ],
        useWhen: 'You need to know where something is defined, or everywhere it is used before you change it.',
      },
      {
        name: 'find',
        summary: 'Find files by their name.',
        detail: 'Where grep searches inside files, find searches the file names themselves. Useful for answering "is there a test folder anywhere in here".',
        examples: [
          { line: 'find . -name "*.test.ts"', explains: 'Lists every test file under this folder, at any depth.' },
          { line: 'find . -type d -name node_modules', explains: 'Finds folders rather than files — here, every node_modules.' },
        ],
        useWhen: 'You know roughly what a file is called but not where it lives.',
      },
      {
        name: 'head / tail',
        summary: 'Show the start or the end of a long file.',
        detail: 'Both read a file without opening it. tail is the one you will use most, because the newest lines — and the error — are at the bottom.',
        examples: [
          { line: 'head -20 README.md', explains: 'Shows the first twenty lines.' },
          { line: 'tail -50 app.log', explains: 'Shows the last fifty lines, which is usually where the failure is.' },
          { line: 'tail -f app.log', explains: 'Keeps printing new lines as they are written. Ctrl+C stops it.' },
        ],
        useWhen: 'A log is too long to read, and the interesting part is the end.',
      },
    ],
  },
  {
    title: 'Running the project',
    note: 'Every JavaScript project answers to the same handful of commands, however different they look inside.',
    commands: [
      {
        name: 'npm install',
        summary: 'Download the packages the project depends on.',
        detail: 'Reads package.json and fetches everything listed there into a node_modules folder. You run this after cloning a project, or after someone adds a dependency. It is safe to run again.',
        examples: [{ line: 'npm install', explains: 'Installs everything the project needs.' }],
        useWhen: 'A project is new to your machine, or imports are failing with "cannot find module".',
      },
      {
        name: 'npm run dev',
        summary: 'Start the project so you can look at it.',
        detail: 'Runs the project\'s development server, usually with reload-on-save. It keeps running until you stop it with Ctrl+C, so it wants its own terminal tab. The exact name comes from the "scripts" block in package.json — it might be "start" or "develop".',
        examples: [
          { line: 'npm run dev', explains: 'Starts the development server and prints the address to open.' },
          { line: 'npm run', explains: 'Lists every script the project defines, when you do not know the name.' },
        ],
        useWhen: 'You want to see the app, or the agent needs a running server to check a screen.',
      },
      {
        name: 'npm test',
        summary: 'Run the project\'s tests.',
        detail: 'Runs whatever the project defines as its test command and reports what passed and what failed. This is the honest answer to "did my change break anything".',
        examples: [{ line: 'npm test', explains: 'Runs the whole suite once and exits.' }],
        useWhen: 'Before committing, and whenever you want to know the true state of the code.',
      },
      {
        name: 'npm run build',
        summary: 'Produce the version that would be deployed.',
        detail: 'Compiles and bundles the project for production. It catches a class of mistakes the dev server tolerates, such as unused imports and type errors, so a passing dev server is not proof.',
        examples: [{ line: 'npm run build', explains: 'Builds the app; a failure here would also have failed on deploy.' }],
        useWhen: 'Before pushing, especially if you cannot run the deploy yourself.',
      },
    ],
  },
  {
    title: 'Git, the short version',
    note: 'Git records what you changed and sends it somewhere else. The everyday loop is status, diff, add, commit, push.',
    commands: [
      {
        name: 'git status',
        summary: 'Show what has changed since the last save point.',
        detail: 'Lists the files you have changed, added or deleted. It changes nothing, so it is always safe, and it is the right first command when you have lost track.',
        examples: [{ line: 'git status', explains: 'Shows the current branch and every file that differs from the last commit.' }],
        useWhen: 'You are about to commit and want to see what you are about to include.',
      },
      {
        name: 'git diff',
        summary: 'Show exactly what changed, line by line.',
        detail: 'Prints the difference between your files and the last commit: removed lines in red, added lines in green. It is the answer to "what did the agent actually do".',
        examples: [
          { line: 'git diff', explains: 'Shows unstaged changes.' },
          { line: 'git diff --staged', explains: 'Shows what is staged, which is what the next commit would contain.' },
        ],
        useWhen: 'Before committing someone else\'s work, or when a change surprised you.',
      },
      {
        name: 'git log --oneline',
        summary: 'Show the history, one line per commit.',
        detail: 'Lists the commits on this branch, newest first. The --oneline shortens each to its hash and message, which is what you want nine times out of ten.',
        examples: [{ line: 'git log --oneline -10', explains: 'Shows the last ten commits.' }],
        useWhen: 'You want to know what has happened here recently, or when something changed.',
      },
      {
        name: 'git add, git commit, git push',
        summary: 'Stage a change, record it, then send it.',
        detail: 'Three separate steps, and the separation is the point. add chooses which changes to include — saying "this, not that". commit records them as one labelled point in the history, on your machine only. push sends those commits to the remote. Until you push, nothing has left your computer.',
        examples: [
          { line: 'git add -A', explains: 'Stages every change, including new and deleted files.' },
          { line: 'git commit -m "Add sign-in validation"', explains: 'Records the staged changes with that message.' },
          { line: 'git push', explains: 'Sends the commits to the remote branch.' },
        ],
        useWhen: 'Finishing a piece of work. Commit small and often — it is a save point, not a milestone.',
        caution: 'A commit is local and easy to undo; a push is not. Check "git diff --staged" before committing, and make sure the branch is the one you meant before pushing.',
      },
    ],
  },
  {
    title: 'Checking it works',
    note: 'The commands that tell you whether the thing you built actually answers.',
    commands: [
      {
        name: 'curl',
        summary: 'Call a URL from the terminal and print what comes back.',
        detail: 'The quickest way to test an endpoint without a browser. It prints the raw response, status code and all, which is exactly what you want when a page is blank and you do not know whether the server or the front end is at fault.',
        examples: [
          { line: 'curl http://localhost:3000/api/health', explains: 'Calls that endpoint and prints the response body.' },
          { line: 'curl -i http://localhost:3000/api/health', explains: 'Adds the response headers, so you can see the status code.' },
          { line: 'curl -X POST -H "Content-Type: application/json" -d \'{"email":"a@b.com"}\' http://localhost:3000/api/login', explains: 'Sends a POST with a JSON body.' },
        ],
        useWhen: 'A screen shows nothing, and you need to know whether the server answered at all.',
      },
      {
        name: 'node -v, npm -v',
        summary: 'Print which versions are installed.',
        detail: 'Projects require a particular Node version, and a mismatch explains a surprising number of failures. These two commands settle that question in a second.',
        examples: [{ line: 'node -v && npm -v', explains: 'Prints both versions on one line.' }],
        useWhen: 'Something installs or builds oddly, and the error does not name a cause.',
      },
    ],
  },
];

/**
 * Every command in the reference, flattened. Exported so a test can check that each entry actually explains itself
 * rather than trusting the list to stay complete as it grows.
 */
export const ALL_COMMANDS: readonly CommandEntry[] = COMMAND_GROUPS.flatMap((group) => group.commands);
