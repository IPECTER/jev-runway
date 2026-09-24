import { JevError } from './diagnostics.js';

/** Where Jev is reached: TypeSafe's own System One API, or Vercel AI Gateway's evaluation route. */
export type JevProvider = 'typesafe' | 'vercel-ai-gateway';
/** A yes-or-no question; Jev answers with the probability of yes. */
export interface JevQuestion {
  type: 'noul';
  instructions: string;
}
export type JevQuestions = Record<string, JevQuestion>;
/** Jev's reply: an answer per question name, and the tokens it counted when it says. */
export interface JevReply {
  answers: Record<string, unknown>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  [field: string]: unknown;
}
/** Anything that can put questions about a state to Jev: the HTTP caller, or a test's stand-in. */
export interface JevAsker {
  ask(state: string | object, questions: JevQuestions): Promise<JevReply>;
}

/**
 * How large a Jev request each route reliably serves, in estimated tokens. TypeSafe's own API takes
 * requests just under Jev's 32k-token window. Through Vercel AI Gateway every
 * request past about 24,000 characters was answered 503 "Service temporarily unavailable" and none
 * under 16,000 was (measured 2026-09-23), so that route gets a ceiling below 16,000 characters.
 */
export const JEV_BUDGETS: Record<JevProvider, { stateTokens: number; requestTokens: number }> = {
  typesafe: { stateTokens: 25_000, requestTokens: 30_000 },
  'vercel-ai-gateway': { stateTokens: 3_000, requestTokens: 4_500 },
};

const ROUTES = {
  typesafe: { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', keyVariable: 'TYPESAFE_API_KEY' },
  'vercel-ai-gateway': {
    url: 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model',
    model: 'typesafe-ai/jev',
    keyVariable: 'AI_GATEWAY_API_KEY',
  },
} as const;

/** Reads a provider setting; `gateway` and `ai-gateway` name the Vercel route. Empty means unset. */
export function parseJevProvider(value: unknown): JevProvider | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const name = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  if (name === 'typesafe') return 'typesafe';
  if (name === 'vercel-ai-gateway' || name === 'gateway' || name === 'ai-gateway') return 'vercel-ai-gateway';
  throw new Error(
    `Unknown Jev provider${typeof value === 'string' ? ` '${value}'` : ''} (use typesafe or vercel-ai-gateway)`,
  );
}

export function missingKeyMessage(provider: JevProvider): string {
  return `${ROUTES[provider].keyVariable} is not configured`;
}

/** Gateway model ids read `creator/model`: TypeSafe's `jev-latest` is `typesafe-ai/jev` there, and a bare name gains the prefix. */
export function gatewayModel(model?: string): string {
  if (!model || ['jev', 'jev-latest', 'typesafe-ai/jev-latest'].includes(model))
    return ROUTES['vercel-ai-gateway'].model;
  return model.includes('/') ? model : `typesafe-ai/${model}`;
}

export interface JevRouteOptions {
  /** Defaults to the provider's key variable, `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`. */
  apiKey?: string;
  /** `typesafe` or `vercel-ai-gateway`. Unset, a `vck_` key or, lacking a key, only `AI_GATEWAY_API_KEY` picks the Gateway. */
  provider?: JevProvider | 'gateway' | 'ai-gateway';
}

/** The provider and key a caller uses, decided without the network. */
export function jevRoute(options: JevRouteOptions = {}): { provider: JevProvider; apiKey: string } {
  const provider = parseJevProvider(options.provider);
  if (provider) return { provider, apiKey: options.apiKey ?? process.env[ROUTES[provider].keyVariable] ?? '' };
  if (options.apiKey !== undefined)
    return { provider: options.apiKey.startsWith('vck_') ? 'vercel-ai-gateway' : 'typesafe', apiKey: options.apiKey };
  if (process.env.TYPESAFE_API_KEY) return { provider: 'typesafe', apiKey: process.env.TYPESAFE_API_KEY };
  if (process.env.AI_GATEWAY_API_KEY) return { provider: 'vercel-ai-gateway', apiKey: process.env.AI_GATEWAY_API_KEY };
  return { provider: 'typesafe', apiKey: '' };
}

/**
 * The fetch arguments for one Jev call. The Gateway's evaluation route has no `noul` question; its
 * `boolean` is the same primitive, the probability of yes.
 */
export function jevHttpRequest(
  route: { provider: JevProvider; apiKey: string; model?: string; url?: string },
  state: string | object,
  questions: JevQuestions,
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${route.apiKey}`,
    'content-type': 'application/json',
  };
  if (route.provider === 'typesafe') {
    return {
      url: route.url ?? ROUTES.typesafe.url,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: route.model ?? ROUTES.typesafe.model, state, questions }),
      },
    };
  }
  Object.assign(headers, {
    'ai-evaluation-model-specification-version': '4',
    'ai-model-id': gatewayModel(route.model),
    'ai-gateway-protocol-version': '0.0.1',
    'ai-gateway-auth-method': 'api-key',
  });
  const booleans = Object.fromEntries(
    Object.entries(questions).map(([name, question]) => [name, { ...question, type: 'boolean' }]),
  );
  return {
    url: route.url ?? ROUTES['vercel-ai-gateway'].url,
    init: { method: 'POST', headers, body: JSON.stringify({ state, questions: booleans }) },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A successful reply body, which must carry an `answers` object. */
export function readJevReply(text: string): JevReply {
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new Error('Jev replied with something other than JSON');
  }
  if (!isObject(reply) || !isObject(reply.answers)) throw new Error('Jev replied without an answers object');
  return reply as JevReply;
}

/**
 * The probability Jev gave for one question, from TypeSafe's `{ noul }` or the Gateway's
 * `{ type: 'boolean', probability }`. Only the answer's own fields count; anything else is refused.
 */
export function probability(answers: unknown, name: string): number {
  const found = isObject(answers) && Object.hasOwn(answers, name) ? answers[name] : undefined;
  const answer = isObject(found) ? found : {};
  const own = (field: string) => Object.hasOwn(answer, field);
  let value: unknown;
  if (own('noul')) value = answer.type === undefined || answer.type === 'noul' ? answer.noul : undefined;
  else if (own('probability') && !own('choice') && !own('score'))
    value = answer.type === undefined || answer.type === 'boolean' ? answer.probability : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`Jev gave no usable probability for ${name}`);
  return value;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1_000);
  const at = Date.parse(header);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : undefined;
}

export interface JevCallerOptions extends JevRouteOptions {
  /** Unset, the route's default: `jev-latest`, or `typesafe-ai/jev` on the Gateway. */
  model?: string;
  /** Unset, the route's own endpoint. */
  baseUrl?: string;
  /** Unset, the global `fetch`. */
  fetch?: typeof fetch;
  /** How long one call may take, its reply body included. Default 15000 ms. */
  timeoutMs?: number;
  /** Cancels every call this caller makes. */
  signal?: AbortSignal;
}

/**
 * Calls Jev over HTTP. Each call ends at its deadline or at the caller's cancellation even when the fetch
 * in use ignores its abort signal, and every failure is a JevError saying why.
 */
export function jevCaller(options: JevCallerOptions = {}): JevAsker {
  const route = jevRoute(options);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new RangeError('timeoutMs must be a whole number of milliseconds from 1 to 2147483647');
  const send = options.fetch ?? fetch;
  const caller = options.signal;
  return {
    async ask(state, questions) {
      // A missing key is reported as the auth failure it is, and waiting will not fix it.
      if (!route.apiKey) throw new JevError('auth', missingKeyMessage(route.provider));
      if (caller?.aborted) throw caller.reason ?? new Error('Jev call cancelled');
      const request = jevHttpRequest({ ...route, model: options.model, url: options.baseUrl }, state, questions);
      const stop = new AbortController();
      let reject!: (reason: unknown) => void;
      const stopped = new Promise<never>((_resolve, fail) => {
        reject = fail;
      });
      stopped.catch(() => undefined);
      const end = (reason: unknown) => {
        stop.abort(reason);
        reject(reason);
      };
      const onCancel = () => end(caller?.reason ?? new Error('Jev call cancelled'));
      const timer = setTimeout(
        () => end(new JevError('timeout', `Jev call timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      caller?.addEventListener('abort', onCancel, { once: true });
      try {
        let response: Response;
        try {
          response = await Promise.race([send(request.url, { ...request.init, signal: stop.signal }), stopped]);
        } catch (error) {
          if (error instanceof JevError) throw error;
          if (caller?.reason instanceof DOMException && caller.reason.name === 'TimeoutError')
            throw new JevError('timeout', 'Jev call timed out');
          if (caller?.aborted || (error instanceof DOMException && error.name === 'AbortError'))
            throw new JevError('cancelled', error instanceof Error ? error.message : 'Jev call cancelled');
          throw new JevError('other', 'Could not reach Jev');
        }
        const text = await Promise.race([response.text(), stopped]);
        if (!response.ok) {
          const cause =
            response.status === 401 || response.status === 403
              ? 'auth'
              : response.status === 429
                ? 'rate_limit'
                : 'http';
          throw new JevError(
            cause,
            `Jev answered HTTP ${response.status}`,
            response.status,
            retryAfterMs(response.headers.get('retry-after')),
          );
        }
        try {
          return readJevReply(text);
        } catch {
          throw new JevError('invalid_response', 'Jev sent an unreadable reply', response.status);
        }
      } finally {
        clearTimeout(timer);
        caller?.removeEventListener('abort', onCancel);
      }
    },
  };
}
