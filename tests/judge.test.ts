import { expect, test } from 'bun:test';
import type { JevAsker, JevQuestions } from '../src/jev.js';
import {
  batches,
  buildState,
  type Entry,
  estimateTokens,
  judgeSteps,
  pairSteps,
  questionsFor,
  settings,
  trimmedOutput,
  verdict,
  withVerdicts,
} from '../src/judge.js';

const say = (role: Entry['role'], text: string): Entry => ({ role, text });
const call = (callId: string, name = 'read', input: Record<string, unknown> = { path: `src/${callId}.ts` }): Entry => ({
  role: 'user',
  text: '',
  call: { callId, name, input },
});
const output = (callId: string, text = 'x'.repeat(2_000)): Entry => ({
  role: 'user',
  text: '',
  output: { callId, text },
});
/** A task, `steps` read-and-output pairs, and a closing prompt. */
const history = (steps = 3): Entry[] => [
  say('user', 'Fix the failing test; never touch generated files.'),
  ...Array.from({ length: steps }, (_, i) => [call(`c${i}`), output(`c${i}`)]).flat(),
  say('user', 'go on'),
];
/** Answers every question from `value`, recording what was asked. */
function jev(value: (name: string) => number, asked: { state: string; names: string[] }[] = []): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      asked.push({ state: JSON.stringify(state), names: Object.keys(questions) });
      return { answers: Object.fromEntries(Object.keys(questions).map(name => [name, { noul: value(name) }])) };
    },
  };
}

test('settings fill defaults, ignore values that are not numbers, and refuse a threshold outside 0 to 1', () => {
  expect(settings()).toEqual({
    task: '',
    threshold: 0.5,
    recentItems: 6,
    stateTokens: Infinity,
    requestTokens: Infinity,
    parallel: 4,
    headChars: 300,
  });
  expect(settings({ threshold: NaN, recentItems: 2.7, headChars: -3, parallel: 0, stateTokens: 5000 })).toMatchObject({
    threshold: 0.5,
    recentItems: 2,
    headChars: 0,
    parallel: 1,
    stateTokens: 5000,
  });
  for (const threshold of [-0.1, 1.01]) expect(() => settings({ threshold })).toThrow(/threshold/);
});

test('token estimates count words, digits, and symbols apart, and err high on JSON', () => {
  expect(['', 'hello world', 'internationalization', '12345678'].map(estimateTokens)).toEqual([0, 2, 4, 4]);
  const json = JSON.stringify({ path: '/Users/x/src/a.ts', patch: 'a = 1;', n: 42 });
  expect(estimateTokens(json)).toBeGreaterThanOrEqual(Math.ceil(json.length / 3));
});

test('steps pair calls with outputs; a call still waiting is not a step, and broken pairs are refused', () => {
  const entries = [...history(3), call('waiting')];
  const steps = pairSteps(entries, 3);
  expect(steps.map(step => [step.label, step.callId, step.callAt, step.outputAt, step.fixed])).toEqual([
    ['t1', 'c0', 1, 2, false],
    ['t2', 'c1', 3, 4, false],
    ['t3', 'c2', 5, 6, true],
  ]);
  expect(steps[0]!.outputChars).toBe(2_000);
  expect(() => pairSteps([call('a'), output('a'), call('a')], 0)).toThrow(/twice/);
  expect(() => pairSteps([call('a'), output('a'), output('a')], 0)).toThrow(/two outputs/);
  expect(() => pairSteps([output('a'), call('a')], 0)).toThrow(/before/);
});

test('the state shows the whole history with outputs by size only, and waiting calls as context', () => {
  const entries = [...history(2), call('waiting', 'deploy', { target: 'unique-waiting-marker' })];
  const { state, stage } = buildState(entries, pairSteps(entries, 0), {
    stateTokens: Infinity,
    recentItems: 0,
    task: 'fix it',
  });
  expect(stage).toBe('full');
  expect(state.goal).toBe('fix it');
  expect(JSON.stringify(state)).not.toContain('xxxx');
  expect(state.history.map(line => line.i)).toEqual([0, 1, 3, 5, 6]);
  expect(state.history[1]!.tool_calls).toEqual([
    { id: 't1', tool: 'read', input: '{"path":"src/c0.ts"}', result: '2000 chars (omitted)' },
  ]);
  expect(state.history.at(-1)!.pending_calls).toEqual([
    { tool_use_id: 'waiting', tool: 'deploy', input: '{"target":"unique-waiting-marker"}' },
  ]);
});

test('a state too large is shrunk by cutting inputs, then abridging old texts, and refused past that', () => {
  const wide = [
    say('user', 'start'),
    call('w', 'write', { content: 'y'.repeat(5_000) }),
    output('w', 'ok'),
    say('assistant', 'written'),
  ];
  const cut = buildState(wide, pairSteps(wide, 0), { stateTokens: 320, recentItems: 0, task: '' });
  expect(cut.stage).toBe('inputs<=200');
  expect(cut.state.history[1]!.tool_calls![0]!.input.length).toBeLessThanOrEqual(200);
  const long = (n: number) => `${n} ${'lorem ipsum '.repeat(300)}`;
  const talk = [
    say('user', long(0)),
    say('assistant', long(1)),
    say('user', long(2)),
    say('assistant', long(3)),
    say('user', 'latest'),
  ];
  const abridged = buildState(talk, [], { stateTokens: 1_800, recentItems: 1, task: '' });
  expect(abridged.stage).toBe('texts abridged');
  expect(abridged.tokens).toBeLessThanOrEqual(1_800);
  expect(abridged.state.history[1]!.text).toContain('chars omitted');
  expect(abridged.state.history[0]!.text).toBe(long(0));
  expect(() => buildState(talk, [], { stateTokens: 420, recentItems: 1, task: '' })).toThrow(/does not fit/);
  expect(
    buildState([say('user', 'x'.repeat(100_000))], [], { stateTokens: Infinity, recentItems: 0, task: '' }).stage,
  ).toBe('full');
});

test('questions are grouped to fit beside the state, in order, and refused when one cannot', () => {
  const steps = pairSteps(history(10), 0);
  expect(Object.keys(questionsFor(steps[0]!))).toEqual(['call_t1', 'result_t1']);
  expect(batches(steps, 1_000, 30_000)).toHaveLength(1);
  expect(batches(steps, 1_000, Infinity)).toHaveLength(1);
  const split = batches(steps, 29_600, 30_000);
  expect(split.length).toBeGreaterThan(1);
  expect(split.flat().map(step => step.label)).toEqual(steps.map(step => step.label));
  expect(() => batches(steps, 29_990, 30_000)).toThrow(/No room/);
});

test('verdicts keep a needed output, trim to keep a needed call, and remove the rest; fixed steps stay', () => {
  const open = { callId: 'a', fixed: false };
  expect(verdict(open, { call: 0.9, output: 0.7 }, 0.5).action).toBe('keep');
  expect(verdict(open, { call: 0.9, output: 0.2 }, 0.5).action).toBe('trim');
  expect(verdict(open, { call: 0.1, output: 0.2 }, 0.5).action).toBe('remove');
  expect(verdict({ callId: 'a', fixed: true }, { call: 0, output: 0 }, 0.5).action).toBe('keep');
  expect(() => verdict(open, { call: 1, output: 1 }, 1.1)).toThrow(/threshold/);
  expect(() => verdict(open, { call: 1.2, output: 1 }, 0.5)).toThrow(/probabilities/);
});

test('a trimmed output keeps its head and says what went and where it is saved', () => {
  expect(trimmedOutput('short', 300)).toBe('short');
  expect(trimmedOutput('x'.repeat(1_000), 50)).toBe(
    `${'x'.repeat(50)}\n[Jev Runway truncated 950 chars of this tool result; re-run the tool if needed]`,
  );
  expect(trimmedOutput('x'.repeat(1_000), 0, '/saved/a.txt')).toBe(
    '[Jev Runway truncated 1000 chars of this tool result; the full output is saved in /saved/a.txt]',
  );
});

test('applying verdicts removes or trims steps and leaves everything else, input included, untouched', () => {
  const entries = history(3);
  const before = JSON.stringify(entries);
  const after = withVerdicts(
    entries,
    [
      { callId: 'c0', call: 0, output: 0, action: 'remove' },
      { callId: 'c1', call: 1, output: 0, action: 'trim' },
      { callId: 'c2', call: 1, output: 1, action: 'keep' },
    ],
    300,
  );
  expect(after.map(entry => entry.call?.callId ?? entry.output?.callId ?? entry.text)).toEqual([
    entries[0]!.text,
    'c1',
    'c1',
    'c2',
    'c2',
    'go on',
  ]);
  expect(after[2]!.output!.text).toStartWith(`${'x'.repeat(300)}\n[Jev Runway truncated 1700 chars`);
  expect(after[3]).toBe(entries[5]!);
  expect(JSON.stringify(entries)).toBe(before);
});

test('every group of questions carries the same whole state, and each step is asked about once', async () => {
  const asked: { state: string; names: string[] }[] = [];
  const entries = history(3);
  const { tokens } = buildState(entries, pairSteps(entries, 1), { stateTokens: Infinity, recentItems: 1, task: '' });
  const verdicts = await judgeSteps(
    entries,
    jev(name => (name.startsWith('call_') ? 0.9 : 0.1), asked),
    { recentItems: 1, requestTokens: tokens + 150 },
  );
  expect(asked.length).toBeGreaterThan(1);
  expect(new Set(asked.map(ask => ask.state)).size).toBe(1);
  expect(asked.flatMap(ask => ask.names).sort()).toEqual([
    'call_t1',
    'call_t2',
    'call_t3',
    'result_t1',
    'result_t2',
    'result_t3',
  ]);
  expect(verdicts.map(v => [v.callId, v.action])).toEqual([
    ['c0', 'trim'],
    ['c1', 'trim'],
    ['c2', 'trim'],
  ]);
  expect(
    await judgeSteps(
      [say('user', 'hello'), say('assistant', 'hi')],
      jev(() => 0, asked),
    ),
  ).toEqual([]);
});

test('steps decided earlier keep their verdicts, and Jev sees the history with them applied', async () => {
  const asked: { state: string; names: string[] }[] = [];
  const decided = new Map([['c0', { call: 0, output: 0 }]]);
  const verdicts = await judgeSteps(
    history(3),
    jev(() => 1, asked),
    { recentItems: 1, decided },
  );
  expect(verdicts.map(v => v.action)).toEqual(['remove', 'keep', 'keep']);
  expect(asked[0]!.state).not.toContain('src/c0.ts');
  expect(asked[0]!.names).toEqual(['call_t1', 'result_t1', 'call_t2', 'result_t2']);
});

test('a history that cannot fit fails before asking; a tight budget shrinks the state instead', async () => {
  let asks = 0;
  const counting = jev(() => 1);
  await expect(
    judgeSteps(
      history(1),
      {
        ask: (...args) => {
          asks++;
          return counting.ask(...args);
        },
      },
      { requestTokens: 1, recentItems: 0 },
    ),
  ).rejects.toThrow(/no room/);
  expect(asks).toBe(0);
  const entries = [
    say('user', 'start'),
    call('x'),
    output('x'),
    say('assistant', 'word '.repeat(2_000)),
    say('user', 'finish'),
  ];
  const asked: { state: string; names: string[] }[] = [];
  expect(
    await judgeSteps(
      entries,
      jev(() => 1, asked),
      { requestTokens: 1_000, recentItems: 1, task: 'finish' },
    ),
  ).toHaveLength(1);
  expect(asked[0]!.state).toContain('chars omitted');
});

test('Jev calls run a few at a time, and the first failure stops the rest', async () => {
  const entries = history(12);
  const { tokens } = buildState(entries, pairSteps(entries, 0), { stateTokens: Infinity, recentItems: 0, task: '' });
  // Room for the state and the largest pair of questions, so each group holds about one step.
  const budget = {
    recentItems: 0,
    requestTokens:
      tokens + 20 + Math.max(...pairSteps(entries, 0).map(step => estimateTokens(JSON.stringify(questionsFor(step))))),
  };
  for (const parallel of [2, undefined]) {
    let active = 0,
      peak = 0,
      calls = 0;
    const slow = jev(() => 1);
    await judgeSteps(
      entries,
      {
        async ask(state, questions) {
          calls++;
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(3);
          active--;
          return slow.ask(state, questions);
        },
      },
      { ...budget, parallel },
    );
    expect(calls).toBeGreaterThan(4);
    expect(peak).toBeLessThanOrEqual(parallel ?? 4);
  }
  let calls = 0;
  const before = JSON.stringify(entries);
  await expect(
    judgeSteps(
      entries,
      {
        async ask() {
          calls++;
          throw new Error('provider unavailable');
        },
      },
      { ...budget, parallel: 1 },
    ),
  ).rejects.toThrow('provider unavailable');
  expect(calls).toBe(1);
  expect(JSON.stringify(entries)).toBe(before);
});

test('answers must be probabilities; 0 and 1 are', async () => {
  await expect(
    judgeSteps(history(1), { ask: async () => ({ answers: { call_t1: { noul: 0.5 } } }) }, { recentItems: 1 }),
  ).rejects.toThrow(/result_t1/);
  for (const bad of [-0.1, 1.1])
    await expect(
      judgeSteps(
        history(1),
        jev(() => bad),
        { recentItems: 1 },
      ),
    ).rejects.toThrow(/no usable probability/);
  expect(
    (
      await judgeSteps(
        history(3),
        jev(() => 0),
        { recentItems: 1 },
      )
    ).map(v => v.action),
  ).toEqual(['remove', 'remove', 'remove']);
  expect(
    (
      await judgeSteps(
        history(3),
        jev(() => 1),
        { recentItems: 1 },
      )
    ).map(v => v.action),
  ).toEqual(['keep', 'keep', 'keep']);
});
