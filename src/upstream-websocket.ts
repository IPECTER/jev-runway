/**
 * Responses over a WebSocket to the upstream, one connection per Codex session.
 *
 * Codex reaches Runway over HTTP, sending its whole history, so Runway can trim it. Runway then sends
 * the trimmed history on over a WebSocket the way Codex itself would: the whole of it once, and after
 * that only the items that follow the previous response, with `previous_response_id`. The server
 * keeps the trimmed history, so the model still reads only that; only the upload shrinks. When a
 * request does not continue the previous one, as after Jev trims more, the whole history goes again.
 * Events come back as the Server-Sent Events Codex expects over HTTP.
 */

/** Codex's Responses-over-WebSocket beta. */
const BETA = 'responses_websockets=2026-02-06';
/** Request fields that may differ between a request and the one it continues, as Codex compares them. */
const PER_REQUEST = new Set(['input', 'stream_options', 'client_metadata', 'access_programs']);
/** Request headers that describe one HTTP exchange, not the session; the turn state goes per request instead. */
const NOT_FORWARDED = new Set([
  'x-codex-turn-state',
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'content-type',
  'content-encoding',
  'accept',
  'accept-encoding',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-authenticate',
  'expect',
]);
const CONNECT_TIMEOUT_MS = 5_000;
/** Idle connections kept open, one per recent session. */
const MAX_CONNECTIONS = 64;
/** After the upstream refuses a WebSocket, requests go over HTTP for this long before trying again. */
const DISABLED_MS = 10 * 60_000;

type Item = Record<string, unknown>;
export type SocketMode = 'incremental' | 'full';
/** Why a request went whole: the first on its connection, other settings, a changed history, other outputs, or nothing new. */
export type WholeReason = 'first' | 'settings' | 'history' | 'outputs' | 'no_new_items';
/** For other outputs, which of their fields differ. */
type Whole = { reason: WholeReason; fields?: string[] };
/** `sentBytes` went up the socket; `wholeBytes` is what the whole request would have taken. */
export type SocketResult =
  | {
      response: Response;
      mode: SocketMode;
      reason?: WholeReason;
      fields?: string[];
      sentBytes: number;
      wholeBytes: number;
    }
  | { fallback: string };
type Handler = { onMessage(text: string): void; onClose(reason: string): void };
type Last = { properties: string; input: unknown[]; outputs: Item[]; responseId: string };

const encoder = new TextEncoder();
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.keys(inner)
            .sort()
            .map(key => [key, (inner as Item)[key]]),
        )
      : inner,
  );
/**
 * An output item as the model produced it. The server also labels it with an id, a status, and
 * metadata that Codex drops when it puts the item back into its history, and Codex ignores them
 * when it decides whether a request continues the previous one. Codex also keeps only the text of
 * each output text, without its annotations or log probabilities, and a reasoning item's content
 * only when it holds reasoning text.
 */
const produced = (item: unknown): unknown => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const {
    id: _id,
    status: _status,
    metadata: _metadata,
    internal_chat_message_metadata_passthrough: _passthrough,
    ...rest
  } = item as Item;
  if (
    rest.type === 'reasoning' &&
    !(Array.isArray(rest.content) && rest.content.some(part => (part as Item | null)?.type === 'reasoning_text'))
  )
    delete rest.content;
  if (Array.isArray(rest.content))
    rest.content = rest.content.map(part => {
      if (!part || typeof part !== 'object') return part;
      const { annotations: _annotations, logprobs: _logprobs, ...kept } = part as Item;
      return kept;
    });
  return rest;
};
const content = (item: unknown): string => canonical(produced(item));

/** Where two items differ, as field paths under the item's type, without values, so the debug log can say why. */
function differences(a: unknown, b: unknown, path = 'item', found: string[] = []): string[] {
  if (found.length >= 5) return found;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    if (canonical(a) !== canonical(b)) found.push(path);
    return found;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    differences((a as Item)[key], (b as Item)[key], `${path}.${key}`, found);
  return found;
}

/** The `codex.rate_limits` event as the HTTP headers Codex reads its usage limits from. */
export function rateLimitHeaders(event: Item): Record<string, string> {
  const name =
    typeof event.metered_limit_name === 'string'
      ? event.metered_limit_name
      : typeof event.limit_name === 'string'
        ? event.limit_name
        : 'codex';
  const prefix = `x-${(name.trim() || 'codex').toLowerCase().replace(/_/g, '-')}`;
  const headers: Record<string, string> = {};
  const limits = event.rate_limits as
    | Record<string, { used_percent?: unknown; window_minutes?: unknown; reset_at?: unknown } | undefined>
    | undefined;
  for (const window of ['primary', 'secondary'] as const) {
    const value = limits?.[window];
    if (!value || typeof value.used_percent !== 'number') continue;
    headers[`${prefix}-${window}-used-percent`] = String(value.used_percent);
    if (typeof value.window_minutes === 'number')
      headers[`${prefix}-${window}-window-minutes`] = String(value.window_minutes);
    if (typeof value.reset_at === 'number') headers[`${prefix}-${window}-reset-at`] = String(value.reset_at);
  }
  if (typeof event.limit_name === 'string') headers[`${prefix}-limit-name`] = event.limit_name;
  const credits = event.credits as { has_credits?: unknown; unlimited?: unknown; balance?: unknown } | undefined;
  if (credits && typeof credits.has_credits === 'boolean' && typeof credits.unlimited === 'boolean') {
    headers['x-codex-credits-has-credits'] = String(credits.has_credits);
    headers['x-codex-credits-unlimited'] = String(credits.unlimited);
    if (typeof credits.balance === 'string') headers['x-codex-credits-balance'] = credits.balance;
  }
  return headers;
}

class Connection {
  readonly socket: WebSocket;
  readonly opened: Promise<void>;
  closed = false;
  busy = false;
  last?: Last;
  private handler?: Handler;
  constructor(url: string, headers: Record<string, string>) {
    this.socket = new WebSocket(url, { headers } as never);
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('connect timeout'));
        this.close();
      }, CONNECT_TIMEOUT_MS);
      this.socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          reject(new Error('closed before open'));
        },
        { once: true },
      );
    });
    this.opened.catch(() => undefined);
    this.socket.addEventListener('message', event =>
      this.handler?.onMessage(
        typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer),
      ),
    );
    this.socket.addEventListener('close', () => {
      this.closed = true;
      const handler = this.handler;
      this.handler = undefined;
      handler?.onClose('closed');
    });
  }
  listen(handler: Handler | undefined) {
    this.handler = handler;
  }
  close() {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

export class UpstreamSockets {
  private readonly connections = new Map<string, Connection>();
  private disabledUntil = 0;
  constructor(
    private readonly url: string,
    private readonly now = () => Date.now(),
  ) {}

  /** The WebSocket address of a Responses upstream given as an HTTP base URL. */
  static urlFor(upstream: URL): string {
    const url = new URL(upstream);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/responses`;
    return url.toString();
  }

  /**
   * Sends one Codex request over the session's WebSocket. Resolves with the response once the upstream
   * has started answering, or with the reason to use HTTP instead when it could not start.
   */
  async send(
    sessionId: string,
    payload: Item,
    requestHeaders: Record<string, string | string[] | undefined>,
    signal: AbortSignal,
  ): Promise<SocketResult> {
    if (this.now() < this.disabledUntil) return { fallback: 'disabled' };
    let connection = this.connections.get(sessionId);
    if (connection?.busy) return { fallback: 'busy' };
    if (!connection || connection.closed) {
      connection = new Connection(this.url, forwardedHeaders(requestHeaders));
      this.connections.set(sessionId, connection);
      for (const [id, idle] of this.connections) {
        if (this.connections.size <= MAX_CONNECTIONS) break;
        if (!idle.busy && idle !== connection) {
          idle.close();
          this.connections.delete(id);
        }
      }
    }
    try {
      await connection.opened;
    } catch {
      this.connections.delete(sessionId);
      this.disabledUntil = this.now() + DISABLED_MS;
      return { fallback: 'connect_failed' };
    }
    const input = Array.isArray(payload.input) ? payload.input : [];
    const properties = canonical(Object.fromEntries(Object.entries(payload).filter(([key]) => !PER_REQUEST.has(key))));
    const last = connection.last;
    const whole: Whole | undefined = !last
      ? { reason: 'first' }
      : last.properties !== properties
        ? { reason: 'settings' }
        : continuation(last, input);
    const incremental = whole === undefined;
    const turnState = first(requestHeaders['x-codex-turn-state']);
    const metadata = {
      ...(payload.client_metadata as Item | undefined),
      ...(turnState && { 'x-codex-turn-state': turnState }),
    };
    const frame = {
      type: 'response.create',
      ...payload,
      ...(Object.keys(metadata).length && { client_metadata: metadata }),
      ...(incremental
        ? { previous_response_id: last!.responseId, input: input.slice(last!.input.length + last!.outputs.length) }
        : { input }),
    };
    connection.last = undefined;
    connection.busy = true;
    const text = JSON.stringify(frame);
    const wholeBytes = incremental
      ? Buffer.byteLength(JSON.stringify({ ...frame, previous_response_id: undefined, input }))
      : Buffer.byteLength(text);
    const result = await this.stream(connection, text, input, properties, signal);
    if ('fallback' in result) {
      connection.busy = false;
      connection.close();
      this.connections.delete(sessionId);
      return result;
    }
    return {
      response: result.response,
      mode: incremental ? 'incremental' : 'full',
      ...whole,
      sentBytes: Buffer.byteLength(text),
      wholeBytes,
    };
  }

  private stream(
    connection: Connection,
    frame: string,
    input: unknown[],
    properties: string,
    signal: AbortSignal,
  ): Promise<{ response: Response } | { fallback: string }> {
    return new Promise(resolve => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start: value => {
          controller = value;
        },
        cancel: () => {
          connection.close();
        },
      });
      const pending: Uint8Array[] = [];
      let headers: Record<string, string> = {};
      let started = false;
      let responseId = '';
      const outputs: Item[] = [];
      const finish = (last?: Last) => {
        connection.busy = false;
        connection.last = last;
        connection.listen(undefined);
        signal.removeEventListener('abort', abort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const fail = (reason: string) => {
        connection.listen(undefined);
        signal.removeEventListener('abort', abort);
        if (!started) {
          resolve({ fallback: reason });
          return;
        }
        connection.busy = false;
        connection.close();
        try {
          controller.error(new Error(reason));
        } catch {
          /* already closed */
        }
      };
      const abort = () => {
        connection.close();
        fail('aborted');
      };
      signal.addEventListener('abort', abort, { once: true });
      const start = () => {
        started = true;
        for (const chunk of pending) controller.enqueue(chunk);
        resolve({
          response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } }),
        });
      };
      connection.listen({
        onClose: reason => fail(reason),
        onMessage: text => {
          let event: Item;
          try {
            event = JSON.parse(text) as Item;
          } catch {
            return;
          }
          const type = typeof event.type === 'string' ? event.type : '';
          if (type === 'codex.rate_limits') {
            headers = { ...headers, ...rateLimitHeaders(event) };
            return;
          }
          // An error before anything was answered is the upstream refusing the request: HTTP gets it again.
          if (type === 'error' && !started) {
            fail('error_event');
            return;
          }
          const chunk = encoder.encode(`event: ${type}\ndata: ${text}\n\n`);
          if (started) controller.enqueue(chunk);
          else pending.push(chunk);
          const response = event.response as Item | undefined;
          if (type === 'response.created' && typeof response?.id === 'string') responseId = response.id;
          if (type === 'response.output_item.done' && event.item && typeof event.item === 'object')
            outputs.push(event.item as Item);
          if (!started && type.startsWith('response.')) start();
          if (type === 'response.completed')
            finish(
              responseId
                ? {
                    properties,
                    input,
                    outputs,
                    responseId: typeof response?.id === 'string' ? response.id : responseId,
                  }
                : undefined,
            );
          else if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') finish();
        },
      });
      try {
        connection.socket.send(frame);
      } catch {
        fail('send_failed');
      }
    });
  }

  close() {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}

/** Why `input` is not the previous request, its response, and new items after them; undefined when it is. */
function continuation(last: Last, input: unknown[]): Whole | undefined {
  for (let index = 0; index < last.input.length; index++)
    if (canonical(last.input[index]) !== canonical(input[index])) return { reason: 'history' };
  for (let index = 0; index < last.outputs.length; index++) {
    const sent = input[last.input.length + index];
    if (content(last.outputs[index]) !== content(sent)) {
      const type = last.outputs[index]?.type;
      return {
        reason: 'outputs',
        fields: differences(produced(last.outputs[index]), produced(sent), typeof type === 'string' ? type : 'item'),
      };
    }
  }
  return input.length > last.input.length + last.outputs.length ? undefined : { reason: 'no_new_items' };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The Codex request's headers for the WebSocket handshake, with the beta Codex itself sends. */
function forwardedHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || NOT_FORWARDED.has(key) || key.startsWith('sec-websocket')) continue;
    forwarded[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  const beta = forwarded['openai-beta'];
  forwarded['openai-beta'] = beta ? (beta.includes(BETA) ? beta : `${beta}, ${BETA}`) : BETA;
  return forwarded;
}
