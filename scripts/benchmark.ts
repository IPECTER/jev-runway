#!/usr/bin/env bun
import { loadDaemonCredential } from '../src/auth.ts';
import { loadCodexEnvironment } from '../src/config.ts';
import { JEV_BUDGETS, jevCaller, jevRoute } from '../src/jev.ts';
import { estimateTokens } from '../src/judge.ts';
import { applyView, evaluateView } from '../src/responses.ts';

function obsoleteLogFixture() {
  return {
    model: 'gpt-5.6-sol',
    stream: true,
    instructions: 'Answer the arithmetic question. Ignore abandoned deployment logs.',
    input: [
      { role: 'user', content: 'An old deployment was abandoned. Do not use its logs.' },
      {
        type: 'function_call',
        call_id: 'old_log',
        name: 'read_old_build_log',
        arguments: '{"path":"abandoned-build.log"}',
      },
      {
        type: 'function_call_output',
        call_id: 'old_log',
        output: 'Obsolete successful build progress.\n'.repeat(2_000),
      },
      ...Array.from({ length: 6 }, () => ({
        role: 'user',
        content: 'Current task: what is 2 + 2? The old build is irrelevant.',
      })),
    ],
  };
}

function mixedToolHistoryFixture() {
  const currentConfig = Array.from({ length: 700 }, (_, index) =>
    JSON.stringify({
      service: 'synthetic-api',
      region: 'test-east',
      port: 8788,
      healthy: true,
      sequence: index,
      note: 'Keep current port and region.',
    }),
  ).join('\n');
  return {
    model: 'gpt-5.6-sol',
    stream: true,
    instructions: 'Use current configuration evidence. Ignore the retired deployment log.',
    input: [
      { role: 'system', content: 'All data is synthetic benchmark content.' },
      {
        type: 'function_call',
        call_id: 'retired',
        name: 'read_retired_log',
        arguments: '{"path":"retired.log"}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'retired',
        output: 'Retired deployment failed and was discarded.\n'.repeat(1_500),
      },
      {
        type: 'function_call',
        call_id: 'current',
        name: 'read_current_config',
        arguments: '{"path":"current.jsonl"}',
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'current', output: currentConfig },
      ...Array.from({ length: 6 }, () => ({
        role: 'user',
        content: 'Report current synthetic service status and keep its port and region.',
      })),
    ],
  };
}

const fixtures = [
  ['obsolete_log', obsoleteLogFixture()],
  ['mixed_tool_history', mixedToolHistoryFixture()],
] as const;

export async function runRunwayBenchmark() {
  loadCodexEnvironment();
  const credentials = loadDaemonCredential();
  if (!credentials) throw new Error('Configure a Jev key with `jev-runway auth set` before benchmarking.');
  const client = jevCaller({ ...credentials, model: process.env.JEV_RUNWAY_MODEL, timeoutMs: 10_000 });
  const jevResults = [];
  for (const [name, baseline] of fixtures) {
    const started = performance.now();
    // One evaluation, then the request a session would send next with that view applied.
    const evaluation = await evaluateView(baseline, client, new Map(), JEV_BUDGETS[jevRoute(credentials).provider]);
    if (evaluation.reason === 'jev_failed') throw new Error(`Jev evaluation failed for ${name}`);
    const result = applyView(baseline, evaluation.view);
    jevResults.push({
      name,
      baseline,
      payload: result.payload,
      changed: result.changed,
      reason: evaluation.reason === 'evaluated' ? result.reason : evaluation.reason,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      jevRequests: evaluation.jevRequests,
    });
  }

  return {
    results: jevResults,
    jev: { provider: credentials.provider, model: process.env.JEV_RUNWAY_MODEL || 'typesafe-ai/jev' },
  };
}

export function measure(
  payload: unknown,
  baseline: { estimatedTokens: number; bytes: number } | undefined,
  durationMs: number,
  changed: boolean,
  details: Record<string, unknown> = {},
) {
  const serialized = JSON.stringify(payload);
  const estimatedTokens = estimateTokens(serialized);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  const baseTokens = baseline?.estimatedTokens ?? estimatedTokens;
  const baseBytes = baseline?.bytes ?? bytes;
  return {
    estimatedTokens,
    bytes,
    tokensRemoved: baseTokens - estimatedTokens,
    tokenReductionPct: Math.round(((baseTokens - estimatedTokens) / baseTokens) * 10_000) / 100,
    bytesRemoved: baseBytes - bytes,
    byteReductionPct: Math.round(((baseBytes - bytes) / baseBytes) * 10_000) / 100,
    durationMs: Math.round(durationMs * 100) / 100,
    changed,
    ...details,
  };
}

export function outputPath(args: string[]): string | undefined {
  return benchmarkOptions(args).output;
}

export function benchmarkOptions(args: string[]) {
  let live = false;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--live') {
      live = true;
    } else if (args[index] === '--output' && args[index + 1] && !args[index + 1].startsWith('--') && !output) {
      output = args[++index];
    } else {
      throw new Error('Usage: benchmark --live [--output PATH]');
    }
  }
  return { live, output };
}

export function requireLiveBenchmark(options: { live: boolean }) {
  if (!options.live) throw new Error('Refusing to call Jev. Pass --live to run this benchmark.');
}

export async function writeReport(report: unknown, path?: string) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (path) await Bun.write(path, json);
  process.stdout.write(json);
}

export const measurement =
  'Serialized JSON token estimates and bytes, not billed usage, response quality, or net-cost savings. Calls Jev, not the main model; no upstream HTTP forwarding.';

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: bun run benchmark -- --live [--output PATH]\nRunway-only synthetic benchmark. --live permits Jev API calls.',
    );
  } else {
    const options = benchmarkOptions(args);
    requireLiveBenchmark(options);
    const { results, jev } = await runRunwayBenchmark();
    await writeReport(
      {
        generatedAt: new Date().toISOString(),
        fixtureSource: 'Synthetic fixtures; no local files or conversations.',
        fixtureModel: 'gpt-5.6-sol',
        measurement,
        jev,
        fixtures: results.map(result => {
          const baseline = measure(result.baseline, undefined, 0, false);
          return {
            name: result.name,
            baseline,
            conditions: {
              runway: measure(result.payload, baseline, result.durationMs, result.changed, {
                reason: result.reason,
                jevRequests: result.jevRequests,
              }),
            },
          };
        }),
      },
      options.output,
    );
  }
}
