import { describe, expect, it } from 'bun:test';
import type { JevAsker, JevQuestions } from '../src/jev.js';
import {
  applyView,
  callFingerprints,
  type EvaluationOptions,
  evaluateView,
  isCodexCompaction,
} from '../src/responses.js';

/** One evaluation, then the next request of the same session: the same history with the new view applied. */
async function compactResponses(payload: Record<string, unknown>, asker: JevAsker, options: EvaluationOptions = {}) {
  const evaluation = await evaluateView(payload, asker, new Map(), options);
  const applied = applyView(payload, evaluation.view, options);
  return {
    ...applied,
    view: evaluation.view,
    reason: evaluation.reason === 'evaluated' ? applied.reason : evaluation.reason,
    jevRequests: evaluation.jevRequests,
  };
}

const asker = (keepCall: number, keepResult: number): JevAsker => ({
  async ask(_state, questions: JevQuestions) {
    return {
      answers: Object.fromEntries(
        Object.keys(questions).map(id => [
          id,
          {
            type: 'noul',
            noul: id.startsWith('call_') ? keepCall : keepResult,
          },
        ]),
      ),
    };
  },
});
function fixture() {
  return {
    model: 'test-model',
    stream: true,
    instructions: 'Never change these instructions.',
    input: [
      { role: 'system', content: 'System instruction' },
      { type: 'function_call', call_id: 'old', name: 'read', arguments: '{"path":"old.log"}' },
      { type: 'function_call_output', call_id: 'old', output: 'obsolete log data '.repeat(3_000) },
      { type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: [] },
      { role: 'developer', content: [{ type: 'input_text', text: 'Developer instruction' }] },
      { role: 'user', content: 'Current question' },
      { type: 'function_call', call_id: 'recent', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'recent', output: 'essential result' },
      { role: 'assistant', content: 'Working on the current question' },
    ],
  };
}

describe('Responses compaction', () => {
  it('removes an old call/result pair while preserving instructions, recent input, and opaque fields', async () => {
    const body = fixture();
    const original = JSON.stringify(body);
    const result = await compactResponses(body, asker(0, 0));
    expect(result.changed).toBe(true);
    expect(result.payload).toEqual({ ...body, input: [body.input[0], ...body.input.slice(3)] });
    expect(result.estimatedTokensRemoved).toBeGreaterThan(0);
    expect(result.jevRequests).toBe(1);
    expect(JSON.stringify(body)).toBe(original);
  });

  it('leaves standing instructions out of the evaluator state, takes the goal from the task, and keeps input indexes', async () => {
    const body = fixture();
    body.input.splice(5, 0, { role: 'user', content: '<environment_context>cwd</environment_context>' });
    let state: { goal?: string } = {};
    const result = await compactResponses(body, {
      async ask(value, questions) {
        state = value as typeof state;
        return asker(0, 0).ask(value, questions);
      },
    });
    const text = JSON.stringify(state);
    for (const standing of [body.instructions, 'System instruction', 'Developer instruction'])
      expect(text).not.toContain(standing);
    // Codex's tagged context stays in the history, but is not the task.
    expect(state.goal).toBe('Current question');
    expect(result.payload.input).toEqual([body.input[0], ...body.input.slice(3)]);
  });

  it("takes a subagent's goal from the task its parent sent", async () => {
    let goal: string | undefined;
    const task = {
      type: 'agent_message',
      author: 'root',
      content: [
        { type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/parser\nPayload:\nFix the parser.' },
      ],
    };
    const body = {
      input: [
        task,
        ...fixture().input.slice(1, 3),
        ...Array.from({ length: 6 }, () => ({ role: 'assistant', content: 'Working.' })),
      ],
    };
    await compactResponses(body, {
      async ask(value, questions) {
        goal = (value as { goal: string }).goal;
        return asker(1, 1).ask(value, questions);
      },
    });
    expect(goal).toContain('Fix the parser.');
  });

  it('shortens a result without breaking its call or losing output metadata', async () => {
    const body = fixture();
    Object.assign(body.input[2]!, { id: 'output-id' });
    const result = await compactResponses(body, asker(1, 0));
    const input = result.payload.input as Record<string, unknown>[];
    expect(input[1]).toBe(body.input[1]);
    expect(input[2]).toMatchObject({ call_id: 'old', id: 'output-id' });
    expect(String(input[2]!.output).length).toBeLessThan(1_000);
  });

  it('supports custom tool pairs and preserves multimodal results and pending calls', async () => {
    const body = fixture();
    Object.assign(body.input[1]!, { type: 'custom_tool_call', namespace: 'functions', input: 'read old log' });
    body.input[2]!.type = 'custom_tool_call_output';
    const multimodal = {
      type: 'function_call_output',
      call_id: 'recent',
      output: [{ type: 'input_image', image_url: 'data:opaque' }],
    };
    const pending = { type: 'function_call', call_id: 'pending', name: 'read', arguments: '{}' };
    const payload = { ...body, input: [...body.input.slice(0, 7), multimodal, pending] };
    const result = await compactResponses(payload, asker(0, 0));
    expect(result.changed).toBe(true);
    expect(result.payload.input).toContain(multimodal);
    expect(result.payload.input).toContain(pending);
  });

  it('compacts a large input_text output array while preserving its wire shape and metadata', async () => {
    const body = fixture();
    Object.assign(body.input[1]!, { type: 'custom_tool_call', input: 'read old log' });
    const parts = [
      { type: 'input_text', text: 'a'.repeat(20_000), annotation: { source: 'first' } },
      { type: 'input_text', text: 'b'.repeat(20_000), annotation: { source: 'second' } },
    ];
    Object.assign(body.input[2]!, { type: 'custom_tool_call_output', output: parts, id: 'array-output' });
    const original = JSON.stringify(body);
    let calls = 0;
    const result = await compactResponses(
      body,
      {
        async ask(state, questions) {
          calls++;
          return asker(1, 0).ask(state, questions);
        },
      },
      { stateTokens: Number.POSITIVE_INFINITY, requestTokens: Number.POSITIVE_INFINITY },
    );

    expect(calls).toBe(1);
    expect(result.reason).toBe('compacted');
    expect(result.changed).toBe(true);
    expect(result.estimatedTokensRemoved).toBeGreaterThan(0);
    const output = (result.payload.input as Record<string, unknown>[])[2]!.output as Record<string, unknown>[];
    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({ type: 'input_text', annotation: { source: 'first' } });
    expect(output[1]).toEqual({ type: 'input_text', text: '', annotation: { source: 'second' } });
    expect(String(output[0]!.text)).toContain('[Jev Runway truncated');
    expect(JSON.stringify(body)).toBe(original);
  });

  it('leaves mixed output arrays untouched and does not call the evaluator', async () => {
    const body = fixture();
    Object.assign(body.input[1]!, { type: 'custom_tool_call', input: 'read old log' });
    Object.assign(body.input[2]!, {
      type: 'custom_tool_call_output',
      output: [
        { type: 'input_text', text: 'a'.repeat(40_000) },
        { type: 'input_image', image_url: 'data:opaque' },
      ],
    });
    let called = false;
    const result = await compactResponses(body, {
      async ask() {
        called = true;
        throw new Error('unexpected');
      },
    });
    expect(result.payload).toBe(body);
    expect(result.reason).toBe('below_threshold');
    expect(called).toBe(false);
  });

  it.each([
    { previous_response_id: 'resp_123' },
    { conversation: 'conv_123' },
    { input: [{ type: 'item_reference', id: 'item_123' }] },
    { input: 'plain text' },
  ])('does not rewrite unresolved server state or unsupported input: %j', async extra => {
    const body = { ...fixture(), ...extra };
    let called = false;
    const result = await compactResponses(body, {
      async ask() {
        called = true;
        throw new Error('unexpected');
      },
    });
    expect(result.payload).toBe(body);
    expect(called).toBe(false);
  });

  it('fails open on evaluator errors and malformed probabilities', async () => {
    const body = fixture();
    for (const evaluator of [
      {
        async ask() {
          throw new Error('timeout');
        },
      },
      {
        async ask() {
          return { answers: {} };
        },
      },
    ]) {
      const result = await compactResponses(body, evaluator);
      expect(result.payload).toBe(body);
      expect(result.reason).toBe('jev_failed');
    }
  });

  it('reapplies a view with no Jev call, and re-evaluates kept calls only once new output has arrived', async () => {
    const first = await evaluateView(fixture(), asker(0, 0), new Map());
    expect(first).toMatchObject({ reason: 'evaluated', jevRequests: 1, considered: ['old'] });
    expect([...first.view.keys()]).toEqual(['old']);
    // Codex resends the whole history every turn; the view removes the same call without asking Jev.
    const later = fixture() as { input: Record<string, unknown>[] };
    later.input.push({ role: 'user', content: 'Next question' });
    expect(applyView(later, first.view)).toMatchObject({
      changed: true,
      payload: { input: later.input.filter(item => item.call_id !== 'old') },
    });
    // Nothing new arrived since `old` was considered, so the next evaluation does not ask.
    const unasked = {
      async ask(): Promise<never> {
        throw new Error('should not run');
      },
    };
    expect(await evaluateView(later, unasked, first.view, { seen: new Set(first.considered) })).toMatchObject({
      reason: 'below_threshold',
      jevRequests: 0,
    });
    // New output arrives: Jev sees the history as the model does, without `old`, and decides every call
    // not already removed, `recent` included now that it has aged out of the pinned window.
    later.input.push(
      { type: 'function_call', call_id: 'next', name: 'read', arguments: '{"path":"next.log"}' },
      { type: 'function_call_output', call_id: 'next', output: 'another log '.repeat(4_000) },
      ...Array.from({ length: 6 }, (_, index) => ({ role: 'user', content: `Follow-up ${index}` })),
    );
    let seen = '';
    const next = await evaluateView(
      later,
      {
        async ask(state, questions) {
          seen = JSON.stringify({ state, questions });
          return asker(1, 1).ask(state, questions);
        },
      },
      first.view,
      { seen: new Set(first.considered) },
    );
    expect(next).toMatchObject({ reason: 'evaluated', considered: ['recent', 'next'] });
    expect(seen).toContain('next.log');
    expect(seen).not.toContain('old.log');
    // Jev kept both new calls; the removal decided earlier stands.
    expect([...next.view.keys()]).toEqual(['old']);
  });

  it('keeps the view when Jev fails, and considers the calls so the next evaluation waits for new output', async () => {
    const failing = {
      async ask(): Promise<never> {
        throw new Error('unavailable');
      },
    };
    const fresh = await evaluateView(fixture(), failing, new Map());
    expect(fresh).toMatchObject({ reason: 'jev_failed', jevRequests: 1, considered: ['old'] });
    expect(fresh.view.size).toBe(0);
    const kept = new Map([['old', { call: 0, output: 0 }]]);
    expect(await evaluateView(fixture(), failing, kept)).toMatchObject({
      reason: 'below_threshold',
      jevRequests: 0,
      view: kept,
    });
  });

  it('judges a history too large for the route in parts, each with the first and newest messages', async () => {
    const long = {
      input: [
        { role: 'user', content: 'Refactor the parser.' },
        ...Array.from({ length: 40 }, (_, index) => [
          { type: 'function_call', call_id: `c${index}`, name: 'shell', arguments: `{"cmd":"cat part${index}.ts"}` },
          { type: 'function_call_output', call_id: `c${index}`, output: `part ${index} `.repeat(600) },
        ]).flat(),
        ...Array.from({ length: 6 }, (_, index) => ({ role: 'user', content: `Keep going ${index}` })),
      ],
    };
    // A budget far too small for forty calls, as Vercel's is for a long session.
    const budget = { stateTokens: 500, requestTokens: 900 };
    const states: string[] = [];
    const recording: JevAsker = {
      ask(state, questions) {
        states.push(JSON.stringify(state));
        return asker(0, 0).ask(state, questions);
      },
    };
    const result = await evaluateView(long, recording, new Map(), budget);
    expect(result.reason).toBe('evaluated');
    // Old calls too: cutting to the newest part that fits left the stalest output in place for good.
    expect([...result.view.keys()].sort()).toEqual(Array.from({ length: 40 }, (_, index) => `c${index}`).sort());
    expect(new Set(states).size).toBeGreaterThan(1);
    for (const state of states) {
      expect(state).toContain('Refactor the parser.');
      expect(state).toContain('Keep going 5');
    }
    expect(result.considered).toHaveLength(40);
  });

  it('never splits a call from its output, and keeps the parts judged before Jev failed', async () => {
    const long = {
      input: [
        { role: 'user', content: 'Refactor the parser.' },
        // Parallel calls: both outputs follow both calls, so no part may begin between them.
        ...Array.from({ length: 20 }, (_, index) => [
          { type: 'function_call', call_id: `a${index}`, name: 'shell', arguments: `{"cmd":"cat a${index}.ts"}` },
          { type: 'function_call', call_id: `b${index}`, name: 'shell', arguments: `{"cmd":"cat b${index}.ts"}` },
          { type: 'function_call_output', call_id: `a${index}`, output: `a ${index} `.repeat(600) },
          { type: 'function_call_output', call_id: `b${index}`, output: `b ${index} `.repeat(600) },
        ]).flat(),
        ...Array.from({ length: 6 }, (_, index) => ({ role: 'user', content: `Keep going ${index}` })),
      ],
    };
    // Room for one pair at a time, legibly.
    const budget = { stateTokens: 600, requestTokens: 1_000 };
    // A part cut between a call and its output would leave that pair undecided in both parts.
    const whole = await evaluateView(long, asker(0, 0), new Map(), budget);
    expect(whole.view.size).toBe(40);
    let asked = 0;
    const flaky: JevAsker = {
      ask(state, questions) {
        if (++asked === whole.jevRequests) throw new Error('503');
        return asker(0, 0).ask(state, questions);
      },
    };
    const result = await evaluateView(long, flaky, new Map(), budget);
    expect(result.reason).toBe('jev_failed');
    expect(result.view.size).toBeGreaterThan(0);
    expect(result.view.size).toBeLessThan(40);
  });

  it('recognizes the request Codex sends to compact a conversation itself', () => {
    const compaction = {
      input: [
        ...fixture().input,
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary.',
            },
          ],
        },
      ],
    };
    expect(isCodexCompaction(compaction)).toBe(true);
    expect(isCodexCompaction(fixture())).toBe(false);
  });

  it('tells a history too large to evaluate apart from an evaluator failure', async () => {
    const body = fixture();
    let called = false;
    const result = await compactResponses(
      body,
      {
        async ask() {
          called = true;
          throw new Error('unexpected');
        },
      },
      { stateTokens: 1, requestTokens: 2 },
    );
    expect(called).toBe(false);
    expect(result).toMatchObject({ payload: body, changed: false, reason: 'history_too_large', jevRequests: 0 });
  });

  it('bypasses small requests, duplicate ids, and reversed pairs', async () => {
    const small = fixture();
    small.input[2]!.output = 'small';
    const duplicate = fixture();
    duplicate.input.push(duplicate.input[1]!);
    const reversed = fixture();
    [reversed.input[1], reversed.input[2]] = [reversed.input[2]!, reversed.input[1]!];
    for (const body of [small, duplicate, reversed]) {
      const result = await compactResponses(body, {
        async ask() {
          throw new Error('should not run');
        },
      });
      expect(result.payload).toBe(body);
      expect(result.reason).not.toBe('jev_failed');
    }
  });
});

it('fingerprints a call by tool and input, and lists the file paths its input names', () => {
  const call = (id: string, input: string) => [
    { type: 'custom_tool_call', call_id: id, name: 'exec', input },
    { type: 'custom_tool_call_output', call_id: id, output: 'x' },
  ];
  const script =
    'await tools.exec_command({"cmd":"sed -n \'1,9p\' ./src/a.ts && cat /tmp/b.json; echo r.output README.md"});';
  const [first, second, third] = callFingerprints({
    input: [...call('one', script), ...call('two', script), ...call('three', 'text(r.output)')],
  });
  expect(first!.fingerprint).toBe(second!.fingerprint);
  expect(third!.fingerprint).not.toBe(first!.fingerprint);
  // Paths need a directory, so script property access and bare names are not taken for files.
  expect(first!.paths).toEqual(['src/a.ts', 'tmp/b.json']);
  expect(third!.paths).toEqual([]);
});

it('removes the reasoning that led to a dropped step only when every call it led to is dropped', () => {
  const reasoning = (id: string) => ({ type: 'reasoning', id, encrypted_content: 'opaque '.repeat(500), summary: [] });
  const call = (id: string) => ({ type: 'function_call', call_id: id, name: 'read', arguments: `{"path":"${id}"}` });
  const output = (id: string) => ({ type: 'function_call_output', call_id: id, output: `${id} `.repeat(400) });
  const body = {
    input: [
      { role: 'user', content: 'Fix it.' },
      reasoning('r1'),
      call('a'),
      output('a'),
      // Parallel calls from one thought: it stays while either call does.
      reasoning('r2'),
      call('b'),
      call('c'),
      output('b'),
      output('c'),
      reasoning('r3'),
      reasoning('r4'),
      call('d'),
      output('d'),
      ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'Go on.' })),
    ],
  };
  const drop = { call: 0, output: 0 };
  const view = new Map([
    ['a', drop],
    ['b', drop],
    ['d', drop],
  ]);
  const ids = (payload: Record<string, unknown>) =>
    (payload.input as { id?: string; call_id?: string }[]).map(item => item.id ?? item.call_id).filter(Boolean);
  expect(ids(applyView(body, view).payload)).toEqual(['r2', 'c', 'c']);
});
