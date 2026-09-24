import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  applyStoredCredentials,
  checkConfiguredCredentials,
  clearCredentials,
  configureCredentials,
  credentialStatus,
  loadDaemonCredential,
  loadStoredCredentials,
  saveCredentials,
  setupCredentials,
} from '../src/auth.js';

function path(): string {
  return join(mkdtempSync(join(tmpdir(), 'jev-runway-auth-')), 'credentials.json');
}
const verified = { createAsker: () => ({ ask: async () => ({ answers: { connection: { noul: 1 } } }) }) };

test('stores selected credentials atomically with private permissions', () => {
  const file = path();
  saveCredentials({ provider: 'gateway', apiKey: 'key-one' }, { path: file });
  saveCredentials({ provider: 'typesafe', apiKey: 'key-two' }, { path: file });
  expect(loadStoredCredentials({ path: file })).toEqual({ provider: 'typesafe', apiKey: 'key-two' });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
  expect(readFileSync(file, 'utf8')).not.toContain('key-one');
});

test('selected app provider overrides conflicting inherited key types', () => {
  const file = path();
  const environment: NodeJS.ProcessEnv = {
    TYPESAFE_API_KEY: 'external-typesafe',
    AI_GATEWAY_API_KEY: 'external-gateway',
  };
  saveCredentials({ provider: 'gateway', apiKey: 'app-gateway' }, { path: file });
  expect(applyStoredCredentials({ path: file, environment })).toEqual({
    configured: true,
    provider: 'gateway',
    source: 'saved',
  });
  expect(environment.AI_GATEWAY_API_KEY).toBe('app-gateway');
  expect(loadDaemonCredential({ path: file, environment })).toEqual({
    provider: 'vercel-ai-gateway',
    apiKey: 'app-gateway',
  });
});

test('uses inherited credentials without creating a credential file', () => {
  const file = path();
  expect(credentialStatus({ path: file, environment: { AI_GATEWAY_API_KEY: 'gateway' } })).toEqual({
    configured: true,
    provider: 'gateway',
    source: 'environment',
  });
  clearCredentials({ path: file });
  expect(credentialStatus({ path: file, environment: {} })).toEqual({ configured: false, source: 'none' });
});

test('keeps a saved TypeSafe key TypeSafe and never leaks malformed file content', () => {
  const file = path();
  saveCredentials({ provider: 'typesafe', apiKey: 'vck_not-a-gateway-selection' }, { path: file });
  expect(loadDaemonCredential({ path: file, environment: {} })).toEqual({
    provider: 'typesafe',
    apiKey: 'vck_not-a-gateway-selection',
  });
  writeFileSync(file, '{"apiKey":"do-not-print-this-secret"}');
  try {
    loadStoredCredentials({ path: file });
  } catch (error) {
    expect(String(error)).not.toContain('do-not-print-this-secret');
    return;
  }
  throw new Error('Expected malformed credentials error');
});

test('refuses interactive setup without a terminal', async () => {
  await expect(
    setupCredentials({
      path: path(),
      environment: {},
      input: { isTTY: false } as NodeJS.ReadStream,
      output: { isTTY: false } as NodeJS.WriteStream,
    }),
  ).rejects.toThrow('needs a terminal');
});

function terminal(): { input: NodeJS.ReadStream & PassThrough; output: NodeJS.WriteStream; text: () => string } {
  const input = new PassThrough() as PassThrough & NodeJS.ReadStream & { isRaw: boolean };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = raw => {
    input.isRaw = raw;
    return input;
  };
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  output.isTTY = true;
  let captured = '';
  output.on('data', chunk => {
    captured += chunk;
  });
  return { input, output: output as unknown as NodeJS.WriteStream, text: () => captured };
}
const [DOWN, ENTER, ESC, CTRL_C] = ['\x1b[B', '\r', '\x1b', '\u0003'];
/** Presses keys one at a time, as a person would; a bare Esc needs a pause to read as Esc. */
async function press(input: PassThrough, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    await Bun.sleep(key === ESC ? 80 : 15);
    input.write(key);
  }
  await Bun.sleep(80);
}

test('chooses the service, masks the key, verifies it, and restores the terminal', async () => {
  const file = path();
  const screen = terminal();
  const pending = configureCredentials({ path: file, environment: {}, ...screen, ...verified });
  await press(screen.input, DOWN, ENTER, 'new-secret', ENTER);
  expect(await pending).toEqual({ configured: true, provider: 'typesafe', source: 'saved' });
  expect(loadStoredCredentials({ path: file })).toEqual({ provider: 'typesafe', apiKey: 'new-secret' });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(screen.text()).not.toContain('new-secret');
  expect(screen.text()).toContain('Key verified');
  expect(screen.input.isRaw).toBe(false);
});

test('Ctrl-C or Esc at either prompt cancels and keeps the saved key', async () => {
  const file = path();
  saveCredentials({ provider: 'gateway', apiKey: 'prior-secret' }, { path: file });
  for (const keys of [[CTRL_C], [ESC], [ENTER, CTRL_C], [ENTER, 'half', ESC]]) {
    const screen = terminal();
    const pending = configureCredentials({ path: file, environment: {}, ...screen, ...verified });
    const failure = pending.then(
      () => undefined,
      (error: Error) => error,
    );
    await press(screen.input, ...keys);
    expect((await failure)?.message).toContain('Setup cancelled');
    expect(screen.input.isRaw).toBe(false);
    expect(screen.text()).not.toContain('prior-secret');
  }
  expect(loadStoredCredentials({ path: file })).toEqual({ provider: 'gateway', apiKey: 'prior-secret' });
});

test('a closed input ends setup instead of waiting', async () => {
  const screen = terminal();
  const pending = configureCredentials({ path: path(), environment: {}, ...screen, ...verified });
  const failure = pending.then(
    () => undefined,
    (error: Error) => error,
  );
  await Bun.sleep(15);
  screen.input.end();
  expect((await failure)?.message).toContain('Input closed');
  expect(screen.input.isRaw).toBe(false);
});

test('does not replace saved credentials when validation fails', async () => {
  const file = path();
  saveCredentials({ provider: 'typesafe', apiKey: 'prior-secret' }, { path: file });
  const screen = terminal();
  const pending = configureCredentials({
    path: file,
    environment: {},
    ...screen,
    createAsker: () => ({
      ask: async () => {
        throw new Error('server rejected entered-secret');
      },
    }),
  });
  const failure = pending.then(
    () => undefined,
    (error: Error) => error,
  );
  await press(screen.input, ENTER, 'entered-secret', ENTER);
  expect((await failure)?.message).toContain('Could not verify credentials');
  expect(loadStoredCredentials({ path: file })).toEqual({ provider: 'typesafe', apiKey: 'prior-secret' });
  expect(screen.text()).not.toContain('entered-secret');
  expect(screen.text()).toContain('Jev did not accept the key');
});

test('auth check verifies the same inherited credentials as the proxy without saving them', async () => {
  const result = await checkConfiguredCredentials({
    path: path(),
    environment: { AI_GATEWAY_API_KEY: 'test-only-key' },
    createAsker: credentials => {
      expect(credentials.provider).toBe('gateway');
      expect(credentials.apiKey).toBe('test-only-key');
      return { ask: async () => ({ answers: { connection: { noul: 1 } } }) };
    },
  });
  expect(result).toEqual({ configured: true, provider: 'gateway', source: 'environment', valid: true });
  expect(JSON.stringify(result)).not.toContain('test-only-key');
});

test('auth check reports absent and failed credentials without disclosing errors', async () => {
  expect(await checkConfiguredCredentials({ path: path(), environment: {} })).toEqual({
    configured: false,
    source: 'none',
    valid: false,
  });
  const result = await checkConfiguredCredentials({
    path: path(),
    environment: { TYPESAFE_API_KEY: 'test-only-key' },
    createAsker: () => ({
      ask: async () => {
        throw new Error('test-only-key');
      },
    }),
  });
  expect(result).toMatchObject({ configured: true, valid: false });
  expect(JSON.stringify(result)).not.toContain('test-only-key');
});
