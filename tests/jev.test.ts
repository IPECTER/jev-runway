import { afterEach, expect, test } from 'bun:test';
import {
  gatewayModel,
  jevCaller,
  jevHttpRequest,
  jevRoute,
  parseJevProvider,
  probability,
  readJevReply,
} from '../src/jev.js';

const question = { keep: { type: 'noul' as const, instructions: 'Keep it?' } };
const saved = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY };
afterEach(() => {
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});
const reply = (answers: object, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ answers }), { status, headers });
/** Rejects if `promise` has not settled within `ms`, so a missed deadline fails the test instead of hanging it. */
const within = <T>(promise: Promise<T>, ms = 200) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('still waiting')), ms))]);

test('a TypeSafe request carries the model, state, and questions as sent', () => {
  const { url, init } = jevHttpRequest({ provider: 'typesafe', apiKey: 'k' }, { a: 1 }, question);
  expect(url).toBe('https://api.typesafe.ai/v1/systemone');
  expect(init.headers).toEqual({ authorization: 'Bearer k', 'content-type': 'application/json' });
  expect(JSON.parse(init.body)).toEqual({ model: 'jev-latest', state: { a: 1 }, questions: question });
});

test('a Gateway request names the model in headers and asks boolean questions', () => {
  const { url, init } = jevHttpRequest(
    { provider: 'vercel-ai-gateway', apiKey: 'vck_k', model: 'jev-latest' },
    'state',
    question,
  );
  expect(url).toBe('https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
  expect(init.headers).toMatchObject({
    authorization: 'Bearer vck_k',
    'ai-model-id': 'typesafe-ai/jev',
    'ai-evaluation-model-specification-version': '4',
    'ai-gateway-protocol-version': '0.0.1',
    'ai-gateway-auth-method': 'api-key',
  });
  expect(JSON.parse(init.body)).toEqual({
    state: 'state',
    questions: { keep: { type: 'boolean', instructions: 'Keep it?' } },
  });
});

test('provider names and Gateway model ids normalize, and unknown providers are refused', () => {
  expect([undefined, null, ''].map(parseJevProvider)).toEqual([undefined, undefined, undefined]);
  expect(['typesafe', ' Gateway ', 'ai-gateway', 'vercel-ai-gateway'].map(parseJevProvider)).toEqual([
    'typesafe',
    'vercel-ai-gateway',
    'vercel-ai-gateway',
    'vercel-ai-gateway',
  ]);
  expect(() => parseJevProvider('openai')).toThrow(/Unknown Jev provider/);
  expect(
    [undefined, 'jev', 'jev-latest', 'typesafe-ai/jev-latest', 'jev-1.13.0', 'someone/jev'].map(gatewayModel),
  ).toEqual([
    'typesafe-ai/jev',
    'typesafe-ai/jev',
    'typesafe-ai/jev',
    'typesafe-ai/jev',
    'typesafe-ai/jev-1.13.0',
    'someone/jev',
  ]);
});

test('the route follows an explicit provider, then the key, then the environment, TypeSafe first', () => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  expect(jevRoute()).toEqual({ provider: 'typesafe', apiKey: '' });
  process.env.AI_GATEWAY_API_KEY = 'gw';
  expect(jevRoute()).toEqual({ provider: 'vercel-ai-gateway', apiKey: 'gw' });
  process.env.TYPESAFE_API_KEY = 'ts';
  expect(jevRoute()).toEqual({ provider: 'typesafe', apiKey: 'ts' });
  expect(jevRoute({ provider: 'gateway' })).toEqual({ provider: 'vercel-ai-gateway', apiKey: 'gw' });
  expect(jevRoute({ apiKey: 'vck_x' })).toEqual({ provider: 'vercel-ai-gateway', apiKey: 'vck_x' });
  expect(jevRoute({ apiKey: 'plain' })).toEqual({ provider: 'typesafe', apiKey: 'plain' });
});

test('a reply must be JSON with an answers object', () => {
  expect(() => readJevReply('not json')).toThrow(/JSON/);
  for (const body of ['{}', '{"answers":[]}', '{"answers":null}', '[]'])
    expect(() => readJevReply(body)).toThrow(/answers/);
  expect(readJevReply('{"answers":{},"model":"m"}')).toEqual({ answers: {}, model: 'm' });
});

test('probabilities come only from a well-formed answer of its own', () => {
  expect(probability({ q: { noul: 0 } }, 'q')).toBe(0);
  expect(probability({ q: { type: 'noul', noul: 1 } }, 'q')).toBe(1);
  expect(probability({ q: { type: 'boolean', probability: 0.91 } }, 'q')).toBe(0.91);
  const refused = [
    -0.1,
    1.01,
    NaN,
    Infinity,
    null,
    0,
    'yes',
    [],
    { noul: -1 },
    { noul: '0.5' },
    { type: 'choice', noul: 0.5 },
    { type: 'noul', probability: 0.5 },
    { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1 } },
    { probability: 0.5, score: 1 },
    Object.create({ noul: 0.5 }),
  ];
  for (const answer of refused) expect(() => probability({ q: answer }, 'q')).toThrow(/no usable probability for q/);
  expect(() => probability(Object.create({ q: { noul: 0.5 } }), 'q')).toThrow();
  expect(() => probability([], 'q')).toThrow();
});

test('the caller sends its model and reports a missing key as an auth failure', async () => {
  const bodies: string[] = [];
  const ask = jevCaller({
    apiKey: 'k',
    model: 'jev-test',
    fetch: (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return reply({ keep: { noul: 0.4 } });
    }) as unknown as typeof fetch,
  });
  expect((await ask.ask('state', question)).answers).toEqual({ keep: { noul: 0.4 } });
  expect(JSON.parse(bodies[0]!).model).toBe('jev-test');
  await expect(jevCaller({ apiKey: '' }).ask('s', {})).rejects.toMatchObject({
    cause: 'auth',
    message: expect.stringContaining('TYPESAFE_API_KEY'),
  });
  await expect(jevCaller({ apiKey: '', provider: 'vercel-ai-gateway' }).ask('s', {})).rejects.toThrow(
    /AI_GATEWAY_API_KEY/,
  );
});

test('HTTP failures and unreadable replies say why', async () => {
  const failing = (response: Response) =>
    jevCaller({ apiKey: 'k', fetch: (async () => response) as unknown as typeof fetch }).ask('s', question);
  await expect(failing(reply({}, 401))).rejects.toMatchObject({ cause: 'auth', statusCode: 401 });
  await expect(failing(reply({}, 429, { 'retry-after': '2' }))).rejects.toMatchObject({
    cause: 'rate_limit',
    retryAfterMs: 2000,
  });
  await expect(failing(reply({}, 503))).rejects.toMatchObject({ cause: 'http', statusCode: 503 });
  await expect(failing(new Response('<html>', { status: 200 }))).rejects.toMatchObject({ cause: 'invalid_response' });
  await expect(
    jevCaller({
      apiKey: 'k',
      fetch: (async () => {
        throw new TypeError('offline');
      }) as unknown as typeof fetch,
    }).ask('s', question),
  ).rejects.toMatchObject({ cause: 'other' });
});

test('the deadline ends a stalled call, even when the fetch ignores its abort signal', async () => {
  let signal: AbortSignal | undefined;
  const stalled = jevCaller({
    apiKey: 'k',
    timeoutMs: 10,
    fetch: ((_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    }) as unknown as typeof fetch,
  });
  await expect(within(stalled.ask('s', question))).rejects.toMatchObject({
    cause: 'timeout',
    name: 'TimeoutError',
    message: expect.stringMatching(/timed out/),
  });
  expect(signal?.aborted).toBe(true);
  const slowBody = jevCaller({
    apiKey: 'k',
    timeoutMs: 10,
    fetch: (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise(() => undefined),
    })) as unknown as typeof fetch,
  });
  await expect(within(slowBody.ask('s', question))).rejects.toMatchObject({ cause: 'timeout' });
});

test('cancellation stops a call before or during it, and a finished call leaves no timer behind', async () => {
  let requests = 0;
  const early = new AbortController();
  early.abort(new Error('cancelled by caller'));
  await expect(
    jevCaller({
      apiKey: 'k',
      signal: early.signal,
      fetch: (async () => {
        requests++;
        return reply({});
      }) as unknown as typeof fetch,
    }).ask('s', question),
  ).rejects.toThrow('cancelled by caller');
  expect(requests).toBe(0);
  const late = new AbortController();
  const pending = jevCaller({
    apiKey: 'k',
    timeoutMs: 1000,
    signal: late.signal,
    fetch: (() => new Promise(() => undefined)) as unknown as typeof fetch,
  }).ask('s', question);
  late.abort(new Error('stop now'));
  await expect(within(pending)).rejects.toThrow('stop now');
  let signal: AbortSignal | undefined;
  await jevCaller({
    apiKey: 'k',
    timeoutMs: 20,
    fetch: (async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return reply({ keep: { noul: 1 } });
    }) as unknown as typeof fetch,
  }).ask('s', question);
  await Bun.sleep(40);
  expect(signal?.aborted).toBe(false);
});

test('the deadline must be a whole number of milliseconds a timer can hold', () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2 ** 31])
    expect(() => jevCaller({ apiKey: 'k', timeoutMs })).toThrow(/timeoutMs/);
});
