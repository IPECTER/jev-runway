import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  type Attribution,
  classifyJevFailure,
  type Endpoint,
  type ErrorKind,
  type FailureCause,
  JevError,
} from './diagnostics.js';
import type { JevAsker } from './jev.js';

export type TerminalStatus = 'completed' | 'incomplete' | 'failed' | 'truncated' | 'unobserved';
/** One model response's usage as the upstream reported it. */
export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

/** Estimated tokens of samples a calibration rate needs before it stands for a session. */
const MIN_CALIBRATION_TOKENS = 2_000;
const zeros = <K extends string>(...keys: K[]) => Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>;
const bump = (record: Record<string, number>, key: string, by = 1) => {
  record[key] = (record[key] ?? 0) + by;
};

/** Everything counted for the whole process, and again for each session. */
function counters() {
  return {
    startedAt: new Date().toISOString(),
    /**
     * `compacted` counts model requests sent with their session's view applied, and `bypassed` why the
     * others were not. `compactionTimeMs` is spent between turns. `rerunAfterDrop` counts calls made again after the identical earlier call was
     * compacted away, of `callsDropped`; `rerunOtherwise` the other re-runs, of the other calls.
     * `rereadAfterDrop` and `rereadOtherwise` count earlier calls, once each, whose files a later call
     * named again, by whether the call was dropped then: of `callsDropped`, and of all `callsObserved`,
     * since every call spends time undropped first. `websocketIncremental` and `websocketFull` count
     * requests sent over the upstream WebSocket with only their new items, or whole; `websocketBytesSent`
     * is what they uploaded, and `websocketBytesWhole` what they would have uploaded whole.
     * `estimatedInputTokensRemoved` is Runway's own estimate, which counts high. `billedInputTokensRemoved`
     * converts each request's estimate at the rate the upstream counted the session's new items:
     * `calibrationBilledTokens` reported over `calibrationEstimatedTokens` estimated.
     */
    stats: {
      requests: 0,
      compacted: 0,
      estimatedInputTokensRemoved: 0,
      billedInputTokensRemoved: 0,
      calibrationBilledTokens: 0,
      calibrationEstimatedTokens: 0,
      jevRequests: 0,
      jevFailures: 0,
      compactionTimeMs: 0,
      callsObserved: 0,
      callsDropped: 0,
      rerunAfterDrop: 0,
      rerunOtherwise: 0,
      rereadAfterDrop: 0,
      rereadOtherwise: 0,
      websocketIncremental: 0,
      websocketFull: 0,
      websocketBytesSent: 0,
      websocketBytesWhole: 0,
      bypassed: {} as Record<string, number>,
    },
    /** Outcomes of the compaction evaluations run between turns: `evaluated`, or why Jev did not decide. */
    evaluations: {} as Record<string, number>,
    /** Why a request went upstream over HTTP although the WebSocket was enabled. */
    websocketFallbacks: {} as Record<string, number>,
    /** Why a request over the WebSocket went whole rather than as only its new items. */
    websocketWhole: {} as Record<string, number>,
    requestTypes: zeros<Endpoint>('responses', 'compact', 'models', 'other'),
    modelSessionAttribution: zeros<Attribution>('valid', 'missing', 'conflicting', 'malformed'),
    sessionAttribution: zeros<Attribution>('valid', 'missing', 'conflicting', 'malformed'),
    activeRequests: 0,
    errors: 0,
    errorBreakdown: zeros<ErrorKind>(
      'client_cancelled',
      'upstream_http',
      'upstream_transport',
      'stream',
      'upstream_response',
    ),
    jevFailureReasons: zeros<FailureCause>(
      'timeout',
      'cancelled',
      'http',
      'auth',
      'rate_limit',
      'invalid_response',
      'other',
    ),
    /** Status codes behind `jevFailureReasons.http`: 503 is retried, other 5xx are not the same fault. */
    jevHttpStatus: {} as Record<string, number>,
    upstreamResponses: 0,
    /**
     * Totals over model responses, with the compacted ones counted again on their own. Comparing the
     * compacted cached share against the overall one says whether rewriting the input paid for the
     * prompt-cache prefix it breaks. Neither is billing data.
     */
    usage: {
      responses: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      compacted: { responses: 0, inputTokens: 0, cachedInputTokens: 0 },
    },
    latencyMs: { count: 0, total: 0, max: 0 },
    jevLatencyMs: { count: 0, total: 0, min: Infinity, max: 0 },
  };
}
export type Counters = ReturnType<typeof counters>;

function usageFrom(value: unknown): Usage | undefined {
  const root = object(value);
  const usage = object(object(root.response ?? root).usage);
  const valid = (number: unknown) =>
    typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
  const inputTokens = valid(usage.input_tokens);
  const outputTokens = valid(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined || !Number.isSafeInteger(inputTokens + outputTokens))
    return undefined;
  const cached = object(usage.input_tokens_details).cached_tokens;
  const reasoning = object(usage.output_tokens_details).reasoning_tokens;
  const cachedInputTokens = cached === undefined ? 0 : valid(cached);
  // Reasoning is a share of output some providers leave out; a missing or odd value counts as none.
  const reasoningTokens = Math.min(valid(reasoning) ?? 0, outputTokens);
  const totalTokens = usage.total_tokens === undefined ? inputTokens + outputTokens : valid(usage.total_tokens);
  if (
    cachedInputTokens === undefined ||
    cachedInputTokens > inputTokens ||
    totalTokens === undefined ||
    totalTokens < inputTokens + outputTokens
  )
    return undefined;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens };
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export class Metrics {
  private readonly total = counters();
  // ponytail: fixed in-memory cap; persist sessions only if restarts must retain them.
  private readonly sessions = new Map<string, Counters>();
  private readonly maxSessions = 256;

  /** Applies one update to the process totals and, when there is one, to the session. */
  private each(session: Counters | undefined, update: (into: Counters) => void) {
    update(this.total);
    if (session) update(session);
  }

  private session(id: string | undefined): Counters | undefined {
    if (!id) return undefined;
    const current = this.sessions.get(id);
    // A new request moves its session to the back of the map, so eviction takes the least recently
    // used idle session, not the oldest one: the oldest is often the long session still in use.
    if (current) {
      this.sessions.delete(id);
      this.sessions.set(id, current);
      return current;
    }
    if (this.sessions.size >= this.maxSessions) {
      const evicted = [...this.sessions].find(([, session]) => session.activeRequests === 0)?.[0];
      if (!evicted) return undefined;
      this.sessions.delete(evicted);
    }
    const next = counters();
    this.sessions.set(id, next);
    return next;
  }
  beginRequest(sessionId?: string) {
    const session = this.session(sessionId);
    this.each(session, into => into.activeRequests++);
    const started = performance.now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const elapsed = Math.max(0, performance.now() - started);
      this.each(session, into => {
        into.activeRequests = Math.max(0, into.activeRequests - 1);
        into.latencyMs.count++;
        into.latencyMs.total += elapsed;
        into.latencyMs.max = Math.max(into.latencyMs.max, elapsed);
      });
    };
    return { session, finish };
  }
  /** Tokens the upstream counted per token Runway estimated: the session's rate once it has enough samples, else the process's. */
  billedPerEstimated(session?: Counters): number | undefined {
    for (const from of [session, this.total]) {
      if (from && from.stats.calibrationEstimatedTokens >= MIN_CALIBRATION_TOKENS)
        return from.stats.calibrationBilledTokens / from.stats.calibrationEstimatedTokens;
    }
    return undefined;
  }
  increment(session: Counters | undefined, field: Exclude<keyof Counters['stats'], 'bypassed'>, value = 1) {
    this.each(session, into => {
      into.stats[field] += value;
    });
  }
  incrementBypass(session: Counters | undefined, reason: string) {
    this.each(session, into => bump(into.stats.bypassed, reason));
  }
  recordRequestType(kind: Endpoint, attribution: Attribution, session?: Counters) {
    this.each(session, into => {
      into.requestTypes[kind]++;
      if (kind === 'responses') into.modelSessionAttribution[attribution]++;
    });
  }
  recordAttribution(kind: Attribution, session?: Counters) {
    this.each(session, into => {
      into.sessionAttribution[kind]++;
    });
  }
  recordUpstreamResponse(session?: Counters) {
    this.each(session, into => {
      into.upstreamResponses++;
    });
  }
  recordError(kind: ErrorKind, session?: Counters) {
    this.each(session, into => {
      if (kind !== 'client_cancelled') into.errors++;
      into.errorBreakdown[kind]++;
    });
  }
  recordWebsocketFallback(reason: string, session?: Counters) {
    this.each(session, into => bump(into.websocketFallbacks, reason));
  }
  recordWebsocketWhole(reason: string, session?: Counters) {
    this.each(session, into => bump(into.websocketWhole, reason));
  }
  recordEvaluation(outcome: string, session?: Counters) {
    this.each(session, into => bump(into.evaluations, outcome));
  }
  recordUsage(usage: Usage, session?: Counters, compacted = false) {
    this.each(session, into => {
      const totals = into.usage;
      totals.responses++;
      totals.inputTokens += usage.inputTokens;
      totals.cachedInputTokens += usage.cachedInputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.reasoningTokens += usage.reasoningTokens;
      totals.totalTokens += usage.totalTokens;
      if (compacted) {
        totals.compacted.responses++;
        totals.compacted.inputTokens += usage.inputTokens;
        totals.compacted.cachedInputTokens += usage.cachedInputTokens;
      }
    });
  }
  instrument(asker: JevAsker, session?: Counters): JevAsker {
    return {
      ask: async (state, questions) => {
        const started = performance.now();
        let failed = false;
        try {
          return await asker.ask(state, questions);
        } catch (error) {
          failed = true;
          const cause = classifyJevFailure(error);
          const code =
            error instanceof JevError && error.statusCode !== undefined ? String(error.statusCode) : undefined;
          this.each(session, into => {
            into.jevFailureReasons[cause]++;
            if (code) bump(into.jevHttpStatus, code);
          });
          throw error;
        } finally {
          const elapsed = Math.max(0, performance.now() - started);
          this.each(session, into => {
            into.stats.jevRequests++;
            if (failed) into.stats.jevFailures++;
            const latency = into.jevLatencyMs;
            latency.count++;
            latency.total += elapsed;
            latency.min = Math.min(latency.min, elapsed);
            latency.max = Math.max(latency.max, elapsed);
          });
        }
      },
    };
  }
  snapshot(extra: Record<string, unknown>, sessionId?: string) {
    const source = sessionId === undefined ? this.total : this.sessions.get(sessionId);
    if (!source) return undefined;
    const { stats, startedAt, jevLatencyMs: latency, ...rest } = structuredClone(source);
    return {
      ...extra,
      ...stats,
      ...rest,
      startedAt,
      uptimeMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      jevLatencyMs: {
        count: latency.count,
        total: latency.total,
        min: latency.count ? latency.min : null,
        max: latency.max,
        average: latency.count ? latency.total / latency.count : null,
      },
    };
  }
}

export interface ObserverEvents {
  onUsage?(usage: Usage): void;
  onTerminal?(status: TerminalStatus): void;
}

/** Pass-through response observer. It deliberately gives up parsing after bounded input. */
export class UsageObserver extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private terminalSeen = false;
  private observationLimited = false;
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private eventBytes = 0;
  private lineDropped = false;
  private eventDropped = false;
  private text = '';
  private data: string[] = [];
  private disabled = false;
  private recorded = false;
  /** `sse` undefined means the response named no content type, so the body decides. */
  constructor(
    private sse: boolean | undefined,
    private readonly events: ObserverEvents = {},
    private readonly maxBytes = 1024 * 1024,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.push(chunk);
    try {
      // A JSON reply opens with { or [, and an event stream does not. ChatGPT's Codex backend streams
      // with no content type at all, so the content type alone would read every such reply as JSON.
      if (this.sse === undefined) {
        const start = chunk.toString('utf8').trimStart();
        if (start) this.sse = !/^[{[]/.test(start);
      }
      if (!this.disabled && this.sse !== undefined) {
        if (this.sse) this.consumeSse(this.decoder.write(chunk));
        else {
          this.bytes += chunk.length;
          if (this.bytes > this.maxBytes) this.disabled = true;
          else this.chunks.push(Buffer.from(chunk));
        }
      }
    } catch {
      this.disabled = true;
    }
    callback();
  }
  override _flush(callback: TransformCallback) {
    try {
      if (!this.disabled && this.sse) {
        this.consumeSse(this.decoder.end());
        this.commitEvent();
      } else if (!this.disabled) this.observeJson(Buffer.concat(this.chunks).toString('utf8'), true);
      if (this.sse && !this.terminalSeen)
        this.terminal(this.disabled || this.observationLimited ? 'unobserved' : 'truncated');
    } catch {
      /* observation must never affect forwarding */
    }
    callback();
  }
  private terminal(status: TerminalStatus) {
    if (this.terminalSeen) return;
    this.terminalSeen = true;
    this.events.onTerminal?.(status);
  }
  private consumeSse(value: string) {
    if (this.lineDropped) {
      const newline = value.indexOf('\n');
      if (newline < 0) return;
      value = value.slice(newline + 1);
      this.lineDropped = false;
    }
    this.text += value;
    for (let index = this.text.indexOf('\n'); index >= 0; index = this.text.indexOf('\n')) {
      const line = this.text.slice(0, index).replace(/\r$/, '');
      this.text = this.text.slice(index + 1);
      this.eventBytes += Buffer.byteLength(line);
      if (this.eventBytes > this.maxBytes) {
        this.observationLimited = true;
        this.eventDropped = true;
        this.data = [];
      }
      if (!line) this.commitEvent();
      else if (!this.eventDropped && line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    }
    if (Buffer.byteLength(this.text) > this.maxBytes) {
      this.observationLimited = true;
      this.text = '';
      this.lineDropped = true;
      this.eventDropped = true;
      this.data = [];
    }
  }
  private commitEvent() {
    const data = this.eventDropped ? '' : this.data.join('\n');
    this.eventDropped = false;
    this.eventBytes = 0;
    this.data = [];
    if (data) this.observeJson(data);
  }
  private observeJson(value: string, directResponse = false) {
    let record: Record<string, unknown>;
    try {
      record = object(JSON.parse(value));
    } catch {
      return;
    }
    if (directResponse) {
      if (record.object !== 'response' || !['completed', 'incomplete', 'failed'].includes(record.status as string))
        return;
      this.terminal(record.status as TerminalStatus);
      return this.observeUsage(record);
    }
    if (record.type === 'error') return this.terminal('failed');
    if (
      record.type !== 'response.completed' &&
      record.type !== 'response.incomplete' &&
      record.type !== 'response.failed'
    )
      return;
    this.terminal(String(record.type).slice('response.'.length) as TerminalStatus);
    this.observeUsage(record);
  }
  private observeUsage(value: unknown) {
    if (this.recorded) return;
    const usage = usageFrom(value);
    if (usage) {
      this.recorded = true;
      this.events.onUsage?.(usage);
    }
  }
}
