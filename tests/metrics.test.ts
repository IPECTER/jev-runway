import { afterEach, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import { Metrics, UsageObserver } from '../src/metrics.js';

async function observe(chunks: Buffer[], sse: boolean, maxBytes?: number) {
  const metrics = new Metrics();
  const observer = new UsageObserver(sse, { onUsage: usage => metrics.recordUsage(usage) }, maxBytes);
  const output: Buffer[] = [];
  observer.on('data', chunk => output.push(Buffer.from(chunk)));
  await new Promise<void>((resolve, reject) =>
    Readable.from(chunks).pipe(observer).on('end', resolve).on('error', reject),
  );
  return { metrics: metrics.snapshot({}), output: Buffer.concat(output) };
}

const terminal = JSON.stringify({
  object: 'response',
  status: 'completed',
  usage: {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens: 4,
    total_tokens: 16,
  },
});

afterEach(() => undefined);

it('keeps global and session error classes separate', () => {
  const metrics = new Metrics();
  const request = metrics.beginRequest('session-a');
  metrics.recordError('upstream_http', request.session);
  request.finish();
  metrics.recordError('upstream_transport');
  expect(metrics.snapshot({})?.errorBreakdown).toMatchObject({ upstream_http: 1, upstream_transport: 1 });
  expect(metrics.snapshot({}, 'session-a')?.errorBreakdown).toMatchObject({ upstream_http: 1, upstream_transport: 0 });
});

it('keeps active sessions and declined request callbacks out of a later session generation', async () => {
  expect(new Metrics().snapshot({})?.jevLatencyMs).toEqual({ count: 0, total: 0, min: null, max: 0, average: null });
  const metrics = new Metrics();
  const active = Array.from({ length: 256 }, (_, index) => metrics.beginRequest(`session-${index}`));
  const declined = metrics.beginRequest('overflow');
  const delayed = metrics.instrument(
    {
      async ask() {
        return { answers: {} };
      },
    },
    declined.session,
  );
  declined.finish();
  expect(metrics.snapshot({}, 'overflow')).toBeUndefined();
  active[0]!.finish();
  const admitted = metrics.beginRequest('overflow');
  await delayed.ask({}, {});
  admitted.finish();
  expect(metrics.snapshot({}, 'overflow')?.activeRequests).toBe(0);
  expect(metrics.snapshot({}, 'overflow')?.jevRequests).toBe(0);
  for (const request of active.slice(1)) request.finish();

  const afterDisconnect = new Metrics();
  const disconnected = afterDisconnect.beginRequest('reused-session');
  const lateAsk = afterDisconnect.instrument(
    {
      async ask() {
        return { answers: {} };
      },
    },
    disconnected.session,
  );
  disconnected.finish();
  for (let index = 0; index < 256; index++) afterDisconnect.beginRequest(`replacement-${index}`).finish();
  const replacement = afterDisconnect.beginRequest('reused-session');
  await lateAsk.ask({}, {});
  replacement.finish();
  expect(afterDisconnect.snapshot({}, 'reused-session')?.jevRequests).toBe(0);
});

it('extracts JSON usage while forwarding exact bytes', async () => {
  const body = Buffer.from(terminal);
  const result = await observe([body.subarray(0, 7), body.subarray(7)], false);
  expect(result.output.equals(body)).toBe(true);
  expect(result.metrics.usage).toEqual({
    responses: 1,
    inputTokens: 12,
    cachedInputTokens: 3,
    outputTokens: 4,
    reasoningTokens: 0,
    totalTokens: 16,
    compacted: { responses: 0, inputTokens: 0, cachedInputTokens: 0 },
  });
});

it('extracts CRLF multiline SSE terminal usage across UTF-8 chunks once', async () => {
  const body = Buffer.from(
    `event: response.created\r\ndata: {"note":"한"}\r\n\r\nevent: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: JSON.parse(terminal) }).slice(0, 80)}\r\ndata: ${JSON.stringify({ type: 'response.completed', response: JSON.parse(terminal) }).slice(80)}\r\n\r\nevent: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: JSON.parse(terminal) })}\r\n\r\n`,
    'utf8',
  );
  const split = body.indexOf(Buffer.from('한')) + 1;
  const result = await observe([body.subarray(0, split), body.subarray(split, 121), body.subarray(121)], true);
  expect(result.output.equals(body)).toBe(true);
  expect(result.metrics.usage.responses).toBe(1);
  expect(result.metrics.usage.totalTokens).toBe(16);
});

it('counts terminal incomplete SSE usage once and ignores nonterminal usage', async () => {
  const response = {
    object: 'response',
    status: 'incomplete',
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  };
  const body = Buffer.from(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', response })}\n\nevent: response.incomplete\ndata: ${JSON.stringify({ type: 'response.incomplete', response })}\n\n`,
  );
  const result = await observe([body], true);
  expect(result.metrics.usage).toMatchObject({ responses: 1, totalTokens: 4 });
});

it('keeps observing a later bounded SSE event in a large chunk', async () => {
  const prefix = Array.from({ length: 8 }, () => 'event: response.created\ndata: {}\n\n').join('');
  const completed = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: JSON.parse(terminal) })}\n\n`;
  const result = await observe([Buffer.from(prefix + completed)], true, 300);
  expect(result.metrics.usage.responses).toBe(1);
});

it('ignores malformed observations without changing forwarded content', async () => {
  const body = Buffer.from('event: response.completed\ndata: {not json}\n\n', 'utf8');
  const result = await observe([body], true);
  expect(result.output.equals(body)).toBe(true);
  expect(result.metrics.usage.responses).toBe(0);
  const invalid = await observe(
    [Buffer.from(JSON.stringify({ usage: { input_tokens: -1, output_tokens: Number.NaN } }))],
    false,
  );
  expect(invalid.metrics.usage.responses).toBe(0);
  const shortTotal = await observe(
    [
      Buffer.from(
        JSON.stringify({
          object: 'response',
          status: 'completed',
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 4 },
        }),
      ),
    ],
    false,
  );
  expect(shortTotal.metrics.usage.responses).toBe(0);
});

it('separates model requests and their attribution from model-list polling', () => {
  const metrics = new Metrics();
  const model = metrics.beginRequest('one');
  metrics.recordRequestType('responses', 'valid', model.session);
  metrics.recordRequestType('models', 'missing');
  model.finish();
  expect(metrics.snapshot({})?.requestTypes).toEqual({ responses: 1, compact: 0, models: 1, other: 0 });
  expect(metrics.snapshot({})?.modelSessionAttribution).toEqual({ valid: 1, missing: 0, conflicting: 0, malformed: 0 });
  expect(metrics.snapshot({}, 'one')?.requestTypes.models).toBe(0);
});

it('distinguishes unobserved oversized SSE from a verified truncated stream', async () => {
  for (const [body, expected] of [
    [`data: ${'x'.repeat(100)}\n\n`, 'unobserved'],
    ['data: {}\n\n', 'truncated'],
    ['data: {"type":"response.completed"}\n\n', 'completed'],
  ]) {
    const states: string[] = [];
    const observer = new UsageObserver(true, { onTerminal: status => states.push(status) }, 64);
    const chunks: Buffer[] = [];
    observer.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await new Promise<void>((resolve, reject) => {
      observer.on('end', resolve);
      observer.on('error', reject);
      observer.end(Buffer.from(body!));
    });
    expect(states).toEqual([expected]);
    expect(Buffer.concat(chunks).toString()).toBe(body);
  }
});

it('evicts the least recently used idle session, not the first one created', () => {
  const metrics = new Metrics();
  for (let index = 0; index < 256; index++) metrics.beginRequest(`session-${index}`).finish();
  // The first session is still in use; a later one has sat idle since it was created.
  metrics.beginRequest('session-0').finish();
  expect(metrics.snapshot({}, 'session-0')).toBeDefined();
  metrics.beginRequest('session-new').finish();
  expect(metrics.snapshot({}, 'session-0')).toBeDefined();
  expect(metrics.snapshot({}, 'session-1')).toBeUndefined();
  expect(metrics.snapshot({}, 'session-new')).toBeDefined();
});

it('tells an event stream from a JSON reply by its body when no content type says which', async () => {
  const seen: [string, number | undefined][] = [];
  const run = async (body: string) => {
    let tokens: number | undefined;
    const observer = new UsageObserver(undefined, {
      onUsage: usage => {
        tokens = usage.inputTokens;
      },
      onTerminal: status => seen.push([status, tokens]),
    });
    observer.resume();
    await new Promise<void>((resolve, reject) =>
      Readable.from([Buffer.from('\n'), Buffer.from(body)])
        .pipe(observer)
        .on('end', resolve)
        .on('error', reject),
    );
    return tokens;
  };
  const usage = { input_tokens: 7, output_tokens: 1 };
  // ChatGPT's Codex backend streams without a content-type header.
  expect(
    await run(
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage } })}\n\n`,
    ),
  ).toBe(7);
  expect(await run(JSON.stringify({ object: 'response', status: 'completed', usage }))).toBe(7);
  expect(seen.map(([status]) => status)).toEqual(['completed', 'completed']);
});
