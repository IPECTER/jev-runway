#!/usr/bin/env bun
import type { JevAsker, JevQuestions } from '../src/jev.ts';
import { estimateTokens } from '../src/judge.ts';
import { applyView, evaluateView } from '../src/responses.ts';

/** One evaluation, then the request a session would send next with that view applied. */
async function compactOnce(
  payload: Record<string, unknown>,
  asker: JevAsker,
  options: Parameters<typeof evaluateView>[3],
) {
  const evaluation = await evaluateView(payload, asker, new Map(), options);
  const applied = applyView(payload, evaluation.view, options);
  return {
    ...applied,
    reason: evaluation.reason === 'evaluated' ? applied.reason : evaluation.reason,
    jevRequests: evaluation.jevRequests,
  };
}

const objectiveFacts = [
  'Never deploy changes.',
  'Keep region ap-northeast-2.',
  'Do not change the API contract.',
  'migration_id=20260920_add_index',
];

function replayFixture() {
  const stale = 'abandoned deploy log: staging failed; do not reuse this plan.\n'.repeat(900);
  const critical = `${objectiveFacts[3]}\ncurrent production schema uses the existing API contract.\n`.repeat(350);
  return {
    model: 'gpt-5.6-sol',
    instructions: `${objectiveFacts.slice(0, 3).join(' ')} Answer the current task only.`,
    input: [
      { role: 'system', content: 'Synthetic replay. Preserve explicit user constraints.' },
      {
        type: 'function_call',
        call_id: 'stale-log',
        name: 'read_deploy_log',
        arguments: '{"path":"abandoned.log"}',
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'stale-log', output: stale, status: 'completed' },
      {
        type: 'function_call',
        call_id: 'migration',
        name: 'read_migration',
        arguments: '{"id":"20260920_add_index"}',
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'migration', output: critical, status: 'completed' },
      { role: 'assistant', content: 'I will check the migration before answering.' },
      { role: 'user', content: 'Current task: explain the safe migration plan.' },
      { role: 'user', content: `Respond with these exact facts: ${objectiveFacts.join(' ')}` },
    ],
  };
}

function mockEvaluator(): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      const answers: Record<string, { noul: number }> = {};
      for (const key of Object.keys(questions)) {
        // t2 is the migration pair in this fixed fixture; t1 is the stale log.
        answers[key] = { noul: key.endsWith('t2') ? 1 : 0 };
      }
      return { model: 'deterministic-mock', answers };
    },
  };
}

function localMeasure(payload: unknown) {
  const started = performance.now();
  const serialized = JSON.stringify(payload);
  return {
    estimatedInputTokens: estimateTokens(serialized),
    bytes: new TextEncoder().encode(serialized).byteLength,
    localLatencyMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

export async function runReplayBenchmark() {
  const baselinePayload = replayFixture();
  const baseline = localMeasure(baselinePayload);
  const started = performance.now();
  const result = await compactOnce(replayFixture(), mockEvaluator(), {
    minToolChars: 0,
    recentItems: 2,
    parallel: 1,
  });
  const runway = localMeasure(result.payload);
  const serialized = JSON.stringify(result.payload);
  const preserved = objectiveFacts.map(fact => ({ fact, preserved: serialized.includes(fact) }));
  if (!preserved.every(({ preserved }) => preserved)) throw new Error('Replay objective was not preserved');

  return {
    mode: 'simulated_offline',
    disclaimer:
      'Runs the real Runway compaction code with a deterministic mock evaluator. It makes no provider calls and cannot measure billed tokens, cache reads, model quality, or end-to-end latency.',
    fixture:
      'synthetic multi-turn Responses input with an irrelevant old log, a critical old tool result, and recent user constraints',
    baseline: {
      ...baseline,
      actualInputTokens: null,
      cacheReadInputTokens: null,
      billedCostUsd: null,
      endToEndLatencyMs: null,
    },
    runway: {
      ...runway,
      localLatencyMs: Math.round((performance.now() - started) * 100) / 100,
      actualInputTokens: null,
      cacheReadInputTokens: null,
      billedCostUsd: null,
      endToEndLatencyMs: null,
      evaluator: 'deterministic-mock',
      jevRequests: result.jevRequests,
      changed: result.changed,
      reason: result.reason,
    },
    estimatedInputTokensRemoved: baseline.estimatedInputTokens - runway.estimatedInputTokens,
    objectivePreservation: preserved,
    quality: { checked: 'objective facts retained in compacted request', modelResponseQuality: null },
  };
}

type LiveUsage = { inputTokens: number | null; cacheReadInputTokens: number | null };

function responseText(response: Record<string, unknown>) {
  return JSON.stringify(response.output ?? '');
}

function usage(response: Record<string, unknown>): LiveUsage {
  const value = response.usage as Record<string, unknown> | undefined;
  const details = value?.input_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: typeof value?.input_tokens === 'number' ? value.input_tokens : null,
    cacheReadInputTokens: typeof details?.cached_tokens === 'number' ? details.cached_tokens : null,
  };
}

async function callResponses(payload: Record<string, unknown>, apiKey: string, model: string) {
  const started = performance.now();
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, model, stream: false, max_output_tokens: 512 }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Responses request failed: HTTP ${response.status}`);
  return { body, endToEndLatencyMs: Math.round((performance.now() - started) * 100) / 100 };
}

/** Opt-in only: calls the upstream Responses API twice and reports returned usage. */
export async function runLiveReplayBenchmark(
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.JEV_RUNWAY_REPLAY_MODEL,
) {
  if (!apiKey || !model) throw new Error('Set OPENAI_API_KEY and JEV_RUNWAY_REPLAY_MODEL before using --live');
  const baselinePayload = replayFixture();
  const compacted = await compactOnce(replayFixture(), mockEvaluator(), {
    minToolChars: 0,
    recentItems: 2,
    parallel: 1,
  });
  const [baseline, runway] = await Promise.all([
    callResponses(baselinePayload, apiKey, model),
    callResponses(compacted.payload, apiKey, model),
  ]);
  const baselineUsage = usage(baseline.body);
  const runwayUsage = usage(runway.body);
  const baselineText = responseText(baseline.body);
  const runwayText = responseText(runway.body);
  const preserved = objectiveFacts.map(fact => ({
    fact,
    baselinePreserved: baselineText.includes(fact),
    runwayPreserved: runwayText.includes(fact),
  }));
  return {
    mode: 'live_upstream',
    model,
    fixture: 'same synthetic replay fixture as offline mode; only the upstream model calls are live',
    baseline: { ...baselineUsage, billedCostUsd: null, endToEndLatencyMs: baseline.endToEndLatencyMs },
    runway: {
      ...runwayUsage,
      billedCostUsd: null,
      endToEndLatencyMs: runway.endToEndLatencyMs,
      jevRequests: compacted.jevRequests,
    },
    actualInputTokensRemoved:
      baselineUsage.inputTokens === null || runwayUsage.inputTokens === null
        ? null
        : baselineUsage.inputTokens - runwayUsage.inputTokens,
    objectivePreservation: preserved,
    quality: { checked: 'literal objective facts in each upstream response', modelResponseQuality: null },
    limitations:
      'Cost stays null because pricing and billing adjustments are not returned by the API. One synthetic prompt cannot establish production quality or savings.',
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const live = args[0] === '--live';
  const output = args[live ? 1 : 0] === '--output' ? args[live ? 2 : 1] : undefined;
  if (args.length !== (live ? (output ? 3 : 1) : output ? 2 : 0))
    throw new Error('Usage: benchmark:replay [--live] [--output PATH]');
  const report = live ? await runLiveReplayBenchmark() : await runReplayBenchmark();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await Bun.write(output, json);
  process.stdout.write(json);
}
