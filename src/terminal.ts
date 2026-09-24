type Values = Record<string, unknown>;

export function isTerminal(): boolean {
  return Boolean(process.stdout.isTTY);
}
export function colorEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  return Boolean(stream.isTTY) && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
const clean = (value: unknown): string => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const object = (value: unknown): Values =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Values) : {};
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const exact = (value: unknown): string => number(value)?.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? '—';
/** 950, 12.3k, 4.5M: for headline figures, where the exact count lives in `--details`. */
const short = (value: unknown): string => {
  const n = number(value);
  if (n === undefined) return '—';
  for (const [size, unit] of [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ] as const)
    if (n >= size) return `${(n / size).toFixed(n >= size * 100 ? 0 : 1)}${unit}`;
  return String(Math.round(n));
};
const percent = (fraction: number, digits = 0): string => `${(fraction * 100).toFixed(digits)}%`;
const ratio = (part: unknown, whole: unknown): number | undefined => {
  const total = number(whole) ?? 0;
  return total > 0 ? (number(part) ?? 0) / total : undefined;
};
const duration = (value: unknown): string => {
  const ms = number(value);
  if (ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
const sum = (values: Values): number =>
  Object.values(values).reduce((total: number, value) => total + (number(value) ?? 0), 0);
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the escape that starts a color code.
const visible = (text: string): number => Array.from(text.replace(/\x1b\[[0-9;]*m/g, '')).length;

export interface Paint {
  bold(text: string): string;
  dim(text: string): string;
  accent(text: string): string;
  good(text: string): string;
  warn(text: string): string;
  bad(text: string): string;
}
export function paint(colored = colorEnabled()): Paint {
  const code = (open: number, close: number) => (text: string) =>
    colored ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  return {
    bold: code(1, 22),
    dim: code(2, 22),
    accent: code(36, 39),
    good: code(32, 39),
    warn: code(33, 39),
    bad: code(31, 39),
  };
}

const PROVIDERS: Values = { gateway: 'Vercel AI Gateway', typesafe: 'TypeSafe' };
const LABEL = 14;

/** The removed input as a share of what would have been sent, once it is calibrated to the upstream's counts. */
function savings(metrics: Values) {
  const sent = number(object(metrics.usage).inputTokens) ?? 0;
  const calibrated = number(metrics.billedInputTokensRemoved) ?? 0;
  if (calibrated > 0 && sent > 0)
    return { calibrated: true as const, removed: calibrated, sent, fraction: calibrated / (sent + calibrated) };
  return {
    calibrated: false as const,
    removed: number(metrics.estimatedInputTokensRemoved) ?? 0,
    supported: metrics.calibrationEstimatedTokens !== undefined,
  };
}

/**
 * The `status` screen: whether Runway is working, then what it saves, whether trimming hurts the model, and
 * what Jev is doing, each in plain words. Problems come last with what to do about them. `details` adds the
 * raw counters behind every figure.
 */
export function renderStatus(
  status: Values,
  options: { width?: number; color?: boolean; details?: boolean } = {},
): string {
  const width = Math.max(40, Math.min(options.width ?? process.stdout.columns ?? 80, 96));
  const p = paint(options.color);
  const metrics = object(status.metrics);
  const usage = object(metrics.usage);
  const failures = object(metrics.errorBreakdown);
  const credentials = object(status.credentials);
  const running = status.proxy === 'ok';
  const session = typeof status.session === 'string' ? clean(status.session) : undefined;
  const upstream = status.upstream && status.upstream !== 'not-configured' ? clean(status.upstream) : undefined;
  const lines: string[] = [];
  const notices: string[] = [];
  const heading = (text: string) => lines.push('', p.accent(p.bold(text.toUpperCase())));
  const row = (label: string, value: string) => lines.push(`  ${label.padEnd(LABEL)}${value}`);
  const check = (ok: boolean) => (ok ? p.good('✓') : p.warn('!'));
  const bar = (fraction: number) => {
    const size = Math.max(8, Math.min(24, width - LABEL - 20));
    const filled = Math.round(Math.min(1, fraction) * size);
    return p.good('█'.repeat(filled)) + p.dim('░'.repeat(size - filled));
  };

  const title = p.bold('◆ Jev Runway') + (session ? p.dim(`  session ${session}`) : '');
  const state = running ? p.good('● running') + p.dim(` · up ${duration(metrics.uptimeMs)}`) : p.bad('○ not running');
  lines.push(
    title + ' '.repeat(Math.max(2, width - visible(title) - visible(state))) + state,
    p.dim('─'.repeat(width)),
  );

  if (!running)
    notices.push(
      `${p.bad('✖')} Runway is not running. Run ${p.bold('jev-runway install')} to start the background service.`,
    );
  else if (status.noData === true) lines.push('', `  No data recorded for session ${session ?? ''} yet.`);
  else {
    const modelRequests = number(object(metrics.requestTypes).responses) ?? number(metrics.requests) ?? 0;
    const compacted = number(metrics.compacted) ?? 0;
    const saved = savings(metrics);
    heading('Savings');
    if (saved.calibrated) {
      row('Input tokens', `${bar(saved.fraction)}  ${p.good(p.bold(percent(saved.fraction)))} fewer`);
      row('', p.dim(`${short(saved.removed)} removed · ${short(saved.sent)} sent · in your provider's own counts`));
    } else if (saved.removed > 0) {
      row(
        'Input tokens',
        `~${short(saved.removed)} removed ${p.dim(saved.supported ? '(estimate · calibrating to your provider)' : '(estimate · reinstall Runway for calibrated savings)')}`,
      );
    } else row('Input tokens', p.dim('nothing trimmed yet'));
    row(
      'Trimmed',
      `${exact(compacted)} of ${exact(modelRequests)} model requests` +
        (modelRequests ? p.dim(` (${percent(compacted / modelRequests)})`) : ''),
    );
    const cached = ratio(usage.cachedInputTokens, usage.inputTokens);
    const compactedUsage = object(usage.compacted);
    const cachedCompacted = ratio(compactedUsage.cachedInputTokens, compactedUsage.inputTokens);
    if (cached !== undefined)
      row(
        'Cache',
        `${percent(cached)} of input served from cache` +
          (cachedCompacted !== undefined ? p.dim(` · ${percent(cachedCompacted)} on trimmed requests`) : ''),
      );
    // A rewritten input cannot reuse the cached prefix past the point it changed. Well under the overall
    // share, trimming buys fewer input tokens at full price and may cost more than it saves.
    if (
      cached !== undefined &&
      cachedCompacted !== undefined &&
      (number(compactedUsage.responses) ?? 0) >= 20 &&
      cachedCompacted < cached - 0.1
    ) {
      notices.push(
        `${p.warn('!')} Trimmed requests hit the provider cache less often (${percent(cachedCompacted)} vs ${percent(cached)}), so real savings are smaller than the token count.`,
      );
    }

    const dropped = number(metrics.callsDropped) ?? 0;
    if (dropped > 0) {
      heading('Quality');
      // A call made again after Jev dropped the identical earlier one, and files read again after their call
      // was dropped, against how often files are read again anyway: every call spends time undropped first.
      const rerun = (number(metrics.rerunAfterDrop) ?? 0) / dropped;
      const reread = (number(metrics.rereadAfterDrop) ?? 0) / dropped;
      const rereadOtherwise = ratio(metrics.rereadOtherwise, metrics.callsObserved) ?? 0;
      row(
        'Re-runs',
        `${check(rerun <= 0.05)} ${exact(metrics.rerunAfterDrop)} of ${exact(dropped)} trimmed calls run again ${p.dim(`(${percent(rerun, 1)})`)}`,
      );
      row(
        'Re-reads',
        `${check(reread <= rereadOtherwise + 0.05)} ${percent(reread)} of trimmed files read again ${p.dim(`· ${percent(rereadOtherwise)} of files otherwise`)}`,
      );
      if (dropped >= 20 && rerun > 0.05)
        notices.push(
          `${p.warn('!')} The model re-ran ${percent(rerun)} of trimmed calls: Jev may be letting go of output that is still needed.`,
        );
    }

    heading('Jev');
    const evaluations = object(metrics.evaluations);
    const jevCalls = number(metrics.jevRequests) ?? 0;
    const jevFailures = number(metrics.jevFailures) ?? 0;
    row(
      'Evaluations',
      `${exact(evaluations.evaluated ?? 0)} between turns · ${exact(jevCalls)} calls · ${duration(object(metrics.jevLatencyMs).average)} each`,
    );
    if (jevFailures > 0) {
      const statuses = Object.entries(object(metrics.jevHttpStatus)).map(
        ([code, value]) => `HTTP ${clean(code)} ×${exact(value)}`,
      );
      const causes = Object.entries(object(metrics.jevFailureReasons))
        .filter(([cause, value]) => cause !== 'http' && (number(value) ?? 0) > 0)
        .map(([cause, value]) => `${clean(cause)} ×${exact(value)}`);
      row(
        'Failed',
        `${p.warn(exact(jevFailures))} ${p.dim(`(${[...statuses, ...causes].join(', ')}) · retried; a failed evaluation keeps the last decisions`)}`,
      );
      if (jevCalls >= 10 && jevFailures / jevCalls > 0.2)
        notices.push(
          `${p.warn('!')} Jev failed on ${percent(jevFailures / jevCalls)} of calls. Run ${p.bold('jev-runway auth check')}.`,
        );
    }
  }

  heading('Connection');
  if (running)
    row(
      'Codex',
      status.codexUsesProxy === true
        ? `${p.good('✓')} routed through Runway`
        : `${p.warn('!')} not routed through Runway`,
    );
  else
    row(
      'Codex',
      status.codexUsesProxy === true
        ? `${p.warn('!')} routed through Runway, which is not running`
        : 'not routed through Runway',
    );
  row('Upstream', upstream ?? p.dim('not configured'));
  row(
    'Jev key',
    credentials.configured
      ? `${PROVIDERS[String(credentials.provider)] ?? 'configured'} ${p.dim(`· ${clean(credentials.source)}`)}`
      : p.warn('not configured'),
  );
  if (running && status.noData !== true) {
    const errors = number(metrics.errors) ?? 0;
    const unreachable = number(failures.upstream_transport) ?? 0;
    const cancelled = number(failures.client_cancelled) ?? 0;
    const latency = object(metrics.latencyMs);
    row(
      'Requests',
      `${exact(metrics.requests)} · ${duration(ratio(latency.total, latency.count))} avg` +
        (errors ? ` · ${p.warn(`${exact(errors)} failed`)}` : '') +
        (cancelled ? p.dim(` · ${exact(cancelled)} cancelled`) : ''),
    );
    if (status.codexUsesProxy !== true)
      notices.push(`${p.warn('!')} Codex is not sending requests through Runway. Run ${p.bold('jev-runway install')}.`);
    if (unreachable > 0)
      notices.push(
        `${p.warn('!')} ${exact(unreachable)} requests could not reach the upstream${upstream ? ` (${upstream})` : ''}. If it started after Runway, this is expected; otherwise check that it is running.`,
      );
  }
  if (!credentials.configured)
    notices.push(`${p.warn('!')} No Jev key, so nothing is trimmed. Run ${p.bold('jev-runway auth set')}.`);

  if (options.details && running && status.noData !== true) details(metrics, heading, row, p);

  if (notices.length) {
    lines.push('');
    for (const notice of notices) lines.push(...wrap(notice, width, 2));
  }
  lines.push(
    '',
    p.dim(
      running
        ? `Totals since Runway started.${options.details ? '' : ' More: jev-runway status --details'}`
        : 'Start it with: jev-runway install',
    ),
  );
  return lines.join('\n');
}

/** The raw counters behind the summary. */
function details(
  metrics: Values,
  heading: (text: string) => void,
  row: (label: string, value: string) => void,
  p: Paint,
): void {
  const usage = object(metrics.usage);
  const listing = (values: Values) =>
    Object.entries(values)
      .filter(([, value]) => (number(value) ?? 0) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([key, value]) => `${clean(key)} ${exact(value)}`)
      .join(', ') || p.dim('none');
  heading('Trimming details');
  row('Estimate', `${exact(metrics.estimatedInputTokensRemoved)} tokens by Runway's own count`);
  const rate = ratio(metrics.calibrationBilledTokens, metrics.calibrationEstimatedTokens);
  row(
    'Calibration',
    rate === undefined
      ? p.dim(
          metrics.calibrationEstimatedTokens === undefined ? 'needs a newer Runway: reinstall it' : 'no samples yet',
        )
      : `your provider counts ${rate.toFixed(2)} tokens per estimated token ${p.dim(`(${exact(metrics.calibrationEstimatedTokens)} sampled)`)}`,
  );
  row(
    'Calls',
    `${exact(metrics.callsDropped)} of ${exact(metrics.callsObserved)} trimmed · re-runs among kept calls ${exact(metrics.rerunOtherwise)}`,
  );
  row('Evaluations', listing(object(metrics.evaluations)));
  row('Untrimmed', listing(object(metrics.bypassed)));
  const jev = object(metrics.jevLatencyMs);
  row('Jev time', `${duration(jev.min)} min · ${duration(jev.max)} max · ${duration(metrics.compactionTimeMs)} total`);
  heading('Model usage');
  row('Input', `${exact(usage.inputTokens)} ${p.dim(`· ${exact(usage.cachedInputTokens)} cached`)}`);
  row('Output', `${exact(usage.outputTokens)} ${p.dim(`· ${exact(usage.reasoningTokens)} reasoning`)}`);
  row('Responses', exact(usage.responses));
  heading('Requests');
  row('Types', listing(object(metrics.requestTypes)));
  row('Sessions', listing(object(metrics.modelSessionAttribution ?? metrics.sessionAttribution)));
  row(
    'Failures',
    listing(
      Object.fromEntries(Object.entries(object(metrics.errorBreakdown)).filter(([key]) => key !== 'client_cancelled')),
    ),
  );
  row('Latency', `${duration(object(metrics.latencyMs).max)} max · ${exact(metrics.activeRequests)} active`);
  const whole = number(metrics.websocketFull) ?? 0;
  const incremental = number(metrics.websocketIncremental) ?? 0;
  const fallbacks = sum(object(metrics.websocketFallbacks));
  if (whole + incremental + fallbacks > 0) {
    row('WebSocket', `${exact(incremental)} new items only · ${exact(whole)} whole · ${exact(fallbacks)} over HTTP`);
    row(
      'Uploaded',
      `${short(metrics.websocketBytesSent)}B of ${short(metrics.websocketBytesWhole)}B the whole histories would take`,
    );
  }
  row('Debug log', metrics.debugEnabled === true ? 'on (metadata only)' : 'off');
}

/** Wraps text at spaces to `width`, indenting every line by `indent` and later lines past the leading icon. */
export function wrap(text: string, width: number, indent = 0): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && visible(current) + 1 + visible(word) > width - indent) {
      lines.push(current);
      current = `  ${word}`;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines.map(line => ' '.repeat(indent) + line);
}

/** One line of a trim ledger, as `jev-runway trims` reads it back. */
export type LedgerLine = Values;
const home = (path: string) =>
  process.env.HOME && path.startsWith(process.env.HOME) ? `~${path.slice(process.env.HOME.length)}` : path;
const REASONS: Values = {
  codex_compaction: 'Codex compacted its history',
  upstream_refused: 'the upstream refused a trimmed request',
};

/**
 * A session's trims in the order they happened: for each call, the turn that first went out without its full
 * output, what the call ran, and the probabilities Jev gave that the call and its output still mattered.
 */
export function renderTrims(
  session: string,
  lines: readonly LedgerLine[],
  options: { width?: number; color?: boolean } = {},
): string {
  const width = Math.max(40, Math.min(options.width ?? process.stdout.columns ?? 80, 120));
  const p = paint(options.color);
  const trims = lines.filter(line => line.event === undefined);
  const resets = lines.length - trims.length;
  const out = [
    `${p.bold('◆ Jev Runway trims')}${p.dim(`  session ${clean(session)}`)}`,
    p.dim(
      `  ${trims.length} ${trims.length === 1 ? 'call' : 'calls'} trimmed${resets ? ` · started over ${resets} ${resets === 1 ? 'time' : 'times'}` : ''}`,
    ),
  ];
  if (!lines.length) out.push('', '  Nothing trimmed in this session yet.');
  for (const line of lines) {
    const when = typeof line.at === 'string' ? line.at.slice(11, 19) : '';
    const turn = `turn ${exact(line.turn)}`;
    if (line.event === 'reset') {
      out.push(
        '',
        `  ${p.accent(turn)} ${p.dim(when)}  ${p.warn('started over')}: ${clean(REASONS[String(line.reason)] ?? line.reason)}`,
      );
      continue;
    }
    const need = object(line.need);
    const input = clean(line.input);
    const head = `  ${p.accent(turn)} ${p.dim(when)}  ${line.action === 'remove' ? 'removed' : 'trimmed'}  ${p.bold(clean(line.tool))}  `;
    const room = Math.max(10, width - visible(head));
    out.push(
      '',
      head +
        (Array.from(input).length > room
          ? `${Array.from(input)
              .slice(0, room - 1)
              .join('')}…`
          : input),
    );
    out.push(
      `    ${exact(line.outputChars)} chars of output · Jev: output still needed ${percent(number(need.output) ?? 0)}, call ${percent(number(need.call) ?? 0)}` +
        p.dim(` (threshold ${percent(number(line.threshold) ?? 0.5)})`),
    );
    if (typeof line.saved === 'string') out.push(p.dim(`    full output: ${home(clean(line.saved))}`));
  }
  return out.join('\n');
}

/** The sessions with a trim ledger, most recent first. */
export function renderTrimSessions(
  sessions: readonly { id: string; modified: Date; trims: number }[],
  options: { color?: boolean } = {},
): string {
  const p = paint(options.color);
  if (!sessions.length) return `${p.bold('◆ Jev Runway trims')}\n\n  No trims recorded yet.`;
  return [
    p.bold('◆ Jev Runway trims'),
    '',
    p.dim(`  ${'SESSION'.padEnd(18)}${'LAST WRITTEN'.padEnd(18)}TRIMS`),
    ...sessions.map(
      s => `  ${s.id.padEnd(18)}${s.modified.toISOString().slice(0, 16).replace('T', ' ').padEnd(18)}${exact(s.trims)}`,
    ),
    '',
    p.dim('  Show one: jev-runway trims --session ID  (the ID above, or a Codex session ID)'),
  ].join('\n');
}

export function renderHelp(p: Paint = paint()): string {
  const command = (name: string, text: string, flags: [string, string][] = []) => [
    `  ${p.bold(name.padEnd(13))}${text}`,
    ...flags.map(([flag, help]) => `  ${' '.repeat(13)}${p.dim(`${flag.padEnd(21)}${help}`)}`),
  ];
  return [
    `${p.bold('◆ Jev Runway')}  ${p.dim('Fewer tokens. More runway.')}`,
    'Trims tool output Codex no longer needs before each request goes to your provider.',
    '',
    `${p.bold('Usage')}  jev-runway <command> [options]`,
    '',
    p.accent(p.bold('SET UP')),
    ...command('install', 'Install or update the background service and route Codex through it', [
      ['--upstream URL', 'send requests to this provider or proxy'],
      ['--debug, --no-debug', 'write a metadata-only log'],
    ]),
    ...command('update', 'Install the newest published version, if there is one', [
      ['--debug, --no-debug', 'as for install'],
    ]),
    ...command('uninstall', "Stop the service, restore Codex's previous connection, and remove Runway"),
    ...command('start', 'Run in the foreground instead, until Ctrl-C', [
      ['--upstream URL', 'as for install'],
      ['--debug, --no-debug', 'as for install'],
    ]),
    '',
    p.accent(p.bold('WATCH')),
    ...command('status', 'Show savings, quality signals, and health', [
      ['--details', 'every counter behind the summary'],
      ['--watch', 'refresh every 2 seconds'],
      ['--json', 'machine-readable output'],
      ['--session ID', 'one Codex session only'],
    ]),
    ...command('trims', 'Show which tool outputs were trimmed, when, and on what evidence', [
      ['--session ID', 'one session, oldest trim first'],
      ['--json', 'the ledger lines as JSON'],
    ]),
    '',
    p.accent(p.bold('JEV KEY')),
    ...command('auth set', 'Choose Vercel AI Gateway or TypeSafe and save a verified key'),
    ...command('auth check', 'Verify the key with a test request'),
    ...command('auth status', 'Show which key is used, without a network call'),
    ...command('auth reset', 'Remove the saved key'),
    '',
    p.dim('Start with: npx jev-runway install, then jev-runway status · jev-runway --version'),
  ].join('\n');
}
