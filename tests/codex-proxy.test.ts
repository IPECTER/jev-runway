import { afterEach, expect, it } from 'bun:test';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from 'node:fs';
import { createServer, request as rawRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { createCodexProxy } from '../src/codex-proxy.js';
import { Diagnostics, JevError } from '../src/diagnostics.js';
import { calibrationSample, pruneArchive, Sessions } from '../src/sessions.js';

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  return `http://127.0.0.1:${address.port}`;
}
async function rawGet(base: string, path: string): Promise<number> {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const request = rawRequest({ hostname: target.hostname, port: target.port, path }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
/** A completed Responses reply: what starts compaction between turns. */
const COMPLETED = JSON.stringify({ object: 'response', status: 'completed', output: [] });
/** Waits until the proxy has finished `count` compaction evaluations between turns, and returns its status. */
async function evaluated(proxy: string, count = 1) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = await (await fetch(`${proxy}/_jev/status`)).json();
    if (Object.values(status.evaluations as Record<string, number>).reduce((sum, value) => sum + value, 0) >= count)
      return status;
    await Bun.sleep(5);
  }
  throw new Error('no compaction evaluation finished');
}
/** An evaluator that answers every question with 0: drop every call it is asked about. */
const dropAll = () => ({
  async ask(_state: unknown, questions: object) {
    return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul' as const, noul: 0 }])) };
  },
});
const payload = () => ({
  model: 'test',
  stream: true,
  input: [
    { role: 'user', content: 'Read the current source.' },
    { type: 'function_call', call_id: 'old', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'old', output: 'old irrelevant log '.repeat(3_000) },
    ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'Current source only.' })),
  ],
});

it("streams the upstream SSE response without changing auth, and compacts the session's next request", async () => {
  const received: string[] = [];
  let authorization: string | undefined;
  const upstream = await listen(
    createServer(async (request, response) => {
      authorization = request.headers.authorization;
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push(body);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'x-hop',
        'x-hop': 'remove-me',
        'x-test': 'preserved',
      });
      response.write('event: response.created\ndata: {"id":"resp_test"}\n\n');
      setTimeout(
        () =>
          response.end(
            'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}}}\n\n',
          ),
        5,
      );
    }),
  );
  const proxy = await listen(createCodexProxy({ upstream, asker: () => dropAll() }));
  const original = payload();
  const send = () =>
    fetch(`${proxy}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer synthetic-test-only',
        'content-type': 'application/json',
        session_id: 'session-sse',
      },
      body: JSON.stringify(original),
    });
  const result = await send();
  expect(result.status).toBe(200);
  expect(result.headers.get('x-hop')).toBeNull();
  expect(result.headers.get('x-test')).toBe('preserved');
  expect(await result.text()).toContain('event: response.completed');
  expect(authorization).toBe('Bearer synthetic-test-only');
  // Jev decides between turns: the first request goes out as sent, and the session's next one carries
  // the decision.
  expect(JSON.parse(received[0]!)).toEqual(original);
  expect(await evaluated(proxy)).toMatchObject({ evaluations: { evaluated: 1 } });
  await (await send()).text();
  // Jev let the old call go: its record stays, and its output is cut to a head and a note.
  const sent = JSON.parse(received[1]!).input;
  expect(sent.slice(0, 2)).toEqual(original.input.slice(0, 2));
  expect(sent[2].output).toContain('Jev Runway truncated');
  expect(sent.slice(3)).toEqual(original.input.slice(3));
  const status = await (await fetch(`${proxy}/_jev/status`)).json();
  expect(status).toMatchObject({ compacted: 1, bypassed: { no_view: 1 }, usage: { responses: 2, inputTokens: 14 } });
  expect(status.estimatedInputTokensRemoved).toBeGreaterThan(0);
});

it('forwards original bytes on Jev failure and preserves incremental and non-Responses requests', async () => {
  const received: string[] = [];
  const upstream = await listen(
    createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push(body);
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"error":"synthetic unauthorized"}');
    }),
  );
  let calls = 0;
  const proxy = await listen(
    createCodexProxy({
      upstream,
      asker: () => ({
        async ask() {
          calls++;
          throw new Error('Jev unavailable');
        },
      }),
    }),
  );
  for (const [path, value] of [
    ['/v1/responses', payload()],
    ['/v1/responses', { ...payload(), previous_response_id: 'resp_previous' }],
    ['/v1/responses/compact', payload()],
  ] as const) {
    const body = JSON.stringify(value, null, 2);
    const response = await fetch(proxy + path, { method: 'POST', body });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('synthetic unauthorized');
    expect(received.at(-1)).toBe(body);
  }
  // Nothing asked Jev: no response completed, and none of these requests carries tools to route.
  expect(calls).toBe(0);
});

it('counts a client that hangs up before the upstream answers as a cancellation', async () => {
  let arrived!: () => void;
  const upstreamReached = new Promise<void>(resolve => {
    arrived = resolve;
  });
  // An upstream that never answers: only the client's hang-up ends the request.
  const upstream = await listen(
    createServer(request => {
      request.resume();
      arrived();
    }),
  );
  const proxy = await listen(createCodexProxy({ upstream }));
  const controller = new AbortController();
  const pending = fetch(`${proxy}/v1/responses`, {
    method: 'POST',
    body: JSON.stringify(payload()),
    signal: controller.signal,
  }).catch(() => undefined);
  await upstreamReached;
  controller.abort();
  await pending;
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await (await fetch(`${proxy}/_jev/status`)).json()).activeRequests === 0) break;
    await Bun.sleep(5);
  }
  const status = await (await fetch(`${proxy}/_jev/status`)).json();
  expect(status).toMatchObject({
    activeRequests: 0,
    errors: 0,
    errorBreakdown: { client_cancelled: 1 },
    latencyMs: { count: 1 },
  });
});

it('rejects non-loopback upstreams and forwards oversized requests unevaluated', async () => {
  expect(() => createCodexProxy({ upstream: 'http://example.com' })).toThrow(/HTTPS/);
  let received = Buffer.alloc(0);
  const upstream = await listen(
    createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = Buffer.concat(chunks);
      response.end('{}');
    }),
  );
  let asked = false;
  const proxy = await listen(
    createCodexProxy({
      upstream,
      maxBodyBytes: 10,
      asker: () => ({
        async ask() {
          asked = true;
          throw new Error('unexpected');
        },
      }),
    }),
  );
  // Past the buffer limit Runway neither evaluates nor refuses: the upstream gets every byte and decides.
  const sent = Buffer.from(JSON.stringify({ ...payload(), padding: 'x'.repeat(200_000) }));
  const response = await fetch(`${proxy}/v1/responses`, { method: 'POST', body: sent });
  expect(response.status).toBe(200);
  expect(received.equals(sent)).toBe(true);
  expect(asked).toBe(false);
  const beforeInvalid = (await (await fetch(`${proxy}/_jev/status`)).json()) as {
    requests: number;
    errors: number;
    activeRequests: number;
    latencyMs: { count: number };
    bypassed: Record<string, number>;
  };
  expect(beforeInvalid).toMatchObject({
    requests: 1,
    errors: 0,
    activeRequests: 0,
    latencyMs: { count: 1 },
    bypassed: { body_too_large: 1 },
  });
  expect(await rawGet(proxy, '//invalid')).toBe(400);
  const afterInvalid = (await (await fetch(`${proxy}/_jev/status`)).json()) as {
    requests: number;
    errors: number;
    latencyMs: { count: number };
  };
  expect(afterInvalid).toMatchObject({ requests: 1, errors: 0, latencyMs: { count: 1 } });
});

it("retries the exact original body once when the upstream refuses a compacted request, and drops the session's view", async () => {
  const bodies: Buffer[] = [];
  const encodings: string[] = [];
  const upstream = await listen(
    createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(Buffer.concat(chunks));
      encodings.push(String(request.headers['content-encoding'] ?? 'identity'));
      response.writeHead(bodies.length === 2 ? 422 : 200);
      response.end(COMPLETED);
    }),
  );
  const proxy = await listen(createCodexProxy({ upstream, asker: () => dropAll() }));
  const original = gzipSync(Buffer.from(JSON.stringify(payload())));
  const send = () =>
    fetch(`${proxy}/v1/responses`, {
      method: 'POST',
      headers: { 'content-encoding': 'gzip', session_id: 'session-gzip' },
      body: original,
    });
  await (await send()).text();
  await evaluated(proxy);
  const response = await send();
  expect(response.status).toBe(200);
  await response.text();
  // The compacted request went out as plain JSON, was refused, and the original went out byte for byte.
  expect(encodings).toEqual(['gzip', 'identity', 'gzip']);
  expect(bodies[2]!.equals(original)).toBe(true);
  expect(await (await fetch(`${proxy}/_jev/status`)).json()).toMatchObject({
    compacted: 0,
    estimatedInputTokensRemoved: 0,
    upstreamResponses: 3,
  });
  // With its view dropped, and no new output since, the session's next request goes out as sent.
  await (await send()).text();
  expect(bodies[3]!.equals(original)).toBe(true);
});

it('records completed JSON Responses usage in status', async () => {
  const upstream = await listen(
    createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          object: 'response',
          status: 'completed',
          usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3, total_tokens: 8 },
        }),
      );
    }),
  );
  const proxy = await listen(
    createCodexProxy({
      upstream,
      asker: () => ({
        async ask(_state, questions) {
          return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0 }])) };
        },
      }),
    }),
  );
  const response = await fetch(`${proxy}/v1/responses`, { method: 'POST', body: JSON.stringify(payload()) });
  await response.text();
  const status = (await (await fetch(`${proxy}/_jev/status`)).json()) as {
    requests: number;
    upstreamResponses: number;
    usage: {
      responses: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
      compacted: { responses: number; inputTokens: number; cachedInputTokens: number };
    };
  };
  expect(status.upstreamResponses).toBe(1);
  expect(status.usage).toEqual({
    responses: 1,
    inputTokens: 5,
    cachedInputTokens: 2,
    outputTokens: 3,
    reasoningTokens: 0,
    totalTokens: 8,
    compacted: { responses: 0, inputTokens: 0, cachedInputTokens: 0 },
  });
});

it('decodes supported encodings to compact them, and passes corrupt or unknown encodings unchanged', async () => {
  const received: Array<{ body: Buffer; encoding: string }> = [];
  const upstream = await listen(
    createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        body: Buffer.concat(chunks),
        encoding: String(request.headers['content-encoding'] ?? 'identity'),
      });
      response.end(COMPLETED);
    }),
  );
  const proxy = await listen(createCodexProxy({ upstream, asker: () => dropAll() }));
  const raw = Buffer.from(JSON.stringify(payload()));
  const post = (encoding: string, body: Buffer) =>
    fetch(`${proxy}/v1/responses`, {
      method: 'POST',
      headers: { 'content-encoding': encoding, session_id: 'session-encodings' },
      body,
    }).then(response => response.text());
  // Jev reads the deflate request between turns, and the brotli one after it goes out compacted as plain JSON.
  await post('deflate', deflateSync(raw));
  await evaluated(proxy);
  await post('br', brotliCompressSync(raw));
  expect(received[0]!.encoding).toBe('deflate');
  expect(received[1]!.encoding).toBe('identity');
  expect(received[1]!.body.toString('utf8')).toContain('Jev Runway truncated');
  const corrupt = Buffer.from('not compressed');
  await post('gzip', corrupt);
  await post('zstd', raw);
  expect(received[2]!.body.equals(corrupt)).toBe(true);
  expect(received[2]!.encoding).toBe('gzip');
  expect(received[3]!.body.equals(raw)).toBe(true);
  expect(received[3]!.encoding).toBe('zstd');
});

it('maps local /v1 requests onto generic API bases without losing paths or queries', async () => {
  const seen: string[] = [];
  const upstream = await listen(
    createServer((request, response) => {
      seen.push(request.url ?? '');
      response.end('{}');
    }),
  );
  const v1 = await listen(createCodexProxy({ upstream: `${upstream}/v1` }));
  const chatgpt = await listen(createCodexProxy({ upstream: `${upstream}/backend-api/codex` }));
  const root = await listen(createCodexProxy({ upstream }));

  await fetch(`${v1}/v1/responses?request_id=one`);
  await fetch(`${chatgpt}/v1/responses/compact?request_id=two`);
  await fetch(`${root}/v1/models?request_id=three`);

  expect(seen).toEqual([
    '/v1/responses?request_id=one',
    '/backend-api/codex/responses/compact?request_id=two',
    '/models?request_id=three',
  ]);
  expect(() => createCodexProxy({ upstream: 'https://api.example.test/v1' })).not.toThrow();
  expect(() => createCodexProxy({ upstream: 'http://api.example.test/v1' })).toThrow(/HTTPS/);
  expect(() => createCodexProxy({ upstream: 'http://127.0.0.1:8788/v1' })).toThrow(/this proxy/);
});

it('reports bounded per-session statistics and timed Jev failures without changing global totals', async () => {
  const upstream = await listen(createServer((_request, response) => response.end(COMPLETED)));
  let calls = 0;
  const proxy = await listen(
    createCodexProxy({
      upstream,
      asker: () => ({
        async ask(_state, questions) {
          const call = ++calls;
          await new Promise(resolve => setTimeout(resolve, 2));
          if (call === 1) throw new Error('synthetic Jev failure');
          return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0 }])) };
        },
      }),
    }),
  );
  const post = (headers: HeadersInit) =>
    fetch(`${proxy}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(payload()) });
  await Promise.all(
    [
      post({ session_id: 'session-a' }),
      post({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'session-b', turn_id: 'turn-b' }) }),
    ].map(pending => pending.then(response => response.text())),
  );
  // Each session's completed turn starts one evaluation; the first Jev call fails.
  await evaluated(proxy, 2);
  const global = (await (await fetch(`${proxy}/_jev/status`)).json()) as {
    requests: number;
    jevRequests: number;
    jevFailures: number;
    jevLatencyMs: { count: number; total: number; min: number | null; max: number; average: number | null };
  };
  const a = (await (await fetch(`${proxy}/_jev/status?session=session-a`)).json()) as {
    requests: number;
    jevRequests: number;
    jevFailures: number;
    jevLatencyMs: { count: number };
  };
  const b = (await (await fetch(`${proxy}/_jev/status?session=session-b`)).json()) as {
    requests: number;
    jevRequests: number;
    jevFailures: number;
    jevLatencyMs: { count: number };
  };
  expect(global).toMatchObject({ requests: 2, jevRequests: 2, jevFailures: 1, jevLatencyMs: { count: 2 } });
  expect(global.jevLatencyMs.min).not.toBeNull();
  expect(global.jevLatencyMs.average).not.toBeNull();
  expect(a.requests + b.requests).toBe(2);
  expect(a.jevRequests + b.jevRequests).toBe(2);
  expect(a.jevFailures + b.jevFailures).toBe(1);
  expect(a.jevLatencyMs.count + b.jevLatencyMs.count).toBe(2);
  const missing = await fetch(`${proxy}/_jev/status?session=missing`);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: 'Unknown session' });
});

it('does not attribute conflicting Codex session headers', async () => {
  const upstream = await listen(createServer((_request, response) => response.end('{}')));
  const proxy = await listen(
    createCodexProxy({
      upstream,
      asker: () => ({
        async ask(_state, questions) {
          return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 0 }])) };
        },
      }),
    }),
  );
  await fetch(`${proxy}/v1/responses`, {
    method: 'POST',
    headers: {
      session_id: 'plain-session',
      'x-codex-turn-metadata': JSON.stringify({ thread_id: 'metadata-session' }),
    },
    body: JSON.stringify(payload()),
  });
  expect((await fetch(`${proxy}/_jev/status?session=plain-session`)).status).toBe(404);
  expect((await fetch(`${proxy}/_jev/status?session=metadata-session`)).status).toBe(404);
  expect((await (await fetch(`${proxy}/_jev/status`)).json()).requests).toBe(1);
});

it('debug records cancellation once without leaking request content', async () => {
  const lines: string[] = [];
  const diagnostics = new Diagnostics({ JEV_RUNWAY_DEBUG: '1' }, line => lines.push(line));
  let arrived!: () => void;
  const upstreamReached = new Promise<void>(resolve => {
    arrived = resolve;
  });
  const upstream = await listen(
    createServer(request => {
      request.resume();
      arrived();
    }),
  );
  const proxy = await listen(createCodexProxy({ upstream, diagnostics }));
  const controller = new AbortController();
  const pending = fetch(`${proxy}/v1/responses`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      authorization: 'Bearer SECRET_KEY_CANARY',
      session_id: 'SECRET_SESSION_CANARY',
      'x-private': 'SECRET_HEADER_CANARY',
    },
    body: JSON.stringify({ ...payload(), instructions: 'SECRET_PROMPT_CANARY' }),
  }).catch(() => undefined);
  await upstreamReached;
  controller.abort();
  await pending;
  for (let attempt = 0; attempt < 40 && !lines.some(line => JSON.parse(line).kind === 'complete'); attempt++)
    await Bun.sleep(5);
  const completed = lines.map(line => JSON.parse(line)).filter(event => event.kind === 'complete');
  expect(completed).toHaveLength(1);
  expect(completed[0].cause).toBe('client_cancelled');
  expect(lines.join('')).not.toContain('SECRET_');
  const status = await (await fetch(`${proxy}/_jev/status`)).json();
  expect(status.errors).toBe(0);
  expect(status.errorBreakdown.client_cancelled).toBe(1);
});

it('observes application failures in completed HTTP responses', async () => {
  let scenario = 'failed';
  const upstream = await listen(
    createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Drain the request.
      }
      if (scenario === 'http500') {
        res.writeHead(500);
        res.end('synthetic');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'event: response.' +
          scenario +
          '\ndata: ' +
          JSON.stringify({ type: `response.${scenario}`, response: { status: scenario } }) +
          '\n\n',
      );
    }),
  );
  const proxy = await listen(createCodexProxy({ upstream }));
  const input = {
    input: [{ role: 'user', content: 'Read file' }],
    tools: [{ type: 'function', name: 'read_file' }],
    parallel_tool_calls: false,
  };
  for (const value of ['failed', 'http500', 'incomplete', 'completed']) {
    scenario = value;
    const response = await fetch(`${proxy}/v1/responses`, { method: 'POST', body: JSON.stringify(input) });
    await response.text();
  }
  const status = await (await fetch(`${proxy}/_jev/status`)).json();
  expect(status.errors).toBe(2);
  expect(status.errorBreakdown).toMatchObject({ upstream_response: 1, upstream_http: 1 });
});

it('counts SSE error events and EOF without completion as distinct failures', async () => {
  let scenario = 'error';
  const upstream = await listen(
    createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Drain the request.
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (scenario === 'error')
        res.end(
          'event: error\ndata: {"type":"error","code":"server_error","message":"synthetic","param":null,"sequence_number":1}\n\nevent: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
        );
      else
        res.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    }),
  );
  const proxy = await listen(createCodexProxy({ upstream }));
  const payload = {
    input: [{ role: 'user', content: 'Read a file' }],
    tools: [{ type: 'function', name: 'read_file' }],
    parallel_tool_calls: false,
  };
  for (const value of ['error', 'truncated']) {
    scenario = value;
    const response = await fetch(`${proxy}/v1/responses`, { method: 'POST', body: JSON.stringify(payload) });
    expect(await response.text()).toContain(value === 'error' ? 'synthetic' : 'partial');
  }
  const status = await (await fetch(`${proxy}/_jev/status`)).json();
  expect(status.errors).toBe(2);
  expect(status.errorBreakdown).toMatchObject({ upstream_response: 1, stream: 1 });
});

it('counts a hang-up after the terminal event as a completed request, not a cancellation', async () => {
  // Codex closes every Responses stream as soon as it has the terminal event, often before the upstream ends it.
  let sendTerminal = true;
  const upstream = await listen(
    createServer(async (request, response) => {
      for await (const _ of request) {
        /* drain */
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
      if (sendTerminal)
        response.write(
          'event: response.completed\ndata: ' +
            JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }) +
            '\n\n',
        );
    }),
  );
  const proxy = await listen(createCodexProxy({ upstream }));
  const hangUpAfter = async (marker: string) => {
    const controller = new AbortController();
    const response = await fetch(`${proxy}/v1/responses`, { method: 'POST', body: '{}', signal: controller.signal });
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes(marker)) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    await reader.read().catch(() => undefined);
  };
  const settled = async () => {
    for (;;) {
      const status = await (await fetch(`${proxy}/_jev/status`)).json();
      if (status.activeRequests === 0) return status;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  await hangUpAfter('response.completed');
  expect(await settled()).toMatchObject({ errors: 0, errorBreakdown: { client_cancelled: 0, stream: 0 } });
  // A hang-up before the terminal event is still a cancellation.
  sendTerminal = false;
  await hangUpAfter('response.created');
  expect(await settled()).toMatchObject({ errors: 0, errorBreakdown: { client_cancelled: 1, stream: 0 } });
});

it("reapplies a session's view with no further Jev call until new tool output arrives", async () => {
  const received: string[] = [];
  const upstream = await listen(
    createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push(body);
      response.end(COMPLETED);
    }),
  );
  let calls = 0;
  const proxy = await listen(
    createCodexProxy({
      upstream,
      asker: () => ({
        async ask(state: unknown, questions: object) {
          calls++;
          return dropAll().ask(state, questions);
        },
      }),
    }),
  );
  const send = () =>
    fetch(`${proxy}/v1/responses`, {
      method: 'POST',
      headers: { session_id: 'session-memory' },
      body: JSON.stringify(payload()),
    }).then(response => response.text());
  await send();
  await evaluated(proxy);
  await send();
  await Bun.sleep(20);
  await send();
  // One evaluation decided the call; the next two requests carried that decision, and nothing new
  // arrived to decide, so Jev was not asked again.
  expect(calls).toBe(1);
  expect(received[1]).toContain('Jev Runway truncated');
  expect(received[2]).toBe(received[1]!);
  expect(await (await fetch(`${proxy}/_jev/status?session=session-memory`)).json()).toMatchObject({
    compacted: 2,
    jevRequests: 1,
    evaluations: { evaluated: 1 },
  });
});

it("compacts Codex's own compaction request, and starts the session over after it", async () => {
  const received: Record<string, unknown>[] = [];
  const upstream = await listen(
    createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push(JSON.parse(body));
      response.end(COMPLETED);
    }),
  );
  const proxy = await listen(createCodexProxy({ upstream, asker: () => dropAll() }));
  const send = (body: object) =>
    fetch(`${proxy}/v1/responses`, {
      method: 'POST',
      headers: { session_id: 'session-codex-compaction' },
      body: JSON.stringify(body),
    }).then(response => response.text());
  await send(payload());
  await evaluated(proxy);
  // The model summarizes without the stale output.
  const summarize = {
    ...payload(),
    input: [
      ...payload().input,
      { role: 'user', content: 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary.' },
    ],
  };
  await send(summarize);
  expect(JSON.stringify(received[1]!.input)).toContain('Jev Runway truncated');
  // Codex then replaces its history with the summary, so the old view no longer applies.
  await Bun.sleep(20);
  await send(payload());
  expect(received[2]).toEqual(payload());
});

it('retries an evaluator outage twice between turns, after Retry-After, so 503s do not cost the session its compaction', async () => {
  const received: string[] = [];
  const upstream = await listen(
    createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push(body);
      response.end(COMPLETED);
    }),
  );
  let calls = 0;
  const proxy = await listen(
    createCodexProxy({
      upstream,
      asker: () => ({
        async ask(state: unknown, questions: object) {
          if (++calls <= 2) throw new JevError('http', 'unavailable', 503, 1);
          return dropAll().ask(state, questions);
        },
      }),
    }),
  );
  const send = () =>
    fetch(`${proxy}/v1/responses`, {
      method: 'POST',
      headers: { session_id: 'session-retry' },
      body: JSON.stringify(payload()),
    }).then(response => response.text());
  await send();
  expect(await evaluated(proxy)).toMatchObject({ evaluations: { evaluated: 1 }, jevRequests: 3, jevFailures: 2 });
  await send();
  expect(calls).toBe(3);
  expect(received[1]).toContain('Jev Runway truncated');
});

it('saves a truncated result where the model can read it, and counts calls made again after a drop', async () => {
  const received: string[] = [];
  const upstream = await listen(
    createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push(body);
      response.end(COMPLETED);
    }),
  );
  const archiveDir = mkdtempSync(join(tmpdir(), 'jev-runway-archive-'));
  // Keep every call, drop every full result: the old log is truncated, not removed.
  const proxy = await listen(
    createCodexProxy({
      upstream,
      archiveDir,
      asker: () => ({
        async ask(_state: unknown, questions: object) {
          return {
            answers: Object.fromEntries(
              Object.keys(questions).map(id => [id, { type: 'noul' as const, noul: id.startsWith('call_') ? 1 : 0 }]),
            ),
          };
        },
      }),
    }),
  );
  const send = (body: object) =>
    fetch(`${proxy}/v1/responses`, {
      method: 'POST',
      headers: { session_id: 'session-archive' },
      body: JSON.stringify(body),
    }).then(response => response.text());
  // The session's history on the first request predates the process, so re-runs count from the second.
  await send({ ...payload(), input: payload().input.slice(0, 1) });
  await send(payload());
  await evaluated(proxy);
  await send(payload());
  const note = /the full output is saved in (\S+\.txt)\]/.exec(received[2]!);
  expect(note).not.toBeNull();
  expect(readFileSync(note![1]!, 'utf8')).toBe('old irrelevant log '.repeat(3_000));
  // The model runs the dropped call again; a different call does not count.
  const again = payload();
  again.input.push(
    { type: 'function_call', call_id: 'again', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'again', output: 'fresh' },
    { type: 'function_call', call_id: 'other', name: 'read', arguments: '{"path":"b"}' },
    { type: 'function_call_output', call_id: 'other', output: 'b' },
  );
  await send(again);
  const status = await (await fetch(`${proxy}/_jev/status`)).json();
  expect(status).toMatchObject({ callsObserved: 3, callsDropped: 1, rerunAfterDrop: 1, rerunOtherwise: 0 });
  // The same note on every later request, so the prompt cache keeps its prefix.
  expect(received[3]).toContain(note![0]!);
});

it('remembers but does not count the history a session brings when the process first sees it', async () => {
  const upstream = await listen(createServer((_request, response) => response.end(COMPLETED)));
  const proxy = await listen(createCodexProxy({ upstream }));
  const history = payload();
  history.input.push(
    { type: 'function_call', call_id: 'twice', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'twice', output: 'x' },
  );
  const send = (body: object) =>
    fetch(`${proxy}/v1/responses`, {
      method: 'POST',
      headers: { session_id: 'session-history' },
      body: JSON.stringify(body),
    }).then(response => response.text());
  await send(history);
  expect(await (await fetch(`${proxy}/_jev/status`)).json()).toMatchObject({ callsObserved: 0, rerunOtherwise: 0 });
  // A new call repeating one from before the restart is not a re-run this process can attribute.
  history.input.push(
    { type: 'function_call', call_id: 'third', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'third', output: 'x' },
  );
  await send(history);
  expect(await (await fetch(`${proxy}/_jev/status`)).json()).toMatchObject({ callsObserved: 1, rerunOtherwise: 0 });
});

it('prunes saved outputs a week after their session last wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-runway-prune-'));
  for (const name of ['old', 'new']) mkdirSync(join(dir, name));
  const week = 7 * 86_400_000;
  utimesSync(join(dir, 'old'), new Date(Date.now() - week - 60_000), new Date(Date.now() - week - 60_000));
  pruneArchive(dir);
  expect(existsSync(join(dir, 'old'))).toBe(false);
  expect(existsSync(join(dir, 'new'))).toBe(true);
  pruneArchive(join(dir, 'missing'));
});

it('counts earlier calls whose files a later call reads again, once each, by whether they were dropped', async () => {
  const upstream = await listen(createServer((_request, response) => response.end(COMPLETED)));
  const proxy = await listen(createCodexProxy({ upstream, asker: () => dropAll() }));
  const call = (id: string, cmd: string, output = 'x') => [
    {
      type: 'custom_tool_call',
      call_id: id,
      name: 'exec',
      input: `const r = await tools.exec_command({"cmd":"${cmd}"}); text(r.output);`,
    },
    { type: 'custom_tool_call_output', call_id: id, output },
  ];
  const tail = Array.from({ length: 6 }, () => ({ role: 'user', content: 'Keep going.' }));
  const send = (input: object[]) =>
    fetch(`${proxy}/v1/responses`, {
      method: 'POST',
      headers: { session_id: 'session-reread' },
      body: JSON.stringify({ model: 'test', input }),
    }).then(response => response.text());
  await send([{ role: 'user', content: 'Fix the parser.' }]);
  const history = [
    { role: 'user', content: 'Fix the parser.' },
    ...call('a', "sed -n '1,200p' src/parser.ts", 'source '.repeat(6_000)),
    ...call('b', 'cat ./docs/notes.md'),
  ];
  await send([...history, ...tail]);
  await evaluated(proxy);
  // Different commands, so no exact re-run: the parser is read again, twice, and one new file once.
  await send([
    ...history,
    ...tail,
    ...call('c', "sed -n '200,400p' src/parser.ts"),
    ...call('d', 'rg -n parse src/parser.ts src/lexer.ts'),
  ]);
  expect(await (await fetch(`${proxy}/_jev/status`)).json()).toMatchObject({
    callsObserved: 4,
    callsDropped: 2,
    rerunAfterDrop: 0,
    rereadAfterDrop: 1,
    rereadOtherwise: 1,
  });
});

it('takes calibration samples only between requests sent with the same view', () => {
  const session = new Sessions().get('calibration');
  const view = session.view;
  expect(calibrationSample(session, { view, estimated: 1_000, billed: 400 })).toBeUndefined();
  expect(calibrationSample(session, { view, estimated: 3_000, billed: 1_400 })).toEqual({
    billed: 1_000,
    estimated: 2_000,
  });
  // A new view removed something between the two: the growth no longer measures new items.
  expect(calibrationSample(session, { view: new Map(), estimated: 5_000, billed: 2_000 })).toBeUndefined();
  expect(calibrationSample(session, { view: session.lastSent!.view, estimated: 4_000, billed: 1_900 })).toBeUndefined();
});

it('converts removed tokens at the rate the upstream counted new items', async () => {
  const upstream = await listen(
    createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      // A stand-in tokenizer: one token for every ten bytes sent.
      response.end(
        JSON.stringify({
          object: 'response',
          status: 'completed',
          output: [],
          usage: { input_tokens: Math.round(body.length / 10), output_tokens: 1 },
        }),
      );
    }),
  );
  const proxy = await listen(createCodexProxy({ upstream, asker: () => dropAll() }));
  const status = async () => (await fetch(`${proxy}/_jev/status`)).json();
  const send = (session: string, input: object[]) =>
    fetch(`${proxy}/v1/responses`, {
      method: 'POST',
      headers: { session_id: session },
      body: JSON.stringify({ model: 'test', input }),
    }).then(response => response.text());
  const step = (id: string, size: number) => [
    { type: 'function_call', call_id: id, name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: id, output: 'build step passed '.repeat(size) },
  ];
  // Below the evaluation threshold, the view stays put, so the second request's growth is a sample.
  const warm = [{ role: 'user', content: 'Check the build.' }, ...step('a', 300)];
  await send('warm', warm);
  await send('warm', [...warm, ...step('b', 900)]);
  for (let attempt = 0; attempt < 200 && (await status()).calibrationEstimatedTokens === 0; attempt++)
    await Bun.sleep(5);
  await send('compacted', payload().input);
  await evaluated(proxy);
  await send('compacted', payload().input);
  let result = await status();
  for (let attempt = 0; attempt < 200 && result.billedInputTokensRemoved === 0; attempt++) {
    await Bun.sleep(5);
    result = await status();
  }
  expect(result.calibrationEstimatedTokens).toBeGreaterThanOrEqual(2_000);
  const rate = result.calibrationBilledTokens / result.calibrationEstimatedTokens;
  expect(rate).toBeGreaterThan(0.2);
  expect(rate).toBeLessThan(0.8);
  expect(result.billedInputTokensRemoved).toBe(Math.round(result.estimatedInputTokensRemoved * rate));
});
