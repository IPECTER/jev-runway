import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { callFingerprints, type View } from './responses.js';

// ponytail: in-memory; a restart forgets every session's view, so Codex's full history goes out again.
const MAX_TRACKED_SESSIONS = 256;
/** How long a session's saved outputs are kept after its last write. */
const ARCHIVE_DAYS = 7;

/**
 * Per Codex session: its view, the calls evaluations already considered, and whether one is running;
 * for counting repeats, whether counting has begun, the calls observed, those made since, each
 * fingerprint's and file path's latest call, the calls whose files were read again, and the calls ever
 * dropped; and the results already saved in full.
 */
export type Session = {
  view: View;
  seen: Set<string>;
  evaluating: boolean;
  counting: boolean;
  observed: Set<string>;
  live: Set<string>;
  latest: Map<string, string>;
  latestByPath: Map<string, string>;
  revisited: Set<string>;
  dropped: Set<string>;
  archived: Set<string>;
  lastSent?: Sent;
  /** Model requests seen in this session since Runway started, the turn number the trim ledger uses. */
  turns: number;
  /** Calls already written to the trim ledger since the view last started over. */
  logged: Set<string>;
};
/** A request as sent: the view it went out with, Runway's estimate of its tokens, and the upstream's count. */
type Sent = { view: View; estimated: number; billed: number };
export type RepeatCounter =
  | 'callsObserved'
  | 'callsDropped'
  | 'rerunAfterDrop'
  | 'rerunOtherwise'
  | 'rereadAfterDrop'
  | 'rereadOtherwise';

/** The most recently used sessions; past `MAX_TRACKED_SESSIONS`, the least recently used is forgotten. */
export class Sessions {
  private readonly sessions = new Map<string, Session>();

  get(id: string): Session {
    const session = this.sessions.get(id) ?? {
      view: new Map(),
      seen: new Set(),
      evaluating: false,
      counting: false,
      observed: new Set(),
      live: new Set(),
      latest: new Map(),
      latestByPath: new Map(),
      revisited: new Set(),
      dropped: new Set(),
      archived: new Set(),
      turns: 0,
      logged: new Set(),
    };
    this.sessions.delete(id);
    this.sessions.set(id, session);
    if (this.sessions.size > MAX_TRACKED_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    return session;
  }
}

/**
 * Counts what the model does again, by whether the earlier call was compacted away when it did: calls
 * made again with the same tool and input, and earlier calls whose files a new call names again, each
 * counted once. Code-mode scripts rarely repeat word for word, so the file paths catch the re-reads the
 * exact match misses. Repeats after a drop may mean Jev dropped what was still needed; ordinary ones,
 * such as reading a file again after editing it, set the baseline.
 */
export function countRepeats(
  session: Session,
  payload: Record<string, unknown>,
  count: (counter: RepeatCounter) => void,
): void {
  // The history on the first request predates this process: it is remembered, not counted.
  const history = !session.counting;
  session.counting = true;
  for (const { id, fingerprint, paths } of callFingerprints(payload)) {
    if (session.observed.has(id)) continue;
    session.observed.add(id);
    const earlier = session.latest.get(fingerprint);
    const reread = paths.map(path => session.latestByPath.get(path));
    session.latest.set(fingerprint, id);
    for (const path of paths) session.latestByPath.set(path, id);
    if (history) continue;
    session.live.add(id);
    count('callsObserved');
    if (earlier !== undefined && session.live.has(earlier))
      count(session.view.has(earlier) ? 'rerunAfterDrop' : 'rerunOtherwise');
    for (const previous of reread) {
      if (previous === undefined || !session.live.has(previous) || session.revisited.has(previous)) continue;
      session.revisited.add(previous);
      count(session.view.has(previous) ? 'rereadAfterDrop' : 'rereadOtherwise');
    }
  }
}

/** Counts, once each, the calls made under this process that the session's view now drops. */
export function countDrops(session: Session, count: (counter: RepeatCounter) => void): void {
  for (const id of session.view.keys()) {
    if (session.live.has(id) && !session.dropped.has(id)) {
      session.dropped.add(id);
      count('callsDropped');
    }
  }
}

/**
 * One sample for calibrating Runway's token estimate against the upstream's count: between two requests
 * sent with the same view, how much the reported input grew against how much the estimate did. The
 * instructions and tool definitions both requests carry cancel out, so the growth is the session's new
 * items, mostly tool output: the kind of content a view later removes. Reasoning is billed but not in the
 * estimate, so a sample reads slightly high.
 */
export function calibrationSample(session: Session, sent: Sent): { billed: number; estimated: number } | undefined {
  const last = session.lastSent;
  session.lastSent = sent;
  if (!last || last.view !== sent.view || sent.estimated <= last.estimated || sent.billed <= last.billed)
    return undefined;
  return { billed: sent.billed - last.billed, estimated: sent.estimated - last.estimated };
}

/** The session's trim ledger: a JSON line for each call trimmed, and for each time the view started over. */
export function ledgerPath(archiveDir: string, sessionId: string): string {
  return join(archiveDir, digest(sessionId), 'trims.jsonl');
}

/** Appends to the session's trim ledger, readable only by the user, beside the outputs it saved. */
export function recordTrims(archiveDir: string, sessionId: string, lines: readonly object[]): void {
  if (!lines.length) return;
  const file = ledgerPath(archiveDir, sessionId);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, lines.map(line => `${JSON.stringify(line)}\n`).join(''), { mode: 0o600 });
  } catch {
    // The ledger explains trims; a write that fails must not fail the request.
  }
}

export const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Saves a truncated result once, where the model can read it back, instead of having to re-run the tool. */
export function archiver(archiveDir: string, sessionId: string, session: Session) {
  const dir = join(archiveDir, digest(sessionId));
  return (callId: string, text: string): string | undefined => {
    const file = join(dir, `${digest(callId)}.txt`);
    if (session.archived.has(callId)) return file;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
    session.archived.add(callId);
    return file;
  };
}

/** Removes sessions' saved outputs untouched for `ARCHIVE_DAYS`. */
export function pruneArchive(dir: string, now = Date.now()): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      const path = join(dir, entry);
      if (now - statSync(path).mtimeMs > ARCHIVE_DAYS * 86_400_000) rmSync(path, { recursive: true, force: true });
    } catch {
      /* another prune got there first */
    }
  }
}
