import { describe, expect, it } from 'bun:test';
import type { JevAsker } from '../src/jev.js';
import { applyView, type EvaluationOptions, evaluateView } from '../src/responses.js';

async function compactResponses(payload: Record<string, unknown>, asker: JevAsker, options: EvaluationOptions = {}) {
  const evaluation = await evaluateView(payload, asker, new Map(), options);
  return applyView(payload, evaluation.view, options);
}

const drop: JevAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map(key => [key, { type: 'noul', noul: 0 }])) };
  },
};

function body(recent = false) {
  const pair = [
    {
      type: 'local_shell_call',
      call_id: 'shell_1',
      status: 'completed',
      action: { type: 'exec', command: ['rg', 'obsolete'], env: { LANG: 'C' }, working_directory: '/tmp' },
    },
    { type: 'function_call_output', call_id: 'shell_1', output: 'obsolete shell output '.repeat(3_000) },
  ];
  return {
    input: recent
      ? [
          { role: 'user', content: 'Old task.' },
          ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'Current task.' })),
          ...pair,
        ]
      : [
          { role: 'user', content: 'Old task.' },
          ...pair,
          ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'Current task.' })),
        ],
  };
}

describe('Codex local shell wire pairs', () => {
  it('drops only complete id/action/function_call_output pair and keeps input immutable', async () => {
    const value = body();
    const original = JSON.stringify(value);
    let state = '';
    const result = await compactResponses(
      value,
      {
        async ask(next, questions) {
          state = JSON.stringify(next);
          return drop.ask(next, questions);
        },
      },
      { minToolChars: 1, recentItems: 0 },
    );
    expect(result.changed).toBe(true);
    expect(result.payload.input).toEqual([value.input[0], ...value.input.slice(3)]);
    expect(JSON.stringify(value)).toBe(original);
    expect(state).toContain('\\"command\\":[\\"rg\\",\\"obsolete\\"]');
  });

  it('keeps recent local shell pair despite evaluator drop decision', async () => {
    const value = body(true);
    const result = await compactResponses(value, drop);
    expect(result.changed).toBe(false);
    expect(result.payload).toBe(value);
  });
});
