import type { ViewId } from './types';

/**
 * The guided tour: one short lesson per screen, written by hand. There is no model behind it, so it works offline,
 * costs nothing and cannot say something wrong about the app. A step may name the part of the screen it is about
 * with a CSS selector; when that part is not on screen the hint is still shown, just without the spotlight.
 */

export interface TourStep {
  /** The part of the screen to ring, as a CSS selector. Optional. */
  target?: string;
  title: string;
  body: string;
}

export interface TourLesson {
  view: ViewId;
  title: string;
  /** One line shown in the lessons list. */
  summary: string;
  steps: TourStep[];
}

const RAIL: TourStep = {
  target: '.nav-button.active',
  title: 'You are here',
  body: 'The rail on the left switches between screens. The highlighted button is the one you are on; hover any button to see its name and shortcut.',
};

export const TOUR_LESSONS: TourLesson[] = [
  {
    view: 'workspace',
    title: 'Workspace',
    summary: 'Tell an agent what to build',
    steps: [
      RAIL,
      { target: '[data-tour="composer"]', title: 'The composer', body: 'Describe a task here and press Enter to send it to an agent. Shift+Enter starts a new line. This is where building happens.' },
      { target: '.conversation-sidebar', title: 'Threads and project files', body: 'Use Threads to reopen a conversation or Files to browse this project. Selecting a file opens a full-height code editor beside the composer. Use Edit, Format and Save there without leaving Workspace.' },
      { target: '[data-tour="composer-toolbar"]', title: 'Context, access and refine', body: 'The plus button adds files, images or notes as context. You can paste or attach an image and send it without typing a message. The access menu chooses how much the agent may change. The wand rewrites a rough prompt into a clearer one before you send it.' },
      { title: 'Goals, skills and commands', body: 'Use composer commands for a goal, project context, skills, rules, reviews and handoffs. Search the Skills picker and select the capabilities you want for the next run.' },
      { target: '[data-tour="composer-advanced"]', title: 'Route and run choices', body: 'The agent, model, task, access and execution mode controls stay beside the composer. This button opens the route choice when you want to use the Universal Proxy.' },
      { target: '.conversation-canvas', title: 'Review the work', body: 'The conversation shows tool activity, changed files and verification results. Open a checkpoint review to inspect changes or restore a turn; branch a message when you want to try another direction.' },
      { title: 'Context and live tools', body: 'The right panel shows the context sent to an agent and the current build. The terminal and live preview can stay open while you talk to an agent.' },
      { target: '.titlebar-actions', title: 'The top bar', body: 'Theme, search, the threads and context panels, the live preview and the terminal live up here. Search (the magnifier) finds any command by name.' },
    ],
  },
  {
    view: 'studio',
    title: 'Project Studio',
    summary: 'Turn an idea into a brief, artifacts and a board',
    steps: [
      RAIL,
      { title: 'Start with an idea', body: 'Plan a new project and describe it in a sentence or two. KAI then asks questions one at a time, with suggested answers you can pick or replace. New to this? Use the "ask me more" button for extra questions, or pick "Not sure, you decide".' },
      { target: '.studio-tabs', title: 'Interview, Artifacts, Board, Design', body: 'When the interview ends, these tabs hold what was built. Artifacts are the documents; the Board is the work cards; Design is where the screens get drawn.' },
      { title: 'Artifacts', body: 'Click an artifact to read or edit it. Generate all writes what is missing, and Regenerate all rewrites everything from the brief. The flows artifact opens as a diagram.' },
      { title: 'Board', body: 'Cards move from Backlog to Done. Drag them between columns. A card only reaches Done through a passing check, so work is never marked finished by guesswork.' },
      { title: 'Design and open-pencil', body: 'Connect open-pencil under Settings, Design tools. Then copy the foundation prompt and one prompt per screen into the Workspace composer, letting each finish before the next. Pull the design to tick off the screens it finds.' },
      { title: 'Senior dev and automation', body: 'The Senior dev tab helps turn the plan into coding work. The board can hand cards to agents, while you inspect the brief, artifacts, checks and design as work progresses.' },
    ],
  },
  {
    view: 'graph',
    title: 'Project Graph',
    summary: 'See what blocks what and who holds which card',
    steps: [
      RAIL,
      { target: '.graph-controls', title: 'Pick a project and a view', body: 'Choose a Studio project. Dependencies shows which cards wait on others; Agents shows which agent holds which card right now. The page refreshes by itself.' },
      { target: '.graph-canvas', title: 'The graph', body: 'Each box is a card, coloured by status. Click one to see its details. The graph is read-only: move cards from the Studio board.' },
      { title: 'Follow blockers', body: 'Trace an incoming dependency to see why a card is waiting. Switch to Agents to see current ownership, then open Project Studio when a card needs changing.' },
    ],
  },
  {
    view: 'workflows',
    title: 'Workflows',
    summary: 'Build, save and run sequential agent work',
    steps: [
      RAIL,
      { title: 'Steps run in order', body: 'A workflow is a list of steps, each given to an agent. Build one, save it as a template, and run it again whenever you need the same work done.' },
      { title: 'Agent teams', body: 'The Auto team card plans one prompt per teammate from a goal and shows them for review before anything runs, so you stay in control.' },
      { title: 'Review before reuse', body: 'Check each step’s agent and prompt before running. Saved workflows make recurring work repeatable; the run view shows progress and results step by step.' },
    ],
  },
  {
    view: 'crew',
    title: 'Crew',
    summary: 'A team that plans, builds and checks a whole project',
    steps: [
      RAIL,
      { title: 'Give it a goal', body: 'Describe what to build. A Lead writes the tasks, each with acceptance criteria, and shows you the plan before anything is built if you ask it to.' },
      { title: 'Choose who does what', body: 'On the Crew tab every role has its own agent, subscription or API, model and number of sub-agents. The Lead and reviewers only read; builders can change files.' },
      { title: 'Checked, then accepted', body: 'Each result is checked against its criteria. Problems go back to the builder that wrote them. The crew stops and asks you when it is stuck or a limit is reached.' },
    ],
  },
  {
    view: 'review',
    title: 'Review',
    summary: 'Read what the agent changed, file by file',
    steps: [
      RAIL,
      { title: 'Every turn that changed files', body: 'Pick a turn, then a file, and read its diff. Reject one hunk, restore a whole file, or undo the whole turn. Each file shows whether the latest check covered it.' },
      { title: 'A second opinion', body: 'AI review reads the changed files and lists what to look at, pinned to the file it is about. The verdict at the top says whether the checks and the review agree the work is ready.' },
    ],
  },
  {
    view: 'history',
    title: 'History',
    summary: 'Find, rename, fork and reopen conversations',
    steps: [
      RAIL,
      { title: 'Every conversation is kept', body: 'Search past threads, rename them, archive the ones you are done with, fork one to try another direction, or reopen it to carry on where it stopped.' },
      { title: 'Return to the right project', body: 'A conversation keeps its project context. Open it from History to continue with its messages, files and run record rather than starting a new thread.' },
    ],
  },
  {
    view: 'tasks',
    title: 'Tasks',
    summary: 'Shared board, reviews and handoffs',
    steps: [
      RAIL,
      { title: 'A shared task board', body: 'Tasks, the review queue, the handoff inbox and the decision log live here, so agents and you work from the same list. It needs the C1 brain running.' },
      { title: 'Close the loop', body: 'Open a task to see its owner and state, review work waiting for you, and check handoffs and decisions before sending the next agent instruction.' },
    ],
  },
  {
    view: 'code',
    title: 'Learn & Code',
    summary: 'Edit files with a learning tutor beside you',
    steps: [
      RAIL,
      { title: 'Browse and edit', body: 'The file tree is on the left and the editor in the middle. Saving keeps a file\'s line endings, and KAI warns if the file changed on disk meanwhile.' },
      { title: 'The learning tutor', body: 'The tutor panel explains the file or the code you select, in terms of this project. It teaches rather than just handing over code, and it reads the project\'s plan when the Studio wrote one.' },
      { title: 'Choose how to learn', body: 'Use the tutor controls to ask a question, change the level of help, revisit lesson history or focus on the file. References in an explanation can open the cited file and lines.' },
      { title: 'Quick edits stay in Workspace', body: 'If you are talking with an agent, open a file from Workspace’s Files tab or a reply link to view, edit and save it beside the composer. Use Learn & Code for the full editor and tutor.' },
    ],
  },
  {
    view: 'projects',
    title: 'Projects',
    summary: 'The folders you work in',
    steps: [
      RAIL,
      { title: 'Choose a folder', body: 'Open a folder to work in it. The project picker at the top left switches between the folders you have opened. Studio plans can be linked to a folder once the brief is ready.' },
      { title: 'Manage the project list', body: 'Use Projects to revisit a folder and the picker to switch quickly. The active folder controls which files, Git state and agent context the other screens show.' },
    ],
  },
  {
    view: 'git',
    title: 'Git',
    summary: 'Branches, changes, commits and pull requests',
    steps: [
      RAIL,
      { title: 'Source control without the terminal', body: 'See the changes, stage and commit them, and push or pull. KAI always asks before it pushes, and it never force-pushes.' },
      { title: 'GitHub', body: 'No remote yet? The GitHub section creates the repository for you — you choose private or public — and points origin at it, without uploading anything. Pull requests open through the GitHub CLI when you are signed in to it, and KAI stores no GitHub token.' },
      { title: 'Inspect before publishing', body: 'Check the file changes and branch before committing. Stage only what you want included, then review the remote action before a push or pull request.' },
    ],
  },
  {
    view: 'commands',
    title: 'Terminal Commands',
    summary: 'What the common terminal commands do, and when you would reach for them',
    steps: [
      RAIL,
      { title: 'Written for someone who has not used a terminal', body: 'Each command says what it does, shows a real line with what that line does, and says when you would reach for it — so you can understand a command an agent ran rather than trusting it.' },
      { title: 'Search by what you want, not by name', body: 'Type "search files" and it finds grep. You do not need to know a command exists to find it.' },
      { title: 'Use the live terminal separately', body: 'This page is a reference for learning commands. Open the terminal from the top bar when you want to run a command in the active project.' },
    ],
  },
  {
    view: 'brain',
    title: 'C1 Brain',
    summary: 'The memory agents share',
    steps: [
      RAIL,
      { title: 'What agents remember', body: 'Search, inspect and tidy the notes agents keep between sessions. The knowledge map draws how those notes connect.' },
      { title: 'Check the source of a memory', body: 'Look at the saved note and its project before using it in a new run. Brain tools also expose status, skills and recovery information when C1 is available.' },
    ],
  },
  {
    view: 'rules',
    title: 'Execution Rules',
    summary: 'The standing rules every agent run gets',
    steps: [
      RAIL,
      { title: 'Rules agents must follow', body: 'These standing instructions are sent with each KAI agent turn. Edit them here to guide coding behavior across projects. For enforceable tool and path limits, use Permission rules in Settings, Automation.' },
      { title: 'Review before saving', body: 'Read the current rules, make a focused edit and save it here. A project-specific request can still be explained in the Workspace prompt.' },
    ],
  },
  {
    view: 'proxy',
    title: 'Universal Proxy',
    summary: 'One route to many model providers',
    steps: [
      RAIL,
      { title: 'Status and costs', body: 'See whether the proxy is running, its recent activity and health, and what it has cost. Start it from Settings if you want agents to route through it.' },
      { title: 'Find a route problem', body: 'Inspect provider routing and recent requests here when an agent cannot connect. Settings holds credentials and the controls for starting managed services.' },
    ],
  },
  {
    view: 'usage',
    title: 'Usage',
    summary: 'Estimated spend and limits',
    steps: [
      RAIL,
      { title: 'Watch spend, set limits', body: 'Estimated API spend is listed here. Set a warn or block limit so a long run cannot cost more than you meant it to.' },
      { title: 'Read estimates in context', body: 'Compare usage across recent runs and providers. The figures are estimates; use the provider’s billing page for the final charge.' },
    ],
  },
  {
    view: 'operations',
    title: 'Operations',
    summary: 'What is running, and recovering interrupted work',
    steps: [
      RAIL,
      { title: 'Keep an eye on runs', body: 'Runs, checks and recovery are here. If KAI closed in the middle of a run, you can resume it from this page.' },
      { target: '.ops-tabs', title: 'Four operational views', body: 'Recovery handles interrupted work. Active work shows coordination, Checks shows verification, and Diagnostics helps explain failures or service trouble.' },
      { title: 'Stop a stuck run', body: 'Stop everything stays in the page header on every Operations tab. Use it when a run no longer responds and you need to clear its active state.' },
    ],
  },
  {
    view: 'settings',
    title: 'Settings',
    summary: 'Connections, models, design tools and services',
    steps: [
      RAIL,
      { target: '.settings-search', title: 'Search every setting', body: 'Type a word such as model, token or open-pencil and only the matching cards stay. Press Escape to clear.' },
      { target: '.settings-category-nav', title: 'Categories stay with you', body: 'This bar stays pinned as you scroll, and the current category is underlined. Design tools holds the open-pencil connection.' },
      { title: 'General and connections', body: 'General holds agent defaults, team, automation, editor, updates and shortcuts. Automation has permission rules for tool and path access. Connections and models holds providers, API keys, web search, the connector catalog, tutor settings and MCP servers.' },
      { title: 'Design and services', body: 'Design tools connects open-pencil. Services and access covers the C1 brain, Universal Proxy and remote access; check service status here when a feature is unavailable.' },
      { title: 'Data and diagnostics', body: 'Find local data locations, configuration backups and recent diagnostic logs in the final category. Search a setting’s name when you are unsure where it lives.' },
    ],
  },
];

export function lessonFor(view: ViewId): TourLesson | undefined {
  return TOUR_LESSONS.find((lesson) => lesson.view === view);
}

// --- Progress ----------------------------------------------------------------------------------------------

export const TOUR_STORAGE_KEY = 'kai.tour.v1';

export interface TourProgress {
  /** Whether lessons start by themselves when a screen is opened. Turning it off turns it off everywhere. */
  enabled: boolean;
  /** Screens whose lesson was finished or skipped. */
  done: ViewId[];
}

export const DEFAULT_TOUR_PROGRESS: TourProgress = { enabled: true, done: [] };

/** Reads saved progress, tolerating anything: a missing, old or hand-edited value falls back to the default. */
export function parseTourProgress(raw: string | null): TourProgress {
  if (!raw) return { ...DEFAULT_TOUR_PROGRESS, done: [] };
  try {
    const value = JSON.parse(raw) as { enabled?: unknown; done?: unknown };
    const known = new Set(TOUR_LESSONS.map((lesson) => lesson.view));
    const done = Array.isArray(value.done) ? value.done.filter((item): item is ViewId => typeof item === 'string' && known.has(item as ViewId)) : [];
    return { enabled: value.enabled !== false, done: [...new Set(done)] };
  } catch {
    return { ...DEFAULT_TOUR_PROGRESS, done: [] };
  }
}

/** A lesson starts by itself when the tour is on, nothing else is asking for attention, and it has not been seen. */
export function shouldAutoStart(progress: TourProgress, view: ViewId, suspended: boolean): boolean {
  return progress.enabled && !suspended && Boolean(lessonFor(view)) && !progress.done.includes(view);
}

export function markLessonDone(progress: TourProgress, view: ViewId): TourProgress {
  return progress.done.includes(view) ? progress : { ...progress, done: [...progress.done, view] };
}

export function turnTourOff(progress: TourProgress): TourProgress {
  return { ...progress, enabled: false };
}

export function resetTour(): TourProgress {
  return { enabled: true, done: [] };
}
