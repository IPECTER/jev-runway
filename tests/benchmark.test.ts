import { expect, test } from 'bun:test';
import { measure, outputPath } from '../scripts/benchmark.ts';
import { runReplayBenchmark } from '../scripts/benchmark-replay.ts';

test('benchmark reports UTF-8 byte savings relative to the same baseline', () => {
  const baseline = measure({ text: '한글' }, undefined, 0, false);
  const reduced = measure({ text: '' }, baseline, 1.234, true);
  expect(baseline.bytes).toBe(17);
  expect(baseline.bytesRemoved).toBe(0);
  expect(reduced.bytes).toBe(11);
  expect(reduced.bytesRemoved).toBe(6);
  expect(reduced.byteReductionPct).toBe(35.29);
  expect(reduced.durationMs).toBe(1.23);
});

test('offline replay uses Runway compaction while retaining the objective facts', async () => {
  const report = await runReplayBenchmark();
  expect(report.mode).toBe('simulated_offline');
  expect(report.runway.changed).toBe(true);
  expect(report.runway.actualInputTokens).toBeNull();
  expect(report.runway.cacheReadInputTokens).toBeNull();
  expect(report.runway.billedCostUsd).toBeNull();
  expect(report.objectivePreservation.every(check => check.preserved)).toBe(true);
  expect(report.estimatedInputTokensRemoved).toBeGreaterThan(0);
});

test('benchmark rejects invalid arguments before making API calls', () => {
  expect(outputPath([])).toBeUndefined();
  expect(outputPath(['--output', 'report.json'])).toBe('report.json');
  for (const args of [['--output'], ['--output', '--help'], ['--unknown'], ['--output', 'a', '--output', 'b']]) {
    expect(() => outputPath(args)).toThrow('Usage:');
  }
});
