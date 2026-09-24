import { expect, it } from 'bun:test';
import { classifyJevFailure, Diagnostics, JevError } from '../src/diagnostics.js';
import { jevCaller } from '../src/jev.js';

it('emits only the allowlisted diagnostic fields', () => {
  const lines: string[] = [];
  const diagnostics = new Diagnostics({ JEV_RUNWAY_DEBUG: '1' }, line => lines.push(line));
  diagnostics.emit('upstream', {
    requestId: 'request-id',
    session: diagnostics.session('session-secret'),
    phase: 'forward',
    durationMs: 12.8,
    statusCode: 429,
    cause: 'rate_limit',
    attribution: 'valid',
  });
  expect(JSON.parse(lines[0]!)).toMatchObject({
    event: 'jev_runway',
    at: expect.any(String),
    kind: 'upstream',
    requestId: 'request-id',
    session: diagnostics.session('session-secret'),
    phase: 'forward',
    durationMs: 13,
    statusCode: 429,
    cause: 'rate_limit',
    attribution: 'valid',
  });
  expect(lines.join('')).not.toContain('session-secret');
});

it('classifies typed Jev failures without inspecting error text', () => {
  expect(classifyJevFailure(new JevError('timeout', 'secret prompt text'))).toBe('timeout');
  expect(classifyJevFailure(new Error('secret prompt text'))).toBe('other');
});

it('keeps Retry-After as typed Jev metadata', async () => {
  const client = jevCaller({
    apiKey: 'test',
    fetch: (async () => new Response('', { status: 503, headers: { 'retry-after': '61' } })) as unknown as typeof fetch,
  });
  await expect(client.ask({} as never, {} as never)).rejects.toMatchObject({
    cause: 'http',
    statusCode: 503,
    retryAfterMs: 61_000,
  });
});

it('caps diagnostics per hour, records dropped events, and refills', () => {
  let now = 1_000;
  const diagnostics = new Diagnostics(
    { JEV_RUNWAY_DEBUG: '1' },
    () => undefined,
    () => now,
  );
  for (let index = 0; index < 10_001; index++) diagnostics.emit('complete', { requestId: String(index), cause: 'ok' });
  expect(diagnostics.snapshot()).toEqual({ emitted: 10_000, dropped: 1, limit: 10_000, windowMs: 3_600_000 });
  // Still inside the hour: the budget is spent and every further event is dropped.
  now += 3_599_999;
  diagnostics.emit('complete', { requestId: 'same-window', cause: 'ok' });
  expect(diagnostics.snapshot()).toMatchObject({ emitted: 10_000, dropped: 2 });
  // The hour is over, so a service that has been up for days can still be diagnosed.
  now += 1;
  diagnostics.emit('complete', { requestId: 'next-window', cause: 'ok' });
  expect(diagnostics.snapshot()).toMatchObject({ emitted: 1, dropped: 2 });
});

it('does not fail the proxy when a diagnostic sink fails', () => {
  const diagnostics = new Diagnostics({ JEV_RUNWAY_DEBUG: '1' }, () => {
    throw new Error('unavailable');
  });
  expect(() => diagnostics.emit('complete', { requestId: 'test', cause: 'ok' })).not.toThrow();
  expect(diagnostics.snapshot().dropped).toBe(1);
});

it('logs a compaction outcome by name, and only known names', () => {
  const lines: string[] = [];
  const diagnostics = new Diagnostics({ JEV_RUNWAY_DEBUG: '1' }, line => {
    lines.push(line);
    return true;
  });
  diagnostics.emit('compaction', { requestId: 'request-id', reason: 'history_too_large', durationMs: 12.4 });
  diagnostics.emit('compaction', { requestId: 'request-id', reason: 'SECRET_REASON_CANARY' });
  expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'compaction', reason: 'history_too_large', durationMs: 12 });
  expect(JSON.parse(lines[1]!)).not.toHaveProperty('reason');
});
