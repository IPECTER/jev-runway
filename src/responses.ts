import { createHash } from 'node:crypto';
import type { JevAsker } from './jev.js';
import {
  type Entry,
  estimateTokens,
  type JudgeOptions,
  judgeSteps,
  type Need,
  pairSteps,
  type Step,
  settings,
  trimmedOutput,
  type Verdict,
  verdict,
} from './judge.js';

type Item = Record<string, unknown>;

/**
 * A session's compaction decisions by call_id: the calls every later request drops, or sends with a
 * truncated result. It stands in for a compacted transcript, which a proxy cannot write: Codex keeps its
 * own history and resends all of it with every request.
 */
export type View = ReadonlyMap<string, Need>;

/** First words of the prompt Codex sends when it compacts a conversation itself (codex-rs templates/compact/prompt.md). */
const CODEX_COMPACTION_PROMPT = 'You are performing a CONTEXT CHECKPOINT COMPACTION';
const KEEP: Need = { call: 1, output: 1 };

export interface EvaluationOptions extends JudgeOptions {
  /** Evaluate once this much tool output has arrived since the last evaluation. Default 32000. */
  minToolChars?: number;
  /** call_ids an earlier evaluation already considered. */
  seen?: ReadonlySet<string>;
  /**
   * A call Jev would remove keeps its record and loses only its output, as a dropped result does. Jev
   * lets almost every old call go, reads being cheap to repeat; the record, a few hundred characters,
   * still tells the model what it already looked at, and where the saved output is.
   */
  keepCalls?: boolean;
}
export interface ViewOptions extends JudgeOptions {
  /** Saves a truncated result's full text and returns where, so the note can point the model there. */
  archive?: (callId: string, text: string) => string | undefined;
}
export interface ViewResult {
  payload: Item;
  changed: boolean;
  reason: string;
  /** A local estimate, not billed usage or net cost savings. Reasoning is opaque and not in it. */
  estimatedTokensRemoved: number;
  /** Each call this request went out without in full, and the evidence for it. */
  trimmed: Trim[];
}
/** One call a request went out without in full: what it ran, how much output it had, and Jev's probabilities. */
export interface Trim {
  callId: string;
  tool: string;
  /** The call's input, cut to 200 characters. */
  input: string;
  outputChars: number;
  /** Jev's probabilities that the call, and its whole output, still mattered. */
  need: { call: number; output: number };
  action: 'trim' | 'remove';
  /** Where the full output was saved, when it was. */
  saved?: string;
}
export interface EvaluationResult {
  /** The session's new view; the same object when nothing was decided. */
  view: View;
  /** call_ids this evaluation considered, so the next one waits for new tool output. */
  considered: string[];
  /** `evaluated`, or why Jev did not decide. */
  reason: string;
  jevRequests: number;
}

interface Parsed {
  input: Item[];
  /** One entry per input item, parallel to `input`. */
  entries: Entry[];
  /** The task as Codex states it, for Jev's `goal`; empty when none is found. */
  task: string;
  /** Complete textual tool pairs, in the order judgeSteps() decides them. */
  steps: Step[];
  rewriters: Map<string, (text: string) => unknown>;
}

function object(value: unknown): value is Item {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
function messageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter(object)
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

type TextualToolOutput = { text: string; replace(text: string): unknown };

/** Accept only the textual Responses output shapes we can reconstruct without losing metadata. */
function textualToolOutput(value: unknown): TextualToolOutput | undefined {
  if (typeof value === 'string') return { text: value, replace: text => text };
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every(part => object(part) && part.type === 'input_text' && typeof part.text === 'string')
  )
    return undefined;
  const parts = value as Item[];
  return {
    text: parts.map(part => part.text as string).join('\n'),
    // Keep the original part boundaries and every non-text field. Empty trailing text parts are
    // intentional: they preserve the wire shape while replacing the complete result with its replacement text.
    replace: text => parts.map((part, index) => ({ ...part, text: index === 0 ? text : '' })),
  };
}

/** Reads a stateless Responses request as entries for Jev; only complete, textual custom/function pairs become steps. */
function parse(payload: Item, recentItems: number): Parsed | { reason: string } {
  // Server-side history cannot be reconstructed from an incremental request.
  if (payload.previous_response_id || payload.conversation) return { reason: 'server_side_history' };
  if (!Array.isArray(payload.input) || !payload.input.every(object)) return { reason: 'unsupported_input' };
  const input = payload.input as Item[];
  if (input.some(item => item.type === 'item_reference')) return { reason: 'item_reference' };
  // Codex's standing instructions, hook text, and notices such as `<model_switch>` arrive as developer
  // and system messages. They are not the conversation: read as user prompts, they crowded out the task
  // in Jev's goal. They keep their place, empty.
  const entries: Entry[] = input.map(item => ({
    role: item.role === 'assistant' ? 'assistant' : 'user',
    text: item.role === 'developer' || item.role === 'system' ? '' : messageText(item.content),
  }));
  const calls = new Map<string, number>();
  const outputs = new Map<string, number>();
  const rewriters = new Map<string, (text: string) => unknown>();
  for (const [index, item] of input.entries()) {
    const call = item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call';
    const output = item.type === 'function_call_output' || item.type === 'custom_tool_call_output';
    if (!call && !output) continue;
    // Codex keys a local shell call by its call_id, falling back to the item id as codex-rs does.
    const wireId = text(item.call_id) ?? (item.type === 'local_shell_call' ? text(item.id) : undefined);
    if (!wireId) return { reason: 'invalid_call_id' };
    const map = call ? calls : outputs;
    if (map.has(wireId)) return { reason: 'duplicate_call_id' };
    map.set(wireId, index);
  }
  for (const [id, callIndex] of calls) {
    const resultIndex = outputs.get(id);
    if (resultIndex === undefined) continue;
    if (resultIndex < callIndex) return { reason: 'invalid_pair_order' };
    const call = input[callIndex]!;
    const output = input[resultIndex]!;
    const shell = call.type === 'local_shell_call';
    if (output.type !== (call.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output'))
      return { reason: 'invalid_pair_type' };
    // Multimodal, mixed, malformed, and incomplete outputs stay byte-for-byte unchanged.
    const textualOutput = textualToolOutput(output.output);
    if (!textualOutput) continue;
    const name = shell
      ? 'local_shell'
      : typeof call.name === 'string'
        ? text(call.namespace)
          ? `${call.namespace}.${call.name}`
          : call.name
        : undefined;
    const action = call.action;
    const argument =
      call.type === 'function_call'
        ? call.arguments
        : call.type === 'custom_tool_call'
          ? call.input
          : object(action) &&
              action.type === 'exec' &&
              Array.isArray(action.command) &&
              action.command.every(part => typeof part === 'string')
            ? action
            : undefined;
    if (name === undefined || (!shell && typeof argument !== 'string')) continue;
    if ((call.status && call.status !== 'completed') || (output.status && output.status !== 'completed')) continue;
    entries[callIndex]!.call = { callId: id, name, input: shell ? { action: argument } : { arguments: argument } };
    entries[resultIndex]!.output = { callId: id, text: textualOutput.text };
    rewriters.set(id, textualOutput.replace);
  }
  return { input, entries, task: taskGoal(input), steps: pairSteps(entries, recentItems), rewriters };
}

/**
 * The last three statements of the task: the user's own prompts, which Codex's tagged context such as
 * `<environment_context>` is not, and the task a parent agent hands a subagent.
 */
function taskGoal(input: Item[]): string {
  return input
    .flatMap(item => {
      const text = messageText(item.content).trim();
      const prompt =
        item.role === 'user' && (item.type === undefined || item.type === 'message') && text && !text.startsWith('<');
      return prompt || (item.type === 'agent_message' && text.startsWith('Message Type: NEW_TASK'))
        ? [text.length > 500 ? `${text.slice(0, 499)}…` : text]
        : [];
    })
    .slice(-3)
    .join('\n');
}

const CALL_ITEMS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);

/**
 * The request with its judged steps removed or trimmed; `verdicts` run parallel to `parsed.steps`.
 * A run of reasoning items goes too when every call it led to was dropped or cut short: the step it
 * thought through is over, and models that carry earlier turns' reasoning forward, as OpenAI's GPT-5.6
 * family does by default, would otherwise keep reading it. The upstream bills that reasoning as input,
 * about 34 tokens an item as measured through Runway, so it goes with its step.
 */
function rewrite(
  payload: Item,
  parsed: Parsed,
  verdicts: readonly Verdict[],
  headChars: number,
  options: ViewOptions,
): { payload: Item; reasoningRemoved: number; saved: Map<string, string> } {
  const archive = options.archive;
  const remove = new Set<number>();
  const replace = new Map<number, Item>();
  const saved = new Map<string, string>();
  verdicts.forEach((judged, index) => {
    const step = parsed.steps[index]!;
    if (judged.action === 'remove') {
      remove.add(step.callAt);
      remove.add(step.outputAt);
    } else if (judged.action === 'trim') {
      const original = parsed.entries[step.outputAt]!.output!.text;
      const replaceText = parsed.rewriters.get(step.callId);
      if (!replaceText || original === trimmedOutput(original, headChars)) return;
      const where = archive?.(step.callId, original);
      if (where) saved.set(step.callId, where);
      const output = trimmedOutput(original, headChars, where);
      replace.set(step.outputAt, { ...parsed.input[step.outputAt]!, output: replaceText(output) });
    }
  });
  let reasoningRemoved = 0;
  const input = parsed.input;
  const settled = new Set(
    parsed.steps.filter((_, index) => verdicts[index]!.action !== 'keep').map(step => step.callAt),
  );
  for (let start = 0; start < input.length; ) {
    if (input[start]!.type !== 'reasoning') {
      start++;
      continue;
    }
    let end = start;
    while (end < input.length && input[end]!.type === 'reasoning') end++;
    let next = end;
    while (next < input.length && CALL_ITEMS.has(input[next]!.type as string)) next++;
    if (next > end && input.slice(end, next).every((_, offset) => settled.has(end + offset))) {
      for (let index = start; index < end; index++) remove.add(index);
      reasoningRemoved += end - start;
    }
    start = end;
  }
  return {
    payload: {
      ...payload,
      input: input.flatMap((item, index) => (remove.has(index) ? [] : [replace.get(index) ?? item])),
    },
    reasoningRemoved,
    saved,
  };
}

/** Estimated tokens of a request's readable content: reasoning is opaque. */
export function textTokens(payload: Item): number {
  return estimateTokens(
    JSON.stringify(
      Array.isArray(payload.input)
        ? { ...payload, input: payload.input.filter(item => !object(item) || item.type !== 'reasoning') }
        : payload,
    ),
  );
}

/** File paths with a directory, as a shell command or Codex's code-mode script names them. */
const FILE_PATH = /(?:[\w@.-]+\/)+[\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;
/**
 * Each complete textual call in history order: its id, a fingerprint of the tool and input it ran,
 * which a call made again shares, and the file paths its input names.
 */
export function callFingerprints(payload: Item): { id: string; fingerprint: string; paths: string[] }[] {
  const parsed = parse(payload, 0);
  if ('reason' in parsed) return [];
  return parsed.steps.map(step => {
    const input = typeof step.input.arguments === 'string' ? step.input.arguments : JSON.stringify(step.input);
    return {
      id: step.callId,
      fingerprint: createHash('sha256')
        .update(`${step.name}\0${JSON.stringify(step.input)}`)
        .digest('hex')
        .slice(0, 16),
      paths: [...new Set(Array.from(input.matchAll(FILE_PATH), ([path]) => path.replace(/^\.\//, '')))],
    };
  });
}

/** Whether this is the request Codex sends to summarize a conversation it is compacting itself. */
export function isCodexCompaction(payload: Item): boolean {
  const input = Array.isArray(payload.input) ? payload.input : [];
  const last = [...input].reverse().find(item => object(item) && item.role === 'user');
  return object(last) && messageText(last.content).trimStart().startsWith(CODEX_COMPACTION_PROMPT);
}

/** Applies a session's view to one request, the way a replaced transcript would read. Asks Jev nothing. */
export function applyView(payload: Item, view: View, options: ViewOptions = {}): ViewResult {
  const unchanged = (reason: string): ViewResult => ({
    payload,
    changed: false,
    reason,
    estimatedTokensRemoved: 0,
    trimmed: [],
  });
  if (!view.size) return unchanged('no_view');
  const s = settings(options);
  const parsed = parse(payload, s.recentItems);
  if ('reason' in parsed) return unchanged(parsed.reason);
  const verdicts = parsed.steps.map(step => verdict(step, view.get(step.callId) ?? KEEP, s.threshold));
  if (verdicts.every(judged => judged.action === 'keep')) return unchanged('no_view');
  const { payload: next, reasoningRemoved, saved } = rewrite(payload, parsed, verdicts, s.headChars, options);
  const removed = textTokens(payload) - textTokens(next);
  if (removed <= 0 && !reasoningRemoved) return unchanged('no_reduction');
  const trimmed = parsed.steps.flatMap((step, index): Trim[] => {
    const judged = verdicts[index]!;
    if (judged.action === 'keep') return [];
    const input = typeof step.input.arguments === 'string' ? step.input.arguments : JSON.stringify(step.input);
    return [
      {
        callId: step.callId,
        tool: step.name,
        input: input.length > 200 ? `${input.slice(0, 199)}…` : input,
        outputChars: step.outputChars,
        need: { call: judged.jevCall ?? judged.call, output: judged.output },
        action: judged.action,
        ...(saved.has(step.callId) && { saved: saved.get(step.callId) }),
      },
    ];
  });
  return { payload: next, changed: true, reason: 'compacted', estimatedTokensRemoved: removed, trimmed };
}

/**
 * Compaction over one request's history, returning the session's next view. Jev sees the history with
 * `view` applied and is asked about every call not already dropped, kept ones included, since what was
 * still needed at the last evaluation may not be now. It runs only once
 * `minToolChars` of tool output has arrived since the last evaluation.
 */
export async function evaluateView(
  payload: Item,
  asker: JevAsker,
  view: View,
  options: EvaluationOptions = {},
): Promise<EvaluationResult> {
  const s = settings(options);
  const minToolChars = options.minToolChars ?? 32_000;
  if (!Number.isFinite(minToolChars) || minToolChars < 0) throw new RangeError('minToolChars must be non-negative');
  const parsed = parse(payload, s.recentItems);
  if ('reason' in parsed) return { view, considered: [], reason: parsed.reason, jevRequests: 0 };
  const candidates = parsed.steps.filter(step => !step.fixed && !view.has(step.callId));
  const arrived = candidates
    .filter(step => !options.seen?.has(step.callId))
    .reduce((sum, step) => sum + step.outputChars, 0);
  if (!candidates.length || arrived < minToolChars)
    return { view, considered: [], reason: 'below_threshold', jevRequests: 0 };
  let requests = 0;
  const counted: JevAsker = {
    ask: (state, questions) => {
      requests++;
      return asker.ask(state, questions);
    },
  };
  const next = new Map(view);
  const judge = async (entries: Entry[]): Promise<void> => {
    for (const judged of await judgeSteps(entries, counted, { task: parsed.task, ...options, decided: view })) {
      if (judged.action === 'keep') next.delete(judged.callId);
      else
        next.set(
          judged.callId,
          options.keepCalls
            ? { call: 1, output: judged.output, jevCall: judged.call }
            : { call: judged.call, output: judged.output },
        );
    }
  };
  // Jev sees the whole history when it fits. When the route's budget cannot hold it, as Vercel's cannot
  // for a long session, the history is judged in parts rather than cut: each part goes with the first
  // message, for the task, and the newest ones, for what comes next, so every call is still judged.
  // Parts split where no call waits on its output.
  const entries = parsed.entries;
  const tail = entries.slice(Math.max(1, entries.length - s.recentItems));
  const splits = (start: number, end: number) =>
    Array.from({ length: end - start - 1 }, (_, offset) => start + offset + 1).filter(
      at => !parsed.steps.some(step => step.callAt < at && at <= step.outputAt),
    );
  let tooLarge = false;
  const part = async (start: number, end: number): Promise<void> => {
    const before = requests;
    try {
      await judge([entries[0]!, ...entries.slice(start, end), ...tail]);
    } catch (error) {
      // A request was made, so Jev failed; none was, so the part did not fit and is halved.
      if (requests > before) throw error;
      const middle = (start + end) / 2;
      const at = splits(start, end).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];
      if (at === undefined) {
        tooLarge = true;
        throw error;
      }
      await part(start, at);
      await part(at, end);
    }
  };
  // Every candidate counts as considered, so the next evaluation waits for new tool output.
  const considered = candidates.map(step => step.callId);
  try {
    await part(1, entries.length - tail.length);
    return { view: next, considered, reason: 'evaluated', jevRequests: requests };
  } catch {
    // Parts already judged keep their decisions; the rest wait for new output.
    return { view: next, considered, reason: tooLarge ? 'history_too_large' : 'jev_failed', jevRequests: requests };
  }
}
