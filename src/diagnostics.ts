import { createHash, randomUUID } from 'node:crypto';

export type FailureCause = 'timeout' | 'cancelled' | 'http' | 'auth' | 'rate_limit' | 'invalid_response' | 'other';
export type Attribution = 'valid' | 'missing' | 'conflicting' | 'malformed';
export type ErrorKind = 'client_cancelled' | 'upstream_http' | 'upstream_transport' | 'stream' | 'upstream_response';
export type Endpoint = 'responses' | 'compact' | 'models' | 'other';

/** Outcomes of a compaction evaluation, and why a request could not be read. */
const REASONS = new Set([
  'evaluated',
  'jev_failed',
  'history_too_large',
  'evaluation_error',
  'server_side_history',
  'unsupported_input',
  'item_reference',
  'invalid_call_id',
  'duplicate_call_id',
  'invalid_pair_order',
  'invalid_pair_type',
]);

/** Opt-in, bounded diagnostics. Values are deliberately selected, never copied. */
const DEBUG_EVENT_LIMIT = 10_000;
const DEBUG_WINDOW_MS = 60 * 60 * 1_000;

export class Diagnostics {
  private emitted = 0;
  private dropped = 0;
  private windowStartedAt: number;
  readonly enabled: boolean;
  constructor(
    environment = process.env,
    private readonly write = (line: string) => process.stderr.write(line),
    private readonly now = () => Date.now(),
  ) {
    this.enabled = environment.JEV_RUNWAY_DEBUG === '1';
    this.windowStartedAt = now();
  }
  /**
   * A lifetime cap bounds log growth by going permanently quiet, which on a service that runs for
   * days means the log is dead long before anyone reads it. Bound the rate instead: the budget
   * refills every hour, so growth stays bounded and a failure is still diagnosable tomorrow.
   */
  private overBudget(): boolean {
    const now = this.now();
    if (now - this.windowStartedAt >= DEBUG_WINDOW_MS) {
      this.windowStartedAt = now;
      this.emitted = 0;
    }
    if (this.emitted >= DEBUG_EVENT_LIMIT) {
      this.dropped++;
      return true;
    }
    return false;
  }
  requestId() {
    return randomUUID();
  }
  session(id: string | undefined) {
    return id ? createHash('sha256').update(id).digest('hex').slice(0, 12) : undefined;
  }
  emit(
    event: 'request' | 'jev' | 'upstream' | 'compaction' | 'complete',
    values: {
      requestId: string;
      endpoint?: Endpoint;
      method?: 'GET' | 'POST' | 'other';
      session?: string;
      phase?: string;
      fields?: string[];
      durationMs?: number;
      statusCode?: number;
      cause?: FailureCause | ErrorKind | 'ok';
      attribution?: Attribution;
      reason?: string;
    },
  ) {
    if (!this.enabled) return;
    if (this.overBudget()) return;
    const output: Record<string, string | number> = {
      event: 'jev_runway',
      at: new Date().toISOString(),
      kind: event,
      requestId: values.requestId,
    };
    if (values.endpoint) output.endpoint = values.endpoint;
    if (values.method) output.method = values.method;
    if (values.session) output.session = values.session;
    if (values.phase) output.phase = values.phase;
    // Field paths only, never their values.
    const fields = values.fields?.filter(field => /^[\w.]{1,80}$/.test(field)).slice(0, 5);
    if (fields?.length) output.fields = fields.join(',');
    if (Number.isFinite(values.durationMs)) output.durationMs = Math.round(values.durationMs!);
    if (Number.isInteger(values.statusCode)) output.statusCode = values.statusCode!;
    if (values.cause) output.cause = values.cause;
    if (values.attribution) output.attribution = values.attribution;
    if (values.reason && REASONS.has(values.reason)) output.reason = values.reason;
    try {
      this.write(`${JSON.stringify(output)}\n`);
      this.emitted++;
    } catch {
      this.dropped++;
    }
  }
  snapshot() {
    return { emitted: this.emitted, dropped: this.dropped, limit: DEBUG_EVENT_LIMIT, windowMs: DEBUG_WINDOW_MS };
  }
}

export function classifyJevFailure(error: unknown): FailureCause {
  if (error instanceof JevError) return error.cause;
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  return 'other';
}

export class JevError extends Error {
  constructor(
    readonly cause: FailureCause,
    message: string,
    readonly statusCode?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = cause === 'timeout' ? 'TimeoutError' : 'JevError';
  }
}
