import { expect, test } from 'bun:test';
import { paint, renderHelp, renderStatus, wrap } from '../src/terminal.js';

const plain = { color: false, width: 90 };
const credentials = { configured: true, provider: 'gateway', source: 'environment', apiKey: 'private-key' };
const running = (metrics: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  proxy: 'ok',
  upstream: 'http://127.0.0.1:8787/v1',
  codexUsesProxy: true,
  credentials,
  metrics: { uptimeMs: 3_600_000, ...metrics },
  ...extra,
});

test('leads with calibrated savings as a share of what would have been sent', () => {
  const text = renderStatus(
    running({
      requests: 12,
      compacted: 6,
      requestTypes: { responses: 10, models: 2 },
      billedInputTokensRemoved: 25_000,
      estimatedInputTokensRemoved: 50_000,
      usage: {
        responses: 10,
        inputTokens: 75_000,
        cachedInputTokens: 60_000,
        compacted: { responses: 6, inputTokens: 40_000, cachedInputTokens: 36_000 },
      },
    }),
    plain,
  );
  expect(text).toContain('◆ Jev Runway');
  expect(text).toContain('● running · up 1h 0m');
  expect(text).toContain('25% fewer');
  expect(text).toContain('25.0k removed · 75.0k sent');
  expect(text).toContain('6 of 10 model requests (60%)');
  expect(text).toContain('80% of input served from cache · 90% on trimmed requests');
  expect(text).toContain('✓ routed through Runway');
  expect(text).toContain('Vercel AI Gateway · environment');
  expect(text).not.toContain('private-key');
  expect(text).not.toContain('\x1b');
});

test('shows an uncalibrated estimate without a share, and says why', () => {
  expect(renderStatus(running({ estimatedInputTokensRemoved: 2_000, calibrationEstimatedTokens: 0 }), plain)).toContain(
    '~2.0k removed (estimate · calibrating to your provider)',
  );
  expect(renderStatus(running({ estimatedInputTokensRemoved: 2_000 }), plain)).toContain(
    'reinstall Runway for calibrated savings',
  );
  expect(renderStatus(running({}), plain)).toContain('nothing trimmed yet');
});

test('judges trimming by how often the model needed dropped output again', () => {
  const good = renderStatus(
    running({ callsObserved: 100, callsDropped: 50, rerunAfterDrop: 1, rereadAfterDrop: 5, rereadOtherwise: 40 }),
    plain,
  );
  expect(good).toContain('✓ 1 of 50 trimmed calls run again (2.0%)');
  expect(good).toContain('✓ 10% of trimmed files read again · 40% of files otherwise');
  const bad = renderStatus(
    running({ callsObserved: 100, callsDropped: 50, rerunAfterDrop: 10, rereadAfterDrop: 30, rereadOtherwise: 10 }),
    plain,
  );
  expect(bad).toContain('! 10 of 50 trimmed calls run again');
  expect(bad).toContain('The model re-ran 20% of trimmed calls');
});

test('turns failures into problems with what to do', () => {
  const text = renderStatus(
    running(
      {
        requests: 50,
        errors: 5,
        jevRequests: 20,
        jevFailures: 6,
        jevHttpStatus: { 503: 6 },
        jevFailureReasons: { http: 6 },
        errorBreakdown: { upstream_transport: 5, client_cancelled: 2 },
      },
      { codexUsesProxy: false, credentials: { configured: false, source: 'none' } },
    ),
    plain,
  );
  expect(text).toContain('6 (HTTP 503 ×6) · retried');
  expect(text).toContain('Jev failed on 30% of calls. Run jev-runway auth check.');
  expect(text).toContain('5 requests could not reach the upstream (http://127.0.0.1:8787/v1)');
  expect(text).toContain('Codex is not sending requests through Runway. Run jev-runway install.');
  expect(text).toContain('No Jev key, so nothing is trimmed. Run jev-runway auth set.');
  expect(text).toContain('5 failed · 2 cancelled');
});

test('says what to do when Runway is not running, and when a session has no data', () => {
  const down = renderStatus({ proxy: 'down', upstream: '\x1b[31m', codexUsesProxy: true, credentials }, plain);
  expect(down).toContain('○ not running');
  expect(down).toContain('Runway is not running. Run jev-runway install');
  expect(down).toContain('routed through Runway, which is not running');
  expect(down).not.toContain('\x1b');
  const empty = renderStatus(running({}, { session: 'thread-1', noData: true }), plain);
  expect(empty).toContain('session thread-1');
  expect(empty).toContain('No data recorded for session thread-1 yet.');
});

test('details list the counters behind the summary', () => {
  const text = renderStatus(
    running({
      requests: 10,
      requestTypes: { responses: 9, models: 1 },
      estimatedInputTokensRemoved: 2_000,
      calibrationBilledTokens: 470,
      calibrationEstimatedTokens: 1_000,
      evaluations: { evaluated: 3, jev_failed: 1 },
      bypassed: { no_view: 4 },
      debugEnabled: true,
      websocketIncremental: 5,
      websocketFull: 1,
      websocketBytesSent: 2_000_000,
      websocketBytesWhole: 3_000_000,
    }),
    { ...plain, details: true },
  );
  expect(text).toContain('your provider counts 0.47 tokens per estimated token');
  expect(text).toContain('evaluated 3, jev_failed 1');
  expect(text).toContain('no_view 4');
  expect(text).toContain('responses 9, models 1');
  expect(text).toContain('5 new items only · 1 whole · 0 over HTTP');
  expect(text).toContain('on (metadata only)');
  expect(renderStatus(running({}), plain)).toContain('More: jev-runway status --details');
});

test('fits narrow terminals and wraps notices', () => {
  expect(wrap('! one two three four five six', 16, 2)).toEqual(['  ! one two', '    three four', '    five six']);
  const text = renderStatus(running({ errorBreakdown: { upstream_transport: 3 } }), { color: false, width: 40 });
  expect(
    text
      .split('\n')
      .filter(line => line.includes('could not reach'))
      .every(line => line.length <= 40),
  ).toBe(true);
});

test('help groups commands by task and colors only when asked', () => {
  const help = renderHelp(paint(false));
  for (const text of ['SET UP', 'WATCH', 'JEV KEY', 'install', 'status', '--watch', 'auth reset'])
    expect(help).toContain(text);
  expect(help).not.toContain('\x1b');
  expect(renderHelp(paint(true))).toContain('\x1b[1m');
});
