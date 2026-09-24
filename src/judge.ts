import { type JevAsker, type JevQuestions, probability } from './jev.js';

/** One item of a Codex history as Jev is shown it: a message's text, a tool call, or a call's output. */
export interface Entry {
  role: 'user' | 'assistant';
  text: string;
  call?: { callId: string; name: string; input: Record<string, unknown> };
  output?: { callId: string; text: string };
}

/** A call paired with its output: what Jev is asked about. */
export interface Step {
  /** The name Jev knows the step by, in the state and in question names: `t1`, `t2`, … */
  label: string;
  callId: string;
  name: string;
  input: Record<string, unknown>;
  /** Positions of the call and the output among the entries. */
  callAt: number;
  outputAt: number;
  outputChars: number;
  /** In the first entry or the newest ones, so never a candidate. */
  fixed: boolean;
}

/** Jev's probabilities that a step's call, and its whole output, still matter. */
export interface Need {
  call: number;
  output: number;
  /** Jev's own probability for the call, when Runway kept the call's record whatever Jev said. */
  jevCall?: number;
}
/** Keep the step, trim its output to a head and a note, or remove call and output. */
export type Action = 'keep' | 'trim' | 'remove';
export interface Verdict extends Need {
  callId: string;
  action: Action;
}

export interface JudgeOptions {
  /** The task as the user stated it, Jev's `goal`. Default empty. */
  task?: string;
  /** The probability a call or output needs to stay. Default 0.5. */
  threshold?: number;
  /** Newest entries never judged; the first entry never is either. Default 6. */
  recentItems?: number;
  /** Estimated tokens the state may take. Default unlimited: the proxy sets its Jev route's budget. */
  stateTokens?: number;
  /** Estimated tokens the state and one batch of questions may take together. Default unlimited. */
  requestTokens?: number;
  /** Jev calls in flight at once. Default 4. */
  parallel?: number;
  /** Characters a trimmed output keeps. Default 300. */
  headChars?: number;
  /**
   * Needs decided earlier, by call id. Those steps keep their verdicts without being asked about again,
   * and Jev is shown the history with them applied.
   */
  decided?: ReadonlyMap<string, Need>;
}
export type Settings = Required<Omit<JudgeOptions, 'decided'>>;

const DEFAULTS: Settings = {
  task: '',
  threshold: 0.5,
  recentItems: 6,
  stateTokens: Infinity,
  requestTokens: Infinity,
  parallel: 4,
  headChars: 300,
};
const KEEP: Need = { call: 1, output: 1 };
/** Tokens a request spends on its envelope, around the state and the questions. */
const ENVELOPE_TOKENS = 20;

const or = (value: number | undefined, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
function checkThreshold(threshold: number): void {
  if (!(threshold >= 0 && threshold <= 1)) throw new RangeError('threshold must be a probability from 0 to 1');
}

export function settings(options: JudgeOptions = {}): Settings {
  const threshold = or(options.threshold, DEFAULTS.threshold);
  checkThreshold(threshold);
  return {
    task: options.task ?? DEFAULTS.task,
    threshold,
    recentItems: Math.max(0, Math.floor(or(options.recentItems, DEFAULTS.recentItems))),
    stateTokens: Math.max(1, or(options.stateTokens, DEFAULTS.stateTokens)),
    requestTokens: Math.max(1, or(options.requestTokens, DEFAULTS.requestTokens)),
    parallel: Math.max(1, Math.floor(or(options.parallel, DEFAULTS.parallel))),
    headChars: Math.max(0, Math.floor(or(options.headChars, DEFAULTS.headChars))),
  };
}

/**
 * Tokens a text will take, without a tokenizer, erring high: a run of letters costs a token for every six,
 * a run of digits one for every two, and any other character nine tenths of one.
 */
export function estimateTokens(text: string): number {
  let total = 0;
  for (const [run] of text.matchAll(/[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/g)) {
    if (/^[0-9]/.test(run)) total += run.length / 2;
    else if (/^[A-Za-z]/.test(run)) total += Math.ceil(run.length / 6);
    else total += 0.9;
  }
  return Math.ceil(total);
}

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
const fixedAt = (index: number, count: number, recentItems: number) => index === 0 || index >= count - recentItems;

/** Every call with an output, in history order. A call still waiting for its output is not a step yet. */
export function pairSteps(entries: readonly Entry[], recentItems: number): Step[] {
  const calls = new Set<string>();
  const outputs = new Map<string, number>();
  entries.forEach((entry, at) => {
    if (entry.call) {
      if (calls.has(entry.call.callId)) throw new Error(`Call ${entry.call.callId} appears twice`);
      calls.add(entry.call.callId);
    }
    if (entry.output) {
      if (outputs.has(entry.output.callId)) throw new Error(`Call ${entry.output.callId} has two outputs`);
      outputs.set(entry.output.callId, at);
    }
  });
  const steps: Step[] = [];
  entries.forEach((entry, callAt) => {
    const outputAt = entry.call && outputs.get(entry.call.callId);
    if (!entry.call || outputAt === undefined) return;
    if (outputAt < callAt) throw new Error(`Call ${entry.call.callId} has its output before it`);
    steps.push({
      label: `t${steps.length + 1}`,
      ...entry.call,
      callAt,
      outputAt,
      outputChars: entries[outputAt]!.output!.text.length,
      fixed: fixedAt(callAt, entries.length, recentItems) || fixedAt(outputAt, entries.length, recentItems),
    });
  });
  return steps;
}

const STATE_CONTEXT =
  'A coding assistant conversation is being compacted to free context. `history` is the conversation so far, oldest first (a long one is shown in parts, each with its first and newest messages); tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.';
/** Tool input characters the state shows, before and after it has to shrink. Below the second, Jev can no longer tell calls apart. */
const INPUT_LIMITS = [1000, 200];
/** What an abridged text keeps of its start and its end; it must run 40 characters past both to be worth abridging. */
const KEEP_START = 400;
const KEEP_END = 150;

type Line = {
  i: number;
  role: Entry['role'];
  text: string;
  tool_calls?: { id: string; tool: string; input: string; result: string }[];
  pending_calls?: { tool_use_id: string; tool: string; input: string }[];
};
export interface JevState {
  state: { context: string; goal: string; history: Line[] };
  tokens: number;
  stage: 'full' | 'inputs<=200' | 'texts abridged';
}

function inputJson(input: Record<string, unknown>, limit: number): string {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    json = '[unserializable input]';
  }
  return clip(json, limit);
}

/** The history as Jev reads it: one line per entry that says or calls something, outputs shown by size only. */
function lines(entries: readonly Entry[], steps: readonly Step[], inputChars: number): Line[] {
  const stepAt = new Map(steps.map(step => [step.callAt, step]));
  return entries.flatMap((entry, i): Line[] => {
    const step = stepAt.get(i);
    const pending =
      entry.call && !step
        ? [{ tool_use_id: entry.call.callId, tool: entry.call.name, input: inputJson(entry.call.input, inputChars) }]
        : [];
    if (!entry.text.trim() && !step && !pending.length) return [];
    const line: Line = { i, role: entry.role, text: entry.text };
    if (step)
      line.tool_calls = [
        {
          id: step.label,
          tool: step.name,
          input: inputJson(step.input, inputChars),
          result: `${step.outputChars} chars (omitted)`,
        },
      ];
    if (pending.length) line.pending_calls = pending;
    return [line];
  });
}

/**
 * The state for Jev, shrunk until it fits `stateTokens`: tool inputs cut to 200 characters, then long texts
 * abridged, oldest first and fixed entries last. Throws when even that does not fit, so the caller can judge
 * the history in parts instead of making it unreadable.
 */
export function buildState(
  entries: readonly Entry[],
  steps: readonly Step[],
  options: Pick<Settings, 'stateTokens' | 'recentItems' | 'task'>,
): JevState {
  const wrap = (history: Line[]) => ({ context: STATE_CONTEXT, goal: options.task, history });
  const cost = (line: Line) => estimateTokens(JSON.stringify(line)) + 1;
  const base = estimateTokens(JSON.stringify(wrap([])));
  let history: Line[] = [];
  let tokens = 0;
  for (const limit of INPUT_LIMITS) {
    history = lines(entries, steps, limit);
    tokens = base + history.reduce((sum, line) => sum + cost(line), 0);
    if (tokens <= options.stateTokens)
      return { state: wrap(history), tokens, stage: limit === INPUT_LIMITS[0] ? 'full' : 'inputs<=200' };
  }
  const fixed = (line: Line) => fixedAt(line.i, entries.length, options.recentItems);
  for (const line of [...history.filter(line => !fixed(line)), ...history.filter(fixed)]) {
    const { text } = line;
    if (text.length <= KEEP_START + KEEP_END + 40) continue;
    const before = cost(line);
    line.text = `${text.slice(0, KEEP_START)}\n[… ${text.length - KEEP_START - KEEP_END} chars omitted …]\n${text.slice(-KEEP_END)}`;
    tokens += cost(line) - before;
    if (tokens <= options.stateTokens) return { state: wrap(history), tokens, stage: 'texts abridged' };
  }
  throw new Error(`The history does not fit ${options.stateTokens} estimated tokens and stay readable (~${tokens})`);
}

/** The two questions about a step: does the call still matter, and does its whole output. */
export function questionsFor(step: Step): JevQuestions {
  return {
    [`call_${step.label}`]: {
      type: 'noul',
      instructions: `Tool call ${step.label} (${step.name}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${step.label}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${step.label} (${step.name}, ${step.outputChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/** Groups steps so each group's questions fit one request beside the whole state, which every request carries. */
export function batches(steps: readonly Step[], stateTokens: number, requestTokens: number): Step[][] {
  const room = requestTokens - stateTokens - ENVELOPE_TOKENS;
  const groups: Step[][] = [];
  let used = 0;
  for (const step of steps) {
    const size = estimateTokens(JSON.stringify(questionsFor(step)));
    if (size > room)
      throw new Error(`No room for questions beside a state of ~${stateTokens} of ${requestTokens} tokens`);
    if (!groups.length || used + size > room) {
      groups.push([]);
      used = 0;
    }
    groups.at(-1)!.push(step);
    used += size;
  }
  return groups;
}

/** A fixed step stays; otherwise a needed output keeps the step, a needed call alone keeps it trimmed, and neither removes it. */
export function verdict(step: Pick<Step, 'callId' | 'fixed'>, need: Need, threshold: number): Verdict {
  checkThreshold(threshold);
  if (![need.call, need.output].every(value => Number.isFinite(value) && value >= 0 && value <= 1))
    throw new Error('Needs must be probabilities from 0 to 1');
  const action: Action = step.fixed || need.output >= threshold ? 'keep' : need.call >= threshold ? 'trim' : 'remove';
  return { callId: step.callId, ...need, action };
}

/** A trimmed output: its first `headChars` characters and a note saying what went, and where it is saved when it is. */
export function trimmedOutput(text: string, headChars: number, savedAt?: string): string {
  if (text.length <= headChars + 120) return text;
  return `${headChars > 0 ? `${text.slice(0, headChars)}\n` : ''}[Jev Runway truncated ${text.length - headChars} chars of this tool result; ${savedAt ? `the full output is saved in ${savedAt}` : 're-run the tool if needed'}]`;
}

/** The entries as the model reads them once verdicts apply. Entries left with nothing to say drop out. */
export function withVerdicts(entries: readonly Entry[], verdicts: readonly Verdict[], headChars: number): Entry[] {
  const actions = new Map(verdicts.filter(v => v.action !== 'keep').map(v => [v.callId, v.action]));
  return entries.flatMap(entry => {
    const callAction = entry.call && actions.get(entry.call.callId);
    const outputAction = entry.output && actions.get(entry.output.callId);
    if (!callAction && !outputAction) return [entry];
    const next: Entry = { role: entry.role, text: entry.text };
    if (entry.call && callAction !== 'remove') next.call = entry.call;
    if (entry.output && outputAction !== 'remove')
      next.output =
        outputAction === 'trim' ? { ...entry.output, text: trimmedOutput(entry.output.text, headChars) } : entry.output;
    return next.text.trim() || next.call || next.output ? [next] : [];
  });
}

/** Asks about every group, a few at once. The first failure stops the rest and fails the whole. */
async function askAll(
  asker: JevAsker,
  state: object,
  groups: readonly Step[][],
  parallel: number,
): Promise<Map<string, Need>> {
  const needs = new Map<string, Need>();
  let next = 0;
  let failed: { error: unknown } | undefined;
  const worker = async () => {
    while (!failed && next < groups.length) {
      const group = groups[next++]!;
      try {
        const { answers } = await asker.ask(state, Object.assign({}, ...group.map(questionsFor)));
        for (const step of group)
          needs.set(step.callId, {
            call: probability(answers, `call_${step.label}`),
            output: probability(answers, `result_${step.label}`),
          });
      } catch (error) {
        failed ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, groups.length) }, worker));
  if (failed) throw failed.error;
  return needs;
}

/**
 * Verdicts for every step, in `pairSteps` order. Jev sees the whole history, outputs by size only and fitted to
 * the budget, with every group of questions, and is asked about the steps not already decided. Throws when Jev
 * fails, or, before asking anything, when the history does not fit.
 */
export async function judgeSteps(
  entries: readonly Entry[],
  asker: JevAsker,
  options: JudgeOptions = {},
): Promise<Verdict[]> {
  const s = settings(options);
  const steps = pairSteps(entries, s.recentItems);
  const decided = options.decided ?? new Map<string, Need>();
  // Jev reads the history as the model now does, with earlier verdicts applied.
  const earlier = steps
    .filter(step => !step.fixed && decided.has(step.callId))
    .map(step => verdict(step, decided.get(step.callId)!, s.threshold));
  const shown = earlier.length ? withVerdicts(entries, earlier, s.headChars) : entries;
  const shownSteps = earlier.length ? pairSteps(shown, s.recentItems) : steps;
  const open = shownSteps.filter(step => !step.fixed && !decided.has(step.callId));
  let needs = new Map<string, Need>();
  if (open.length) {
    const largest = Math.max(...open.map(step => estimateTokens(JSON.stringify(questionsFor(step)))));
    const stateRoom = s.requestTokens - ENVELOPE_TOKENS - largest;
    if (stateRoom < 1) throw new Error('The request budget leaves no room for a state beside its questions');
    const { state, tokens } = buildState(shown, shownSteps, { ...s, stateTokens: Math.min(s.stateTokens, stateRoom) });
    needs = await askAll(asker, state, batches(open, tokens, s.requestTokens), s.parallel);
  }
  return steps.map(step => verdict(step, decided.get(step.callId) ?? needs.get(step.callId) ?? KEEP, s.threshold));
}
