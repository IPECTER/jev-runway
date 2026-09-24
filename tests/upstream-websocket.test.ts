import { afterEach, expect, it } from 'bun:test';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createCodexProxy } from '../src/codex-proxy.js';
import { rateLimitHeaders } from '../src/upstream-websocket.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => server.close());
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

/** A Responses upstream that answers over WebSocket the way ChatGPT's Codex backend does, and over HTTP. */
function upstream(options: { refuseContinuation?: boolean } = {}) {
  const frames: Record<string, unknown>[] = [];
  const http: string[] = [];
  let responses = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { headers: Object.fromEntries(request.headers) } })) return undefined;
      return request.text().then(body => {
        http.push(body);
        return new Response(
          'data: {"type":"response.completed","response":{"id":"resp_http","status":"completed","output":[]}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      });
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(String(message)) as Record<string, unknown>;
        frames.push({ ...frame, headers: (socket.data as { headers: Record<string, string> }).headers });
        if (options.refuseContinuation && frame.previous_response_id) {
          socket.send(JSON.stringify({ type: 'error', status: 400, error: { code: 'previous_response_not_found' } }));
          return;
        }
        const id = `resp_${++responses}`;
        // The server labels its output with metadata that Codex drops from its history.
        const item = {
          type: 'message',
          id: `msg_${responses}`,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: `reply ${responses}` }],
          metadata: { turn_id: 't' },
          internal_chat_message_metadata_passthrough: { create_time: 1 },
        };
        socket.send(
          JSON.stringify({
            type: 'codex.rate_limits',
            rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, reset_at: 1790000000 } },
          }),
        );
        socket.send(JSON.stringify({ type: 'response.created', response: { id, status: 'in_progress' } }));
        socket.send(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }));
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: { id, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 5 } },
          }),
        );
      },
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/v1`, frames, http };
}

const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
/** The assistant reply as Codex puts it back into its history: without the server's id and status. */
const reply = (n: number) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: `reply ${n}` }],
});
const request = (input: unknown[]) => ({
  model: 'gpt-test',
  instructions: 'Be brief.',
  input,
  tools: [],
  tool_choice: 'auto',
  parallel_tool_calls: false,
  store: false,
  stream: true,
  include: [],
});

async function post(proxy: string, body: object, session = 'session-ws') {
  const response = await fetch(`${proxy}/v1/responses`, {
    method: 'POST',
    headers: { session_id: session, authorization: 'Bearer synthetic', 'x-codex-turn-state': 'turn-1' },
    body: JSON.stringify(body),
  });
  return { response, text: await response.text() };
}

it('sends the first request whole and a continuation with only its new items, over one WebSocket', async () => {
  const server = upstream();
  const proxy = await listen(createCodexProxy({ upstream: server.url, websocket: true }));
  const first = await post(proxy, request([user('Hi')]));
  expect(first.response.status).toBe(200);
  expect(first.response.headers.get('content-type')).toBe('text/event-stream');
  expect(first.response.headers.get('x-codex-primary-used-percent')).toBe('12.5');
  expect(first.text).toContain('event: response.completed');
  await post(proxy, request([user('Hi'), reply(1), user('More')]));
  expect(server.frames).toHaveLength(2);
  expect(server.frames[0]).toMatchObject({
    type: 'response.create',
    model: 'gpt-test',
    input: [user('Hi')],
    client_metadata: { 'x-codex-turn-state': 'turn-1' },
  });
  expect(server.frames[0]).not.toHaveProperty('previous_response_id');
  // The server keeps what it already has: only the new user message goes up.
  expect(server.frames[1]).toMatchObject({ previous_response_id: 'resp_1', input: [user('More')] });
  const headers = server.frames[0]!.headers as Record<string, string>;
  expect(headers['openai-beta']).toContain('responses_websockets=2026-02-06');
  expect(headers.authorization).toBe('Bearer synthetic');
  expect(headers).not.toHaveProperty('x-codex-turn-state');
  expect(server.http).toHaveLength(0);
  const status = await (await fetch(`${proxy}/_jev/status`)).json();
  expect(status).toMatchObject({ websocketFull: 1, websocketIncremental: 1, websocketWhole: { first: 1 } });
  expect(status.websocketBytesSent).toBeLessThan(status.websocketBytesWhole);
});

it('sends the whole history again when a request does not continue the previous one', async () => {
  const server = upstream();
  const proxy = await listen(createCodexProxy({ upstream: server.url, websocket: true }));
  await post(proxy, request([user('Hi'), user('Old output')]));
  // What the server holds no longer leads to this request, as after Jev trims more.
  await post(proxy, request([user('Hi'), reply(1), user('More')]));
  expect(server.frames[1]).not.toHaveProperty('previous_response_id');
  expect(server.frames[1]).toMatchObject({ input: [user('Hi'), reply(1), user('More')] });
  // So does a request whose settings changed.
  await post(proxy, { ...request([user('Hi'), reply(1), user('More'), reply(2), user('Again')]), model: 'gpt-other' });
  expect(server.frames[2]).not.toHaveProperty('previous_response_id');
});

it('falls back to HTTP when the upstream takes no WebSocket or refuses a continuation', async () => {
  const plain = createServer(async (request, response) => {
    for await (const _ of request) {
      /* drain */
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
  });
  const proxy = await listen(createCodexProxy({ upstream: `${await listen(plain)}/v1`, websocket: true }));
  expect((await post(proxy, request([user('Hi')]))).response.status).toBe(200);
  expect(await (await fetch(`${proxy}/_jev/status`)).json()).toMatchObject({
    websocketFallbacks: { connect_failed: 1 },
  });

  const refusing = upstream({ refuseContinuation: true });
  const second = await listen(createCodexProxy({ upstream: refusing.url, websocket: true }));
  await post(second, request([user('Hi')]));
  const retried = await post(second, request([user('Hi'), reply(1), user('More')]));
  expect(retried.response.status).toBe(200);
  // The refused continuation went over HTTP, whole.
  expect(refusing.http).toHaveLength(1);
  expect(JSON.parse(refusing.http[0]!).input).toEqual([user('Hi'), reply(1), user('More')]);
});

it('turns the rate-limit event into the headers Codex reads over HTTP', () => {
  expect(
    rateLimitHeaders({
      type: 'codex.rate_limits',
      metered_limit_name: 'codex_other',
      rate_limits: {
        primary: { used_percent: 40, window_minutes: 300 },
        secondary: { used_percent: 5, reset_at: 1790000000 },
      },
      credits: { has_credits: true, unlimited: false, balance: '12' },
    }),
  ).toEqual({
    'x-codex-other-primary-used-percent': '40',
    'x-codex-other-primary-window-minutes': '300',
    'x-codex-other-secondary-used-percent': '5',
    'x-codex-other-secondary-reset-at': '1790000000',
    'x-codex-credits-has-credits': 'true',
    'x-codex-credits-unlimited': 'false',
    'x-codex-credits-balance': '12',
  });
});
