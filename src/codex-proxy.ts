import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import * as zlib from 'node:zlib';
import { loadDaemonCredential } from './auth.js';
import { codexHome, loadCodexEnvironment } from './config.js';
import {
  type Attribution,
  classifyJevFailure,
  Diagnostics,
  type Endpoint,
  type ErrorKind,
  type FailureCause,
  JevError,
} from './diagnostics.js';
import { JEV_BUDGETS, type JevAsker, jevCaller, jevRoute } from './jev.js';
import { settings } from './judge.js';
import { type Counters, Metrics, UsageObserver } from './metrics.js';
import {
  applyView,
  type EvaluationOptions,
  evaluateView,
  isCodexCompaction,
  textTokens,
  type View,
} from './responses.js';
import {
  archiver,
  calibrationSample,
  countDrops,
  countRepeats,
  pruneArchive,
  recordTrims,
  type Session,
  Sessions,
} from './sessions.js';
import { UpstreamSockets } from './upstream-websocket.js';

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_PORT = 8788;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const DECODE = { maxOutputLength: MAX_BODY_BYTES };
const DECODERS = new Map<string, (body: Buffer) => Buffer>([
  ['gzip', body => zlib.gunzipSync(body, DECODE)],
  ['deflate', body => zlib.inflateSync(body, DECODE)],
  ['br', body => zlib.brotliDecompressSync(body, DECODE)],
  ['zstd', body => zlib.zstdDecompressSync(body, DECODE)],
]);
/** Statuses that mean the evaluator was briefly unavailable. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);
/**
 * TypeSafe's SDK default: two retries from 0.5 s, doubling up to 5 s less up to a quarter at random, or
 * after the server's Retry-After within that ceiling. Compaction runs between turns, so nothing waits.
 */
const RETRY = { retries: 2, delayMs: 500, maxDelayMs: 5_000 };
/** The deadline for each Jev call. Compaction runs between turns, so nothing waits on it. */
const COMPACTION_TIMEOUT_MS = 15_000;

export interface ProxyOptions {
  upstream: string;
  asker?: (signal: AbortSignal) => JevAsker;
  compaction?: EvaluationOptions;
  maxBodyBytes?: number;
  diagnostics?: Diagnostics;
  /** Where truncated results are saved in full; unset, nothing is saved and the note says to re-run the tool. */
  archiveDir?: string;
  /** Send Responses requests upstream over a WebSocket per session, falling back to HTTP. Default off. */
  websocket?: boolean;
}

type Trace = { requestId: string; session?: string };
/** A model request as read, and as it goes upstream with its session's view applied. */
type Prepared = {
  payload: Record<string, unknown>;
  sessionId?: string;
  session?: Session;
  view?: View;
  sent: Record<string, unknown>;
  body?: Buffer;
  saved: number;
};

/**
 * HTTP/SSE bridge to a configured OpenAI-compatible upstream that compacts Codex's history: Jev decides
 * between turns which tool calls and results a session still needs, and every later request goes out
 * with those decisions applied.
 */
export function createCodexProxy(options: ProxyOptions) {
  const upstream = new URL(options.upstream);
  if (!validUpstream(upstream))
    throw new Error('upstream must be HTTPS, or loopback HTTP, without credentials, query, or fragment');
  const port = Number(process.env.JEV_RUNWAY_PORT ?? DEFAULT_PORT);
  if (
    LOOPBACK_HOSTS.has(upstream.hostname) &&
    Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80)) === port
  )
    throw new Error('upstream must not point at this proxy');
  const metrics = new Metrics();
  const diagnostics = options.diagnostics ?? new Diagnostics();
  const sessions = new Sessions();
  const sockets = options.websocket ? new UpstreamSockets(UpstreamSockets.urlFor(upstream)) : undefined;

  function status(url: URL, response: ServerResponse) {
    const body = metrics.snapshot(
      {
        service: 'jev-runway',
        upstreamConfigured: true,
        debugEnabled: diagnostics.enabled,
        debugDiagnostics: diagnostics.snapshot(),
        transport: 'http',
        metric: 'estimated input tokens, not net cost savings',
      },
      url.searchParams.get('session') ?? undefined,
    );
    response.writeHead(body ? 200 : 404, JSON_HEADERS);
    response.end(JSON.stringify(body ?? { error: 'Unknown session' }));
  }

  /** The request budget of the Jev route in use, TypeSafe's own API or Vercel AI Gateway. */
  const budget = () => JEV_BUDGETS[jevRoute({ ...loadDaemonCredential() }).provider];

  /** A logged Jev caller that retries when the evaluator was briefly unavailable. */
  function jev(signal: AbortSignal, timeout: number, counters: Counters | undefined, trace: Trace): JevAsker {
    const client = metrics.instrument(
      options.asker?.(signal) ??
        jevCaller({ ...loadDaemonCredential(), model: process.env.JEV_RUNWAY_MODEL, timeoutMs: timeout, signal }),
      counters,
    );
    const attempt: JevAsker['ask'] = async (state, questions) => {
      const started = performance.now();
      let cause: FailureCause | 'ok' = 'ok';
      let statusCode: number | undefined;
      try {
        return await client.ask(state, questions);
      } catch (error) {
        cause = classifyJevFailure(error);
        if (error instanceof JevError) statusCode = error.statusCode;
        throw error;
      } finally {
        diagnostics.emit('jev', { ...trace, phase: 'ask', cause, statusCode, durationMs: performance.now() - started });
      }
    };
    return {
      ask: async (state, questions) => {
        for (let tried = 0; ; tried++) {
          try {
            return await attempt(state, questions);
          } catch (error) {
            if (!(error instanceof JevError) || !RETRYABLE.has(error.statusCode ?? 0) || tried >= RETRY.retries)
              throw error;
            const backoff = RETRY.delayMs * 2 ** tried * (1 - Math.random() * 0.25);
            await new Promise(resolve =>
              setTimeout(resolve, Math.min(RETRY.maxDelayMs, error.retryAfterMs ?? backoff)),
            );
          }
        }
      },
    };
  }

  /**
   * Once a response has completed, Jev decides the session's calls in the background and the next
   * request carries the new view. No request waits on it, so a slow or failed evaluation costs a request
   * nothing; the next one simply goes out with the old view.
   */
  function compactBetweenTurns(
    session: Session,
    payload: Record<string, unknown>,
    counters: Counters | undefined,
    trace: Trace,
  ) {
    if (session.evaluating) return;
    session.evaluating = true;
    const started = performance.now();
    void (async () => {
      const result = await evaluateView(
        payload,
        jev(AbortSignal.timeout(4 * COMPACTION_TIMEOUT_MS), COMPACTION_TIMEOUT_MS, counters, trace),
        session.view,
        { ...budget(), keepCalls: true, ...options.compaction, seen: session.seen },
      );
      session.view = result.view;
      for (const id of result.considered) session.seen.add(id);
      countDrops(session, counter => metrics.increment(counters, counter));
      if (result.reason === 'below_threshold') return;
      metrics.recordEvaluation(result.reason, counters);
      metrics.increment(counters, 'compactionTimeMs', performance.now() - started);
      diagnostics.emit('compaction', { ...trace, reason: result.reason, durationMs: performance.now() - started });
    })()
      .catch(error => {
        metrics.recordEvaluation('evaluation_error', counters);
        diagnostics.emit('compaction', { ...trace, reason: 'evaluation_error', cause: classifyJevFailure(error) });
      })
      .finally(() => {
        session.evaluating = false;
      });
  }

  /** Reads a model request and applies its session's view, as if the transcript itself had been compacted. */
  function prepare(
    received: Buffer | ReadableStream<Uint8Array>,
    encoding: string | undefined,
    sessionId: string | undefined,
    counters: Counters | undefined,
    requestId: string,
  ): Prepared | undefined {
    if (!Buffer.isBuffer(received)) {
      metrics.incrementBypass(counters, 'body_too_large');
      return undefined;
    }
    const payload = parseObject(decodeRequestBody(received, encoding));
    if (!payload) return undefined;
    if (!sessionId) {
      metrics.incrementBypass(counters, 'no_session');
      return { payload, sent: payload, saved: 0 };
    }
    const session = sessions.get(sessionId);
    const view = session.view;
    session.turns++;
    countRepeats(session, payload, counter => metrics.increment(counters, counter));
    const viewed = applyView(payload, view, {
      ...options.compaction,
      archive: options.archiveDir ? archiver(options.archiveDir, sessionId, session) : undefined,
    });
    if (!viewed.changed) {
      metrics.incrementBypass(counters, viewed.reason);
      return { payload, sessionId, session, view, sent: payload, saved: 0 };
    }
    metrics.increment(counters, 'compacted');
    metrics.increment(counters, 'estimatedInputTokensRemoved', viewed.estimatedTokensRemoved);
    // Each trim is written once, with the turn that first went out without the output, so a run that
    // fails later can be traced to what the model could no longer see.
    const fresh = viewed.trimmed.filter(trim => !session.logged.has(trim.callId));
    for (const trim of fresh) session.logged.add(trim.callId);
    if (options.archiveDir) {
      const at = new Date().toISOString();
      const threshold = settings(options.compaction).threshold;
      recordTrims(
        options.archiveDir,
        sessionId,
        fresh.map(trim => ({ at, turn: session.turns, requestId, threshold, ...trim })),
      );
    }
    return {
      payload,
      sessionId,
      session,
      view,
      sent: viewed.payload,
      body: Buffer.from(JSON.stringify(viewed.payload)),
      saved: viewed.estimatedTokensRemoved,
    };
  }

  /** Drops the session's view, and says so in the ledger, so the trims that follow are written afresh. */
  function startOver(sessionId: string, session: Session, reason: string, requestId: string) {
    session.view = new Map();
    session.logged.clear();
    if (options.archiveDir) {
      recordTrims(options.archiveDir, sessionId, [
        { at: new Date().toISOString(), turn: session.turns, requestId, event: 'reset', reason },
      ]);
    }
  }

  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    const started = performance.now();
    let trace: Trace = { requestId: diagnostics.requestId() };
    let counters: Counters | undefined;
    let finish: (() => void) | undefined;
    let outcome: 'ok' | ErrorKind = 'ok';
    const recordError = (kind: ErrorKind) => {
      if (outcome === 'ok') {
        outcome = kind;
        metrics.recordError(kind, counters);
      }
    };
    let terminal = false;
    let completed = false;
    const complete = () => {
      if (!finish) return;
      finish();
      if (!completed) {
        completed = true;
        diagnostics.emit('complete', { ...trace, durationMs: performance.now() - started, cause: outcome });
      }
    };
    response.on('close', () => {
      if (!response.writableFinished && !controller.signal.aborted) {
        // Codex hangs up as soon as it has the terminal event. Only a hang-up before it is a cancellation.
        if (!terminal) recordError('client_cancelled');
        controller.abort();
      }
      complete();
    });
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
        response.writeHead(400);
        response.end('Invalid request target');
        return;
      }
      const incoming = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && incoming.pathname === '/_jev/status') return status(incoming, response);
      const endpoint = endpointOf(request.method, incoming.pathname);
      const attributed = codexSessionId(request);
      ({ session: counters, finish } = metrics.beginRequest(attributed.id));
      trace = { ...trace, session: diagnostics.session(attributed.id) };
      metrics.recordAttribution(attributed.kind, counters);
      metrics.recordRequestType(endpoint, attributed.kind, counters);
      metrics.increment(counters, 'requests');
      diagnostics.emit('request', {
        ...trace,
        attribution: attributed.kind,
        method: request.method === 'GET' || request.method === 'POST' ? request.method : 'other',
        endpoint,
      });
      response.once('finish', complete);

      const received = await readBody(request, options.maxBodyBytes ?? MAX_BODY_BYTES);
      const prepared =
        endpoint === 'responses'
          ? prepare(received, request.headers['content-encoding'], attributed.id, counters, trace.requestId)
          : undefined;
      if (controller.signal.aborted) return;
      let compacted = prepared?.body !== undefined;

      const target = upstreamTarget(upstream, incoming);
      const send = (content: Buffer | ReadableStream<Uint8Array>, changed: boolean) =>
        fetch(target, {
          method: request.method,
          headers: upstreamHeaders(request, changed),
          signal: controller.signal,
          redirect: 'manual',
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : (content as BodyInit),
          ...(!Buffer.isBuffer(content) && { duplex: 'half' }),
        } as RequestInit);
      // The trimmed history goes on over the session's WebSocket when the upstream takes one: after the
      // first request, only what follows the previous response is uploaded. Anything else goes over HTTP.
      let viaSocket: Response | undefined;
      if (
        sockets &&
        prepared?.sessionId &&
        request.method === 'POST' &&
        prepared.sent.stream === true &&
        prepared.sent.previous_response_id === undefined
      ) {
        const result = await sockets.send(prepared.sessionId, prepared.sent, request.headers, controller.signal);
        if ('response' in result) {
          viaSocket = result.response;
          metrics.increment(counters, result.mode === 'incremental' ? 'websocketIncremental' : 'websocketFull');
          if (result.reason) metrics.recordWebsocketWhole(result.reason, counters);
          metrics.increment(counters, 'websocketBytesSent', result.sentBytes);
          metrics.increment(counters, 'websocketBytesWhole', result.wholeBytes);
          diagnostics.emit('upstream', {
            ...trace,
            phase: result.reason ? `websocket_full_${result.reason}` : 'websocket_incremental',
            statusCode: 200,
          });
        } else metrics.recordWebsocketFallback(result.fallback, counters);
      }
      let upstreamResponse = viaSocket ?? (await send(prepared?.body ?? received, compacted));
      metrics.recordUpstreamResponse(counters);
      if (
        !viaSocket &&
        compacted &&
        (upstreamResponse.status === 400 || upstreamResponse.status === 422) &&
        !controller.signal.aborted
      ) {
        upstreamResponse.body?.cancel().catch(() => undefined);
        metrics.increment(counters, 'compacted', -1);
        metrics.increment(counters, 'estimatedInputTokensRemoved', -prepared!.saved);
        compacted = false;
        // The upstream refused the rewrite: the session goes back to Codex's history as it is, and Jev
        // decides again only once new output arrives, rather than repeating the refused decision now.
        if (prepared!.session) startOver(prepared!.sessionId!, prepared!.session, 'upstream_refused', trace.requestId);
        upstreamResponse = await send(received, false);
        metrics.recordUpstreamResponse(counters);
      }
      diagnostics.emit('upstream', { ...trace, statusCode: upstreamResponse.status });
      if (!upstreamResponse.ok) recordError('upstream_http');
      response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse));
      if (!upstreamResponse.body) {
        response.end();
        return;
      }
      const stream = Readable.fromWeb(upstreamResponse.body as unknown as NodeReadableStream);
      stream.on('error', () => {
        if (!controller.signal.aborted) recordError('stream');
        controller.abort();
        complete();
        response.destroy();
      });
      if (!upstreamResponse.ok || endpoint !== 'responses') {
        stream.pipe(response);
        return;
      }
      const contentType = upstreamResponse.headers.get('content-type');
      const sse = contentType ? /(?:^|\b)text\/event-stream(?:;|$)/i.test(contentType) : undefined;
      stream
        .pipe(
          new UsageObserver(sse, {
            onUsage: usage => {
              metrics.recordUsage(usage, counters, compacted);
              // A request the upstream refused went again as Codex sent it, which this estimate does not describe.
              if (
                !prepared?.session ||
                !prepared.view ||
                (prepared.body && !compacted) ||
                prepared.sent.previous_response_id !== undefined
              )
                return;
              const { session, view, sent, saved } = prepared;
              // Off the stream's path: sizing a long history takes a few milliseconds.
              setImmediate(() => {
                const sample = calibrationSample(session, {
                  view,
                  estimated: textTokens(sent),
                  billed: usage.inputTokens,
                });
                if (sample) {
                  metrics.increment(counters, 'calibrationBilledTokens', sample.billed);
                  metrics.increment(counters, 'calibrationEstimatedTokens', sample.estimated);
                }
                const rate = saved ? metrics.billedPerEstimated(counters) : undefined;
                if (rate !== undefined)
                  metrics.increment(counters, 'billedInputTokensRemoved', Math.round(saved * rate));
              });
            },
            onTerminal: result => {
              terminal = true;
              if (result === 'failed') recordError('upstream_response');
              if (result === 'truncated') recordError('stream');
              const session = prepared?.session;
              if (result !== 'completed' || !session) return;
              // Codex's own compaction replaces its history with a summary, so the session's view no longer applies.
              if (isCodexCompaction(prepared.payload)) {
                startOver(prepared.sessionId!, session, 'codex_compaction', trace.requestId);
                session.seen.clear();
              } else compactBetweenTurns(session, prepared.payload, counters, trace);
            },
          }),
        )
        .pipe(response);
    } catch {
      recordError(controller.signal.aborted ? 'client_cancelled' : 'upstream_transport');
      complete();
      if (!response.headersSent) {
        response.writeHead(502);
        response.end('Jev proxy could not reach upstream');
      } else response.destroy();
    }
  });
  server.on('close', () => sockets?.close());
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}

function validUpstream(upstream: URL): boolean {
  return (
    !upstream.username &&
    !upstream.password &&
    !upstream.search &&
    !upstream.hash &&
    (upstream.protocol === 'https:' || (upstream.protocol === 'http:' && LOOPBACK_HOSTS.has(upstream.hostname)))
  );
}

/** Maps Codex's local /v1 prefix onto the configured provider API base without duplicating it. */
function upstreamTarget(upstream: URL, incoming: URL): URL {
  const target = new URL(upstream);
  target.pathname =
    `${upstream.pathname.replace(/\/$/, '')}${incoming.pathname.replace(/^\/v1(?=\/|$)/, '') || '/'}` || '/';
  target.search = incoming.search;
  return target;
}

function endpointOf(method: string | undefined, path: string): Endpoint {
  if (method === 'POST' && /\/responses\/?$/.test(path)) return 'responses';
  if (method === 'POST' && /\/responses\/compact\/?$/.test(path)) return 'compact';
  if (method === 'GET' && /\/models\/?$/.test(path)) return 'models';
  return 'other';
}

/**
 * Buffers a body up to `limit` bytes. A larger body is not Runway's to judge: it comes back as a stream
 * that replays the buffered part and continues with the rest, so it goes upstream byte for byte and the
 * upstream decides whether it is too large. Refusing it here would fail a request the upstream, or a
 * proxy behind Runway, might still accept. The iterator is read by hand so stopping early leaves the rest.
 */
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | ReadableStream<Uint8Array>> {
  const chunks = request[Symbol.asyncIterator]();
  const buffered: Buffer[] = [];
  let size = 0;
  for (let next = await chunks.next(); !next.done; next = await chunks.next()) {
    buffered.push(Buffer.from(next.value));
    size += buffered.at(-1)!.length;
    if (size > limit)
      return new ReadableStream<Uint8Array>({
        start(stream) {
          for (const chunk of buffered) stream.enqueue(chunk);
        },
        async pull(stream) {
          const next = await chunks.next();
          if (next.done) stream.close();
          else stream.enqueue(Buffer.from(next.value));
        },
        cancel() {
          void chunks.return?.();
        },
      });
  }
  return Buffer.concat(buffered);
}

function decodeRequestBody(body: Buffer, encoding: string | undefined): Buffer | undefined {
  const name = encoding?.toLowerCase() ?? 'identity';
  if (name === 'identity') return body;
  try {
    const decoded = DECODERS.get(name)?.(body);
    return decoded && decoded.length <= MAX_BODY_BYTES ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Parses a JSON object; anything else is left for the upstream to validate. */
function parseObject(body: Buffer | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Request headers for the upstream, without hop-by-hop ones and with encodings reset where needed. */
function upstreamHeaders(request: IncomingMessage, rewritten: boolean): Headers {
  const connection = new Set(
    (request.headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map(token => token.trim()),
  );
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (!HOP_HEADERS.has(key) && !connection.has(key) && value !== undefined)
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  // A rewritten body is plain JSON. fetch decodes response bodies itself, so ask for identity and let
  // the response's encoding header drop out in responseHeaders.
  if (rewritten) headers.delete('content-encoding');
  headers.set('accept-encoding', 'identity');
  return headers;
}

function responseHeaders(response: Response): Record<string, string> {
  const connection = new Set(
    (response.headers.get('connection') ?? '')
      .toLowerCase()
      .split(',')
      .map(token => token.trim())
      .filter(Boolean),
  );
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (!HOP_HEADERS.has(key) && !connection.has(key) && key !== 'content-encoding') headers[key] = value;
  });
  return headers;
}

/** Codex sends a plain session_id; its Responses metadata also carries thread_id. */
function codexSessionId(request: IncomingMessage): { id?: string; kind: Attribution } {
  const first = (header: string | string[] | undefined) => (Array.isArray(header) ? header[0] : header)?.trim();
  const valid = (id: string | undefined) => (id && id.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(id) ? id : undefined);
  const sessionId = valid(first(request.headers.session_id));
  const metadata = first(request.headers['x-codex-turn-metadata']);
  if (!metadata) return sessionId ? { id: sessionId, kind: 'valid' } : { kind: 'missing' };
  if (metadata.length > 16 * 1024) return { id: sessionId, kind: 'malformed' };
  try {
    const parsed = JSON.parse(metadata) as { thread_id?: unknown };
    const threadId = typeof parsed.thread_id === 'string' ? valid(parsed.thread_id) : undefined;
    if (sessionId && threadId && sessionId !== threadId) return { kind: 'conflicting' };
    const id = sessionId ?? threadId;
    return id ? { id, kind: 'valid' } : { kind: 'missing' };
  } catch {
    return { id: sessionId, kind: 'malformed' };
  }
}

/**
 * Runs the proxy until SIGTERM or SIGINT: on JEV_RUNWAY_PORT, 8788 by default, forwarding to `upstream`,
 * JEV_RUNWAY_UPSTREAM by default. The background service runs it as `jev-runway serve`.
 */
export function serve(upstream = process.env.JEV_RUNWAY_UPSTREAM): void {
  loadCodexEnvironment();
  const port = Number(process.env.JEV_RUNWAY_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid JEV_RUNWAY_PORT');
  if (!upstream) throw new Error('JEV_RUNWAY_UPSTREAM is required');
  const archiveDir = join(codexHome(), 'jev-runway', 'archive');
  pruneArchive(archiveDir);
  setInterval(() => pruneArchive(archiveDir), 86_400_000).unref();
  const server = createCodexProxy({ upstream, archiveDir, websocket: process.env.JEV_RUNWAY_WEBSOCKET !== '0' });
  server.listen(port, '127.0.0.1', () => process.stderr.write(`Jev Runway listening on 127.0.0.1:${port}\n`));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close());
}
