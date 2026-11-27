import {
  BOARD_STATUSES,
  STUDIO_DESIGN_PATH,
  artifactKindSchema,
  boardCardSchema,
  createStudioBoard,
  createStudioDesign,
  defaultNeeds,
  isUiCard,
  needsScreenCheck,
  dependencyBlocks,
  readyCards,
  routeFromScreenName,
  isNonScreenName,
  screenRoutesFromPages,
  screenTitleKey,
  studioBoardSchema,
  studioDesignSchema,
  type ArtifactEntry,
  type ArtifactKind,
  type BoardCard,
  type BoardStatus,
  type CardCheck,
  type CardRun,
  type DesignComponent,
  type StudioBoard,
  type StudioDesign,
} from '@kai/contracts';
import type { VerificationRun } from '@kai/contracts';
import type { SpecStore } from './spec-store';

/**
 * The board. It is the only writer of `.kai/spec/board.json`, and the only way a card changes status, whatever the
 * caller is — a KAI agent, an outside agent over MCP, or the UI.
 *
 * The rule the plan calls the whole point is enforced here in code: a card only reaches `done` when there is a
 * passing verification run whose recorded file hashes still match the working tree, and, for a UI card, when the
 * visual check passed. Anything else returns the reason it was blocked. An agent cannot mark done work that does
 * not build.
 */

export const STUDIO_BOARD_PATH = 'board.json';

export interface BoardPorts {
  spec: SpecStore;
  projectRoot(projectId: string): Promise<string>;
  /** The files Git reports as changed, with their content hashes; null when the project is not a repo. */
  dirtyFiles(projectPath: string): Promise<Array<{ path: string; hash: string }> | null>;
  /** The current hash of one file, whether or not Git reports it as changed. Null when it is gone or too large. */
  hashFile(projectPath: string, relativePath: string): Promise<string | null>;
  run(projectId: string, runId: string): Promise<VerificationRun | null>;
  now(): string;
  /**
   * Told after every write, so the windows showing this board can redraw.
   *
   * Optional, so a store built for a test does not need one. It is called from `save`, the single place the board
   * reaches disk, because the writes that matter most are the ones nobody asked for: Autopilot claiming a card and
   * moving it as it works happens in the main process with no renderer IPC involved, and the announcing was done by
   * the IPC handlers instead — so it only ever happened when a person pressed something. A board Autopilot was
   * working on therefore sat still on screen, In Progress at zero, while the file on disk had moved on.
   */
  changed?(projectId: string, board: StudioBoard): void;
}

export interface DoneEvidence {
  run: VerificationRun | null;
  /** Each file the run recorded, with its hash as it is *now* — content, so a commit does not break the match. */
  recordedNow: Array<{ path: string; hash: string | null }> | null;
  /** A changed file that the run never recorded, so the tree has drifted since the check. */
  drifted: boolean;
}

/** Null when the card may be marked `done`; otherwise the one rule that blocked it, for the caller to show. */
export function doneBlockedBy(card: Pick<BoardCard, 'kind' | 'route' | 'check' | 'acceptance'> & Partial<Pick<BoardCard, 'title'>>, evidence: DoneEvidence): string | null {
  if (!card.check) return 'The card has no record of a passing check.';
  if (!evidence.run) return 'The check the card was closed on is no longer in the verification history.';
  if (!evidence.run.passed) return `The recorded check did not pass (${evidence.run.command} exited ${evidence.run.exitCode ?? 'unknown'}).`;
  if (card.acceptance.length > 0) {
    const criterionEvidence = card.check.acceptanceEvidence ?? [];
    const missing = card.acceptance.find((criterion) => !criterionEvidence.some((item) => item.criterion === criterion && item.status === 'passed' && item.evidence.trim()));
    if (missing) return `Acceptance criterion lacks passing evidence: ${missing}`;
  }
  if (needsScreenCheck(card) && card.check.visual !== 'passed') return 'A page, or a component with its own route, needs a passing visual check before it can be done.';
  if (evidence.drifted) return 'Files changed after the check passed, so the result does not cover the current tree.';
  if (evidence.recordedNow === null) return 'The checked files could not be read back to confirm they still match.';
  const missing = evidence.recordedNow.find((file) => file.hash === null);
  if (missing) return `${missing.path} was checked but is no longer on disk.`;
  const changed = evidence.recordedNow.find((file) => file.hash !== evidence.run!.files.find((item) => item.path === file.path)?.hash);
  if (changed) return `${changed.path} changed since the check passed.`;
  return null;
}

/**
 * Cards that read a stale artifact are themselves stale: tokens go, every UI card follows. An artifact that has not
 * been written yet does not stale a card — it simply is not there, which is a different problem from having moved.
 */
export function applyStaleness(cards: readonly BoardCard[], artifacts: readonly ArtifactEntry[]): BoardCard[] {
  const byKind = new Map(artifacts.map((entry) => [entry.kind, entry]));
  return cards.map((card) => {
    const stale = card.needsArtifacts.filter((kind) => byKind.get(kind)?.stale);
    if (stale.length === 0) return card;
    return { ...card, stale: true, staleReason: `${stale.join(', ')} changed since this card was written.` };
  });
}

/**
 * Frees a backlog card that was only waiting on a card that is not on the board.
 *
 * Promotion happens when the board is written, and a card whose dependency was renamed or merged away is not
 * written again, so it sat in the backlog for good and the last card of a finished board never ran. Read-side and
 * in memory only, and only for a card with such a dependency: a card someone moved to the backlog on purpose, with
 * every dependency present and done, is left where it is. The next write saves it.
 */
export function releaseOrphanedWaits(board: StudioBoard): StudioBoard {
  const byId = new Map(board.cards.map((card) => [card.id, card]));
  let changed = false;
  const cards = board.cards.map((card) => {
    if (card.status !== 'backlog' || !card.dependsOn.some((id) => !byId.has(id))) return card;
    if (card.dependsOn.some((id) => dependencyBlocks(id, byId))) return card;
    changed = true;
    return { ...card, status: 'ready' as BoardStatus };
  });
  return changed ? { ...board, cards } : board;
}

/** A backlog card becomes ready once everything it depends on is done. Blocked and in-flight cards are left alone. */
export function promoteReady(cards: readonly BoardCard[]): BoardCard[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return cards.map((card) => {
    if (card.status !== 'backlog') return card;
    const ready = !card.dependsOn.some((id) => dependencyBlocks(id, byId));
    return ready ? { ...card, status: 'ready' as BoardStatus } : card;
  });
}

/**
 * Takes back the staleness a renumbered document put on cards. Such a card was marked because "its" node id changed
 * hands, not because its screen did; once it is linked by name to a node that carries its own name again, the flag
 * is wrong, and leaving it kept the card queued to be built again. Cards marked only because of one of those follow
 * when nothing they are built on is still stale. A card's status is not touched: work it lost is not given back as done.
 */
export function clearRenumberedStaleness(cards: readonly BoardCard[], components: readonly DesignComponent[], at: string, flaggedNow: ReadonlySet<string> = new Set()): BoardCard[] {
  const names = new Map(components.map((component) => [component.id, screenTitleKey(component.name)]));
  const nodeChanged = /^open-pencil node \S+ changed since this card was written\.$/;
  let next = cards.map((card) => {
    // A card this pull itself found changed keeps its flag: only flags left by an earlier, renumbered pull are taken back.
    if (!card.stale || flaggedNow.has(card.id) || !card.staleReason || !nodeChanged.test(card.staleReason) || !card.designRef) return card;
    return names.get(card.designRef) === screenTitleKey(card.title) ? { ...card, stale: false, staleReason: null, updatedAt: at } : card;
  });
  const builtOn = 'Something this card is built on has to be redone for the new design.';
  for (let pass = 0; pass < cards.length; pass += 1) {
    const staleIds = new Set(next.filter((card) => card.stale).map((card) => card.id));
    let cleared = false;
    next = next.map((card) => {
      if (!card.stale || flaggedNow.has(card.id) || card.staleReason !== builtOn || card.dependsOn.some((id) => staleIds.has(id))) return card;
      cleared = true;
      return { ...card, stale: false, staleReason: null, updatedAt: at };
    });
    if (!cleared) break;
  }
  return next;
}

/**
 * Cards holding a node the design changed go stale, and their dependents follow. A card with no `designRef` is not
 * touched: it was not drawn from the design, so a redesign cannot invalidate it.
 */
export function applyDesignStaleness(cards: readonly BoardCard[], changed: readonly string[]): BoardCard[] {
  if (changed.length === 0) return [...cards];
  const moved = new Set(changed);
  const stale = new Set<string>();
  let next = cards.map((card) => {
    if (!card.designRef || !moved.has(card.designRef)) return card;
    stale.add(card.id);
    return { ...card, stale: true, staleReason: `open-pencil node ${card.designRef} changed since this card was written.`, status: card.status === 'done' || card.status === 'review' ? 'backlog' : card.status, claimedBy: card.status === 'inProgress' ? card.claimedBy : null };
  });
  // A card built on a card that must be redone must be redone too, however deep the chain runs.
  for (let pass = 0; pass < cards.length; pass += 1) {
    let changedThisPass = false;
    next = next.map((card) => {
      if (stale.has(card.id) || card.dependsOn.every((id) => !stale.has(id))) return card;
      stale.add(card.id);
      changedThisPass = true;
      return { ...card, stale: true, staleReason: 'Something this card is built on has to be redone for the new design.', status: card.status === 'done' || card.status === 'review' ? 'backlog' : card.status, claimedBy: card.status === 'inProgress' ? card.claimedBy : null };
    });
    if (!changedThisPass) break;
  }
  return next;
}

/**
 * The design's own cards. A component or page the board does not have yet becomes a card carrying its node id; one
 * the board already has has the node id attached rather than a second card.
 *
 * Matched by `designRef` first, then by name. The name comparison is the loose one — the same one the design
 * checklist uses — because the names are written in two different places: a page card from the stories might be
 * "Sign up" and the open-pencil page "Sign-up", and comparing the raw text gave the board two cards for one screen,
 * each of them workable, each of them looking like real work.
 */
export function mergeDesign(
  cards: readonly BoardCard[],
  components: readonly DesignComponent[],
  at: string,
  idFor: (nodeId: string) => string = designCardId,
): BoardCard[] {
  const byNode = new Map(cards.filter((card) => card.designRef).map((card) => [card.designRef as string, card]));
  const byName = new Map<string, BoardCard>();
  for (const card of cards) {
    const key = screenTitleKey(card.title);
    // First one wins: an older card keeps the name, and a card whose title is all punctuation gets no key at all.
    if (key && !byName.has(key)) byName.set(key, card);
  }
  const taken = new Set(cards.map((card) => card.id));
  const added: BoardCard[] = [];
  const merged = [...cards];
  // Which card each node went to in this pull, so a card still pointing at a node another card took can let go of it.
  const assigned = new Map<string, string>();
  for (const component of components) {
    const named = byName.get(screenTitleKey(component.name));
    const held = byNode.get(component.id);
    // An id now carried by a node with another name, while a card carries this node's name, is a renumbered document:
    // open-pencil hands old ids to other nodes. The name wins; following the id linked "Button / Light Danger" to the
    // node that is now "Button / Danger", and the board stopped matching what was drawn.
    const renumbered = held && named && named !== held && screenTitleKey(held.title) !== screenTitleKey(component.name);
    const existing = renumbered ? named : (held ?? named);
    if (existing) {
      assigned.set(component.id, existing.id);
      const index = merged.findIndex((card) => card.id === existing.id);
      // A route the page's name already carries is filled in when the card has none — the backfill for cards written
      // before this existed. A route already on the card is the person's, and the design does not overwrite it.
      const route = existing.route || (component.screen ? routeFromScreenName(component.name) : '');
      merged[index] = { ...existing, designRef: component.id, route, updatedAt: at };
      continue;
    }
    // The component sheet and scratch canvases are drawn pages but not screens; a card for one can never close.
    if (isNonScreenName(component.name)) continue;
    let id = idFor(component.id);
    let suffix = 2;
    while (taken.has(id)) id = `${idFor(component.id)}-${suffix++}`;
    taken.add(id);
    added.push(boardCardSchema.parse({
      id,
      title: component.name.slice(0, 200),
      kind: component.screen ? 'page' : 'component',
      story: `Built from the open-pencil ${component.screen ? 'page' : 'component'} "${component.name}".`,
      acceptance: ['It matches the design node it was drawn from.', 'The design only changes when the node in open-pencil changes.'],
      designRef: component.id,
      route: component.screen ? routeFromScreenName(component.name) : '',
      needsArtifacts: defaultNeeds(component.screen ? 'page' : 'component'),
      status: 'backlog',
      createdAt: at,
      updatedAt: at,
    }));
  }
  // A card still pointing at a node this pull gave to another card lets go of it: one card per node, the right one.
  for (let index = 0; index < merged.length; index += 1) {
    const card = merged[index]!;
    const owner = card.designRef ? assigned.get(card.designRef) : undefined;
    if (owner && owner !== card.id) merged[index] = { ...card, designRef: null, updatedAt: at };
  }
  return [...merged, ...added];
}

/**
 * Brings the board's UI cards into line with what the plan says about each screen's route.
 *
 * A page is always closed on a passing screen check, and a check needs an address to open, so a card without a route
 * could never be closed: Autopilot parked it as "no route" and everything waiting on it waited too. Two cases, both only
 * for a card with no route that is not done:
 * - The plan names a path ("inside `/`"): the card takes it. The plan had the route all along; only the board lacked it.
 * - The plan gives the screen no path (a modal, a popover, the tray menu): a page card becomes a component card. A
 *   component with no route is seen through the page that raises it and closes on the build check alone.
 * A route a person or the design already set is never touched.
 */
export function withPlanRoutes(cards: readonly BoardCard[], pages: string): BoardCard[] {
  const { routes, routeless } = screenRoutesFromPages(pages);
  if (routes.size === 0 && routeless.size === 0) return [...cards];
  return cards.map((card) => {
    if (!isUiCard(card) || card.status === 'done' || card.route.trim()) return card;
    const key = screenTitleKey(card.title);
    const route = routes.get(key);
    if (route) return { ...card, route };
    return card.kind === 'page' && routeless.has(key) ? { ...card, kind: 'component' as const } : card;
  });
}

/** A card id from an open-pencil node id, so the same node always yields the same card. */
export function designCardId(nodeId: string): string {
  const slug = nodeId.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'node';
}

export class StudioBoardStore {
  /** Serializes writes per project and lets the final writer reject a stale read-modify-write transaction. */
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(private readonly ports: BoardPorts) {}

  async read(projectId: string): Promise<StudioBoard> {
    const root = await this.ports.projectRoot(projectId);
    const raw = await this.ports.spec.read(root, STUDIO_BOARD_PATH);
    if (raw === null) return createStudioBoard();
    try {
      const parsed = studioBoardSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error(`The Studio board at ${STUDIO_BOARD_PATH} does not match the expected format (${parsed.error.issues[0]?.message ?? 'invalid board data'}). The file was left untouched.`);
      }
      return releaseOrphanedWaits(parsed.data);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`The Studio board at ${STUDIO_BOARD_PATH} contains invalid JSON. The file was left untouched; restore or repair it before continuing.`);
      }
      throw error;
    }
  }

  /**
   * Replaces the board when the studio generates it from the artifacts and the design. Existing cards keep their
   * status, runs and checks, so regenerating the plan never throws away work already done.
   */
  async replace(projectId: string, generated: readonly BoardCard[], artifacts: readonly ArtifactEntry[]): Promise<StudioBoard> {
    const current = await this.read(projectId);
    const previous = new Map(current.cards.map((card) => [card.id, card]));
    const merged = generated.map((card) => {
      const existing = previous.get(card.id);
      return existing
        ? { ...card, status: existing.status, check: existing.check, runs: existing.runs, claimedBy: existing.claimedBy, notes: existing.notes, reviewDecision: existing.reviewDecision }
        : card;
    });
    return this.save(projectId, { schemaVersion: 1, revision: current.revision, requireAcceptance: current.requireAcceptance, cards: promoteReady(applyStaleness(merged, artifacts)) });
  }

  /**
   * Adds cards without touching the ones already there: a card whose id is on the board is left alone, so adding the
   * same import twice changes nothing. Returns the board and the ids that were actually added.
   */
  async append(projectId: string, cards: readonly BoardCard[], expectedRevision?: number): Promise<{ board: StudioBoard; added: string[] }> {
    const current = await this.read(projectId);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new Error(`The Studio board changed after this proposal (expected revision ${expectedRevision}, found ${current.revision}). Review the updated board before approving again.`);
    }
    const have = new Set(current.cards.map((card) => card.id));
    const fresh = cards.filter((card) => !have.has(card.id));
    if (fresh.length === 0) return { board: current, added: [] };
    const board = await this.save(projectId, { schemaVersion: 1, revision: current.revision, requireAcceptance: current.requireAcceptance, cards: promoteReady([...current.cards, ...fresh]) });
    return { board, added: fresh.map((card) => card.id) };
  }

  async reviewCard(projectId: string, cardId: string, verdict: 'accept' | 'reject'): Promise<BoardCard> {
    const board = await this.read(projectId);
    const card = this.require(board, cardId);
    if (card.status !== 'review') throw new Error(`"${card.title}" is not waiting for review.`);
    const accepted = verdict === 'accept';
    const next = boardCardSchema.parse({
      ...card,
      status: accepted ? 'review' : 'ready',
      reviewDecision: accepted ? 'accepted' : 'rejected',
      notes: accepted ? card.notes : 'Rejected in Review; return to the builder for another pass.',
      updatedAt: this.ports.now(),
      movedBy: 'user',
      movedAt: this.ports.now(),
    });
    await this.save(projectId, { ...board, cards: board.cards.map((item) => item.id === cardId ? next : item) });
    return next;
  }

  async setAcceptanceRequired(projectId: string, required: boolean): Promise<StudioBoard> {
    const board = await this.read(projectId);
    return this.save(projectId, { ...board, requireAcceptance: required });
  }

  /** Moves a card to a new status, enforcing the dependency and done rules. */
  async move(projectId: string, cardId: string, status: BoardStatus, note = '', by: 'user' | 'agent' | 'check' = 'agent'): Promise<BoardCard> {
    const board = await this.read(projectId);
    const card = this.require(board, cardId);
    if (!BOARD_STATUSES.includes(status)) throw new Error(`Unknown board status ${status}.`);
    if (status === 'ready') {
      const byId = new Map(board.cards.map((item) => [item.id, item]));
      const unmet = card.dependsOn.filter((id) => dependencyBlocks(id, byId));
      if (unmet.length > 0) {
        // Named by title, with where each one stands: a person who dragged this card is reading the message, and an id
        // like "scaffold" says nothing about what is in the way or what would clear it.
        const waiting = unmet.map((id) => {
          const blocker = byId.get(id);
          return blocker ? `"${blocker.title}" (${blocker.status === 'review' ? 'in review, not yet checked' : blocker.status})` : id;
        });
        throw new Error(`"${card.title}" cannot go to Ready yet: it waits on ${waiting.join(', ')}, which ${unmet.length === 1 ? 'is' : 'are'} not done.`);
      }
    }
    let next: BoardCard = { ...card, status, reviewDecision: status === 'inProgress' ? null : card.reviewDecision, notes: note || card.notes, updatedAt: this.ports.now(), claimedBy: status === 'inProgress' ? card.claimedBy : null, movedBy: by, movedAt: this.ports.now() };
    if (status === 'done') {
      if (board.requireAcceptance && card.reviewDecision !== 'accepted') throw new Error(`"${card.title}" needs an accepted Review decision before it can move to Done.`);
      if (card.stale) throw new Error(`"${card.title}" is stale: ${card.staleReason ?? 'its design or an input changed.'} Rebuild and check it before marking it done.`);
      const blocked = await this.explainDone(projectId, card);
      if (blocked) throw new Error(blocked);
    }
    next = boardCardSchema.parse(next);
    const moved = board.cards.map((item) => (item.id === cardId ? next : item));
    // A card that is done frees the cards that were waiting on it. Run on every move rather than only on `done`,
    // because this invariant is what makes "ready" mean "workable": a card whose dependencies are all done and which
    // is left in the backlog is work nobody can pick up. Only two things used to promote — this and `replace` — so a
    // card put back in the queue after a block could sit there for good, while Autopilot found nothing ready and the
    // board looked stuck for no stated reason.
    //
    // A card a person moves stays where they put it. Promoting it too would snap a ready card dragged to the backlog
    // straight back to Ready, and a deliberate move is the one thing on this board worth honouring. An agent's move
    // is not a preference, so it does not get that exemption — which is what puts a card an agent parked in the
    // backlog back in the queue when its dependencies turn out to be done after all.
    const promoted = promoteReady(moved);
    const cards = by === 'user' ? promoted.map((item) => (item.id === cardId ? next : item)) : promoted;
    await this.save(projectId, { ...board, cards });
    return next;
  }

  /** Reserves a card for one agent. Two agents never hold the same card: the second claim is refused. */
  async claim(projectId: string, cardId: string, agent: string): Promise<BoardCard> {
    const board = await this.read(projectId);
    const card = this.require(board, cardId);
    if (card.claimedBy && card.claimedBy !== agent) throw new Error(`Card ${cardId} is already held by ${card.claimedBy}.`);
    if (card.status !== 'ready' && card.status !== 'inProgress') throw new Error(`Card ${cardId} is ${card.status}; only a ready card can be claimed.`);
    const next: BoardCard = { ...card, status: 'inProgress', claimedBy: agent, movedBy: 'agent', movedAt: this.ports.now(), updatedAt: this.ports.now() };
    await this.save(projectId, { ...board, cards: board.cards.map((item) => (item.id === cardId ? next : item)) });
    return next;
  }

  /** Records a finished agent turn against the card. It does not move the card: only `move` can do that. */
  async recordRun(projectId: string, cardId: string, run: CardRun): Promise<BoardCard> {
    const board = await this.read(projectId);
    const card = this.require(board, cardId);
    const next: BoardCard = { ...card, runs: [...card.runs, run].slice(-50), updatedAt: this.ports.now() };
    await this.save(projectId, { ...board, cards: board.cards.map((item) => (item.id === cardId ? next : item)) });
    return next;
  }

  /** Records the checks a card is closed on. Whether they are *enough* is decided by `move`, not here. */
  async setCheck(projectId: string, cardId: string, check: CardCheck): Promise<BoardCard> {
    const board = await this.read(projectId);
    const card = this.require(board, cardId);
    const verified = check.visual === 'passed' || check.visual === 'skipped';
    const next: BoardCard = { ...card, check, ...(verified ? { stale: false, staleReason: null } : {}), updatedAt: this.ports.now() };
    await this.save(projectId, { ...board, cards: board.cards.map((item) => (item.id === cardId ? next : item)) });
    return next;
  }

  /**
   * Sets the route a component or page card is checked at.
   *
   * The card's own field, so it does not go through `move` and cannot change a status. Without a way to set it, a UI
   * card whose route the design did not carry had no route at all, and the board will not close a UI card without a
   * passing screen check — so the card was unclosable, and the cards depending on it were stuck behind it for good.
   */
  async setRoute(projectId: string, cardId: string, route: string): Promise<BoardCard> {
    const board = await this.read(projectId);
    const card = this.require(board, cardId);
    if (!isUiCard(card)) throw new Error(`${card.title} is not a component or page, so it has no screen to route to.`);
    const next = boardCardSchema.parse({ ...card, route: route.trim().slice(0, 300), updatedAt: this.ports.now() });
    await this.save(projectId, { ...board, cards: board.cards.map((item) => (item.id === cardId ? next : item)) });
    return next;
  }

  /**
   * Says a card is not a screen of its own, so it needs no route and no screenshot check: a label, a note, a dialog
   * drawn inside another screen. Without this a card the planner called a page could only be given a made-up route,
   * or wait for good with everything behind it.
   */
  async markNotAScreen(projectId: string, cardId: string): Promise<BoardCard> {
    const board = await this.read(projectId);
    const card = this.require(board, cardId);
    const next = boardCardSchema.parse({ ...card, kind: 'component', route: '', updatedAt: this.ports.now() });
    await this.save(projectId, { ...board, cards: board.cards.map((item) => (item.id === cardId ? next : item)) });
    return next;
  }

  /** The next card an agent should pick up, or null when nothing is ready. */
  async next(projectId: string): Promise<BoardCard | null> {
    return readyCards(await this.read(projectId))[0] ?? null;
  }

  /**
   * Folds a pull from open-pencil into the board: cards that hold a node the design changed go stale, and the
   * design's components and pages get their cards. Nothing here can move a card forward — staleness and new cards
   * only, so a redesign never marks work done.
   */
  async applyDesign(projectId: string, components: readonly DesignComponent[], changedNodes: readonly string[], pages = '', dropMissingRefs = false): Promise<StudioBoard> {
    const board = await this.read(projectId);
    const at = this.ports.now();
    // Reconcile a page that Open Pencil confirms exists to its story card even when the AI's titles differ slightly.
    // The page inventory provides the route, and node id provides the durable identity after a match is established.
    let cards = applyDesignStaleness(board.cards, changedNodes);
    const staleBefore = new Set(board.cards.filter((card) => card.stale).map((card) => card.id));
    const flaggedNow = new Set(cards.filter((card) => card.stale && !staleBefore.has(card.id)).map((card) => card.id));
    const pageRoutes = routesFromPagesDocument(pages);
    const designPages = components.filter((component) => component.screen);
    const claimedNodes = new Set<string>();
    const matchedInventoryPages = new Set<number>();
    cards = cards.map((card) => {
      if (card.kind !== 'page') return card;
      let exact = designPages.find((component) => !claimedNodes.has(component.id) && screenTitleKey(component.name) === screenTitleKey(card.title));
      let fromInventoryIndex = pageRoutes.findIndex((page, index) => !matchedInventoryPages.has(index) && screenTitleKey(page.name) === screenTitleKey(card.title));
      if (!exact) {
        const cardWords = titleWords(card.title);
        const candidates = designPages.filter((component) => !claimedNodes.has(component.id)).map((component) => ({ component, score: titleOverlap(cardWords, titleWords(component.name)) })).filter((item) => item.score >= 0.6).sort((a, b) => b.score - a.score);
        if (candidates.length === 1 || (candidates.length > 1 && candidates[0]!.score > candidates[1]!.score)) exact = candidates[0]!.component;
      }
      if (fromInventoryIndex < 0) {
        const cardWords = titleWords(card.title);
        const candidates = pageRoutes.map((page, index) => ({ page, index, score: titleOverlap(cardWords, titleWords(page.name)) })).filter((item) => !matchedInventoryPages.has(item.index) && item.score >= 0.6).sort((a, b) => b.score - a.score);
        if (candidates.length === 1 || (candidates.length > 1 && candidates[0]!.score > candidates[1]!.score)) fromInventoryIndex = candidates[0]!.index;
      }
      const fromInventory = fromInventoryIndex >= 0 ? pageRoutes[fromInventoryIndex] : undefined;
      if (exact) claimedNodes.add(exact.id);
      if (fromInventoryIndex >= 0) matchedInventoryPages.add(fromInventoryIndex);
      return exact ? { ...card, designRef: exact.id, route: card.route || fromInventory?.route || card.route } : card;
    });
    let withDesign = clearRenumberedStaleness(withPlanRoutes(mergeDesign(cards, components, at), pages), components, at, flaggedNow);
    if (dropMissingRefs) {
      // A document adopted after a restart: a card still pointing at a node the new document does not have was drawn
      // in the old one. It reads "not drawn" and is flagged, instead of claiming a screen that is no longer there.
      const present = new Set(components.map((component) => component.id));
      withDesign = withDesign.map((card) => (card.designRef && !present.has(card.designRef)
        ? boardCardSchema.parse({ ...card, designRef: null, stale: true, staleReason: 'The design was restarted in open-pencil and this screen is not in the new document. Draw it again.', updatedAt: at })
        : card));
    }
    return this.save(projectId, { schemaVersion: 1, revision: board.revision, requireAcceptance: board.requireAcceptance, cards: promoteReady(withDesign) });
  }

  /** What KAI last read from open-pencil, or an empty record on a project that has never pulled one. */
  async design(projectId: string): Promise<StudioDesign> {
    const root = await this.ports.projectRoot(projectId);
    const raw = await this.ports.spec.read(root, STUDIO_DESIGN_PATH);
    if (raw === null) return createStudioDesign();
    try {
      const parsed = studioDesignSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : createStudioDesign();
    } catch {
      return createStudioDesign();
    }
  }

  /** Records what the pull saw, so the next pull can tell a redesign from a design nobody touched. */
  async saveDesign(projectId: string, design: StudioDesign): Promise<StudioDesign> {
    const parsed = studioDesignSchema.parse(design);
    const root = await this.ports.projectRoot(projectId);
    await this.ports.spec.write(root, STUDIO_DESIGN_PATH, `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  /**
   * The card drawn from a page KAI renamed takes the new name, so the board and the editor agree. Matched by
   * `designRef`, the same key the pull merges on: `rename_node` moves a node's name but not its id, so the card is
   * still the same card. `mergeDesign` deliberately leaves a title alone, which is right for a pull — a person's
   * edit must survive it — but a rename KAI itself asked for has to land on the board, or the tab and the board
   * would name the same screen two ways.
   */
  async retitleDesignPage(projectId: string, designRef: string, title: string): Promise<StudioBoard> {
    const board = await this.read(projectId);
    const at = this.ports.now();
    const cards = board.cards.map((card) =>
      card.designRef === designRef ? boardCardSchema.parse({ ...card, title: title.slice(0, 200), updatedAt: at }) : card,
    );
    return this.save(projectId, { ...board, cards });
  }

  /**
   * The card for a page KAI deleted stops pointing at a node that is gone. Its `designRef` is cleared and the card is
   * flagged, so the board says why rather than holding a reference nothing answers to — `changedNodes` can only see
   * nodes that are present, so a removal reaches the board through no other path.
   *
   * The card is kept, not removed: the screen is still in `pages.md`, which makes it work still to be drawn, and a
   * card carries the runs, notes and checks a later agent would otherwise lose. Redrawing the screen re-attaches the
   * card by name, the way any new page does.
   */
  async detachDesignPage(projectId: string, designRef: string, reason: string): Promise<StudioBoard> {
    const board = await this.read(projectId);
    const at = this.ports.now();
    const cards = board.cards.map((card) =>
      card.designRef === designRef
        ? boardCardSchema.parse({ ...card, designRef: null, stale: true, staleReason: reason.slice(0, 300), updatedAt: at })
        : card,
    );
    return this.save(projectId, { ...board, cards });
  }

  /** Gathers the evidence for a card and returns why `done` is blocked, or null when it is allowed. */
  private async explainDone(projectId: string, card: BoardCard): Promise<string | null> {
    if (!card.check) return doneBlockedBy(card, { run: null, recordedNow: null, drifted: false });
    const root = await this.ports.projectRoot(projectId);
    const [run, dirty] = await Promise.all([this.ports.run(projectId, card.check.runId), this.ports.dirtyFiles(root)]);
    if (!run) return doneBlockedBy(card, { run: null, recordedNow: null, drifted: false });
    const recordedNow = await Promise.all(run.files.map(async (file) => ({ path: file.path, hash: await this.ports.hashFile(root, file.path) })));
    const recordedPaths = new Set(run.files.map((file) => file.path));
    // The studio's own folder is bookkeeping, not the code under test: writing the board must not invalidate a check.
    const drifted = (dirty ?? []).some((file) => !file.path.startsWith('.kai/') && !recordedPaths.has(file.path));
    return doneBlockedBy(card, { run, recordedNow, drifted });
  }

  private require(board: StudioBoard, cardId: string): BoardCard {
    const card = board.cards.find((item) => item.id === cardId);
    if (!card) throw new Error(`No card ${cardId} on the board.`);
    return card;
  }

  private async save(projectId: string, board: StudioBoard): Promise<StudioBoard> {
    const previous = this.writeTails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.writeTails.set(projectId, tail);
    await previous;
    try {
      const root = await this.ports.projectRoot(projectId);
      const raw = await this.ports.spec.read(root, STUDIO_BOARD_PATH);
      const current = raw === null ? createStudioBoard() : studioBoardSchema.parse(JSON.parse(raw));
      if (current.revision !== board.revision) {
        throw new Error(`The Studio board changed while this update was pending (expected revision ${board.revision}, found ${current.revision}). Reload the board and try again.`);
      }
      // Every write bumps the revision. The check happens inside the serialized queue immediately before writing,
      // so a second agent cannot overwrite the first agent's update after both read the same old revision.
      const parsed = studioBoardSchema.parse({ ...board, revision: board.revision + 1 });
      await this.ports.spec.write(root, STUDIO_BOARD_PATH, `${JSON.stringify(parsed, null, 2)}\n`);
      this.ports.changed?.(projectId, parsed);
      return parsed;
    } finally {
      release();
      if (this.writeTails.get(projectId) === tail) this.writeTails.delete(projectId);
    }
  }
}

function titleWords(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((word) => word.length > 2 && !['the', 'and', 'page', 'screen', 'with', 'for'].includes(word)));
}

function titleOverlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.min(left.size, right.size);
}

function routesFromPagesDocument(pages: string): Array<{ name: string; route: string }> {
  const result: Array<{ name: string; route: string }> = [];
  let name = '';
  for (const line of pages.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { name = heading[1] ?? ''; continue; }
    const match = name ? /Route:?\*{0,2}:?\s*`(\/[^`\s]*)`/i.exec(line) : null;
    if (match?.[1] && !match[1].includes('*')) { result.push({ name, route: match[1] }); name = ''; }
  }
  return result;
}

/** Reads the artifact kinds a card's prompt should be built from, validated so a bad board cannot smuggle one in. */
export function cardArtifacts(card: Pick<BoardCard, 'needsArtifacts'>): ArtifactKind[] {
  return card.needsArtifacts.flatMap((kind) => {
    const parsed = artifactKindSchema.safeParse(kind);
    return parsed.success ? [parsed.data] : [];
  });
}
