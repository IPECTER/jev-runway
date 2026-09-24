import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debugArguments, statusArguments, upstreamArgument } from '../src/cli.js';
import {
  inspectCodexConfig,
  proxyEdits,
  proxyProvider,
  restoreEdits,
  upstreamForAuthMode,
  validUpstream,
} from '../src/codex-config.js';
import {
  installDebug,
  launchdPlist,
  launcherScript,
  ownsLauncher,
  replaceRuntime,
  systemdUnit,
} from '../src/service.js';
import { matchesIntegrity, platformPackage } from '../src/update.js';

test('inspects proxy routing without exposing any key value', () => {
  expect(
    inspectCodexConfig('model_provider = "jev_runway"\n[shell_environment_policy.set]\nAI_GATEWAY_API_KEY = "secret"'),
  ).toEqual({ usesProxy: true });
  expect(inspectCodexConfig('model_provider = "other_proxy"')).toEqual({ usesProxy: false });
});

test('recognizes proxy URL without parsing unrelated values', () => {
  expect(inspectCodexConfig('openai_base_url = "http://127.0.0.1:8788/v1"\nname = "keep"').usesProxy).toBe(true);
});

test('ignores profile-only proxy settings', () => {
  expect(inspectCodexConfig('model_provider = "other"\n[profiles.keep]\nmodel_provider = "jev_runway"')).toEqual({
    usesProxy: false,
  });
});

test('launchd plist has no credential field', () => {
  const plist = launchdPlist(
    '/Users/me/.local/share/jev-runway/jev-runway',
    '/tmp/proxy.log',
    'http://127.0.0.1:8787/v1',
  );
  expect(plist).toContain(
    '<key>ProgramArguments</key><array><string>/Users/me/.local/share/jev-runway/jev-runway</string><string>serve</string></array>',
  );
  expect(plist).toContain('<key>CODEX_HOME</key>');
  expect(plist).toContain('<key>JEV_RUNWAY_UPSTREAM</key>');
  expect(plist).not.toContain('AI_GATEWAY_API_KEY');
});

test('restores only fields still owned by this install', () => {
  const applied = proxyEdits();
  const before = { model_provider: 'other_proxy', openai_base_url: 'http://127.0.0.1:8787/v1' };
  expect(restoreEdits(before, { model_provider: 'jev_runway', openai_base_url: 'changed-by-user' })).toEqual([
    { keyPath: 'model_provider', mergeStrategy: 'replace', value: 'other_proxy' },
  ]);
  expect(applied).toHaveLength(3);
});

test('clears fields created from an empty prior configuration', () => {
  const current = {
    model_provider: 'jev_runway',
    openai_base_url: 'http://127.0.0.1:8788/v1',
    provider: proxyEdits()[0].value,
  };
  expect(restoreEdits({}, current).map(edit => edit.value)).toEqual([null, null, null]);
});

test('accepts HTTPS or loopback HTTP upstreams only', () => {
  expect(validUpstream('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
  expect(validUpstream('http://127.0.0.1:8787/v1')).toBe('http://127.0.0.1:8787/v1');
  expect(() => validUpstream('http://api.example.com/v1')).toThrow();
  expect(() => validUpstream('https://key@example.com/v1')).toThrow();
});

test('accepts only one explicit upstream option', () => {
  expect(upstreamArgument(['--upstream', 'https://api.example.com/v1'])).toBe('https://api.example.com/v1');
  expect(() => upstreamArgument(['--upstream', '--upstream'])).toThrow();
  expect(() => upstreamArgument(['--upstream', 'https://a/v1', '--upstream', 'https://b/v1'])).toThrow();
});

test('preserves selected provider authentication metadata', () => {
  expect(
    proxyProvider({
      env_key: 'CUSTOM_KEY',
      experimental_bearer_token: true,
      query_params: { tenant: 'x' },
      requires_openai_auth: false,
      wire_api: 'responses',
    }),
  ).toMatchObject({
    env_key: 'CUSTOM_KEY',
    experimental_bearer_token: true,
    query_params: { tenant: 'x' },
    requires_openai_auth: false,
    wire_api: 'responses',
    base_url: 'http://127.0.0.1:8788/v1',
    supports_websockets: false,
  });
});

test('rejects AWS providers that require host-bound signatures', () => {
  expect(() => proxyProvider({ aws: { region: 'us-east-1' } })).toThrow('AWS SigV4');
});

test('maps only known Codex account auth modes to official upstreams', () => {
  expect(upstreamForAuthMode('chatgpt')).toBe('https://chatgpt.com/backend-api/codex');
  expect(upstreamForAuthMode('apiKey')).toBe('https://api.openai.com/v1');
  expect(upstreamForAuthMode(undefined)).toBeUndefined();
});

test('keeps prior runtime when staging copy fails', () => {
  const runtime = join(tmpdir(), `jev-runway-runtime-${crypto.randomUUID()}`);
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'marker'), 'old');
  expect(() => replaceRuntime(runtime, join(runtime, 'missing-source'))).toThrow();
  expect(existsSync(join(runtime, 'marker'))).toBe(true);
  expect(readFileSync(join(runtime, 'marker'), 'utf8')).toBe('old');
});

test('keeps built-in authentication defaults without a provider table', () => {
  expect(proxyProvider()).toMatchObject({ requires_openai_auth: true, base_url: 'http://127.0.0.1:8788/v1' });
});

test('accepts status flags in either order and rejects invalid arguments', () => {
  expect(statusArguments(['--json', '--session', 'thread-1'])).toEqual({
    json: true,
    details: false,
    watch: false,
    session: 'thread-1',
  });
  expect(statusArguments(['--session', 'thread-1', '--details', '--watch'])).toEqual({
    json: false,
    details: true,
    watch: true,
    session: 'thread-1',
  });
  expect(() => statusArguments(['--watch', '--watch'])).toThrow('Usage: jev-runway status');
  expect(() => statusArguments(['--session'])).toThrow('Usage: jev-runway status');
  expect(() => statusArguments(['--json', '--json'])).toThrow('Usage: jev-runway status');
});

test('rejects unknown duplicate and missing session status flags', () => {
  expect(() => statusArguments(['--wat'])).toThrow('Usage: jev-runway status');
  expect(() => statusArguments(['--session', 'one', '--session', 'two'])).toThrow('Usage: jev-runway status');
  expect(() => statusArguments(['--session', '--json'])).toThrow('Usage: jev-runway status');
});

test('status queries an encoded session and keeps no-data distinct from proxy down', async () => {
  const requests: string[] = [];
  const fixture = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname + url.search);
      if (url.searchParams.get('session') === 'missing')
        return Response.json({ error: 'Unknown session' }, { status: 404 });
      return Response.json({
        service: 'jev-runway',
        jevLatencyMs: { count: 1, total: 12, min: 12, max: 12, average: 12 },
      });
    },
  });
  const codexHome = join(tmpdir(), `jev-runway-status-${crypto.randomUUID()}`);
  mkdirSync(codexHome, { recursive: true });
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), 'status', '--json', ...args],
      {
        cwd: join(import.meta.dir, '..'),
        env: { ...process.env, CODEX_HOME: codexHome, JEV_RUNWAY_PORT: String(fixture.port) },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(output) as { proxy: string; noData?: boolean };
  };
  try {
    expect((await run(['--session', 'a/b?'])).proxy).toBe('ok');
    expect(requests).toContain('/_jev/status?session=a%2Fb%3F');
    expect(await run(['--session', 'missing'])).toMatchObject({ proxy: 'ok', noData: true });
    fixture.stop(true);
    expect((await run(['--session', 'missing'])).proxy).toBe('down');
  } finally {
    fixture.stop(true);
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('debug flags validate once and managed service persists only their boolean', () => {
  expect(debugArguments(['--debug', '--upstream', 'https://example.com/v1'])).toEqual({
    args: ['--upstream', 'https://example.com/v1'],
    debug: true,
  });
  expect(debugArguments(['--no-debug'])).toEqual({ args: [], debug: false });
  expect(() => debugArguments(['--debug', '--no-debug'])).toThrow();
  expect(() => debugArguments(['--debug', '--unknown'])).toThrow();
  expect(launchdPlist('/runway', '/log', 'https://example.com', '/codex', true)).toContain(
    '<key>JEV_RUNWAY_DEBUG</key><string>1</string>',
  );
  expect(launchdPlist('/runway', '/log', 'https://example.com', '/codex', false)).toContain(
    '<key>JEV_RUNWAY_DEBUG</key><string>0</string>',
  );
  // Reinstalling keeps the previous debug setting unless a flag overrides it.
  const saved = process.env.JEV_RUNWAY_DEBUG;
  delete process.env.JEV_RUNWAY_DEBUG;
  try {
    expect(installDebug(undefined, launchdPlist('/runway', '/log', 'https://example.com', '/codex', true))).toBe(true);
    expect(installDebug(undefined, launchdPlist('/runway', '/log', 'https://example.com', '/codex', false))).toBe(
      false,
    );
    expect(installDebug(false, launchdPlist('/runway', '/log', 'https://example.com', '/codex', true))).toBe(false);
  } finally {
    if (saved !== undefined) process.env.JEV_RUNWAY_DEBUG = saved;
  }
});

test('writes a systemd user unit that runs the proxy with its environment, escaped for systemd', () => {
  const unit = systemdUnit(
    '/home/me/.local/share/jev-runway/jev-runway',
    '/home/me/.codex/log/jev-runway.log',
    'https://chatgpt.com/backend-api/codex',
    '/home/me/.codex',
    true,
  );
  expect(unit.startsWith('# dev.jev-runway:')).toBe(true);
  expect(unit).toContain('ExecStart="/home/me/.local/share/jev-runway/jev-runway" serve');
  expect(unit).toContain('Environment="JEV_RUNWAY_UPSTREAM=https://chatgpt.com/backend-api/codex"');
  expect(unit).toContain('Environment="CODEX_HOME=/home/me/.codex"');
  expect(unit).toContain('StandardOutput=append:/home/me/.codex/log/jev-runway.log');
  expect(unit).toContain('WantedBy=default.target');
  // `%` is a specifier everywhere, and `$` a variable only in ExecStart.
  const odd = systemdUnit(
    '/opt/my tools/100%/"x"$HOME/jev-runway',
    '/tmp/log',
    'https://a.example/v1',
    '/c/$dir',
    false,
  );
  expect(odd).toContain('ExecStart="/opt/my tools/100%%/\\"x\\"$$HOME/jev-runway" serve');
  expect(odd).toContain('Environment="CODEX_HOME=/c/$dir"');
  expect(() => systemdUnit('/runway\n[Service]', '/log', 'https://a.example/v1', '/c')).toThrow('line break');
  // A reinstall keeps debug logging as the unit had it.
  expect(installDebug(undefined, unit)).toBe(true);
  expect(installDebug(undefined, systemdUnit('/runway', '/log', 'https://a.example/v1', '/c', false))).toBe(false);
});

test('the launcher runs the installed binary by its quoted path, and only our launcher is replaced', () => {
  const script = launcherScript("/home/o'neil/.local/share/jev-runway/jev-runway");
  expect(script).toBe(
    `#!/bin/sh\n# jev-runway launcher: runs the installed Jev Runway\nexec '/home/o'\\''neil/.local/share/jev-runway/jev-runway' "$@"\n`,
  );
  expect(ownsLauncher(script)).toBe(true);
  expect(ownsLauncher('#!/bin/sh\nexec /usr/local/bin/bun "$HOME/.local/share/jev-runway/dist/cli.js" "$@"\n')).toBe(
    true,
  );
  expect(ownsLauncher('#!/bin/sh\nexec some-other-tool "$@"\n')).toBe(false);
});

test('each supported machine has a release package, and others are told to use a checkout', () => {
  expect(platformPackage('darwin', 'arm64')).toBe('jev-runway-darwin-arm64');
  expect(platformPackage('linux', 'x64')).toBe('jev-runway-linux-x64');
  expect(() => platformPackage('win32', 'x64')).toThrow(/no Jev Runway release for win32-x64/);
});

test('a download is accepted only when it matches the sha512 in npm integrity', async () => {
  const { createHash } = await import('node:crypto');
  const data = new TextEncoder().encode('release');
  const good = `sha512-${createHash('sha512').update(data).digest('base64')}`;
  expect(matchesIntegrity(data, good)).toBe(true);
  expect(matchesIntegrity(data, `sha1-abc ${good}`)).toBe(true);
  expect(matchesIntegrity(new TextEncoder().encode('tampered'), good)).toBe(false);
  expect(matchesIntegrity(data, 'sha1-only')).toBe(false);
});
