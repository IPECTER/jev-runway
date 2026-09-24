// Codex's connection: reading config.toml, pointing Codex at Runway and back through the app server, and the upstream.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { codexHome } from './config.js';
import { writeAtomic } from './service.js';

const PROXY_URL = 'http://127.0.0.1:8788';

export const STATE_PATH = join(homedir(), '.local', 'state', 'jev-runway', 'codex-config.json');

const PROVIDER = {
  name: 'Jev Runway',
  base_url: `${PROXY_URL}/v1`,
  requires_openai_auth: true,
  supports_websockets: false,
};

const APPLIED = { model_provider: 'jev_runway', openai_base_url: `${PROXY_URL}/v1`, provider: PROVIDER };

export interface CodexConnection {
  usesProxy: boolean;
}

export type Snapshot = { model_provider?: unknown; openai_base_url?: unknown; provider?: unknown };

type SavedState = { configPath: string; before: Snapshot; upstream: string; provider: Record<string, unknown> };

type ConfigEdit = { keyPath: string; mergeStrategy: 'replace'; value: unknown | null };

export function inspectCodexConfig(config: string): CodexConnection {
  const document = Bun.TOML.parse(config) as { model_provider?: unknown; openai_base_url?: unknown };
  return {
    usesProxy:
      document.model_provider === APPLIED.model_provider || document.openai_base_url === APPLIED.openai_base_url,
  };
}

export function codexConfigPath(): string {
  return join(codexHome(), 'config.toml');
}

export function selectedConfig(): Snapshot {
  if (!existsSync(codexConfigPath())) return {};
  const parsed = Bun.TOML.parse(readFileSync(codexConfigPath(), 'utf8')) as Record<string, unknown>;
  const providers = parsed.model_providers as Record<string, unknown> | undefined;
  return {
    model_provider: parsed.model_provider,
    openai_base_url: parsed.openai_base_url,
    provider: providers?.jev_runway,
  };
}

export function state(): SavedState | undefined {
  return existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as SavedState) : undefined;
}

export function saveState(before: Snapshot, upstream: string, provider: Record<string, unknown>): void {
  writeAtomic(STATE_PATH, JSON.stringify({ configPath: codexConfigPath(), before, upstream, provider }), 0o600);
}

export function usesAppliedProxy(config: Snapshot): boolean {
  return config.model_provider === APPLIED.model_provider || config.openai_base_url === APPLIED.openai_base_url;
}

export function proxyEdits(provider: Record<string, unknown> = PROVIDER): ConfigEdit[] {
  return [
    { keyPath: 'model_providers.jev_runway', mergeStrategy: 'replace', value: provider },
    { keyPath: 'model_provider', mergeStrategy: 'replace', value: APPLIED.model_provider },
    { keyPath: 'openai_base_url', mergeStrategy: 'replace', value: APPLIED.openai_base_url },
  ];
}

export function proxyProvider(source?: Record<string, unknown>): Record<string, unknown> {
  if (!source && !existsSync(codexConfigPath())) return PROVIDER;
  if (!source) {
    const config = Bun.TOML.parse(readFileSync(codexConfigPath(), 'utf8')) as Record<string, unknown>;
    const selected = typeof config.model_provider === 'string' ? config.model_provider : undefined;
    const providers = config.model_providers as Record<string, Record<string, unknown>> | undefined;
    source = selected ? providers?.[selected] : undefined;
  }
  if (source?.aws !== undefined)
    throw new Error('AWS SigV4 providers are unsupported because signing binds the upstream host and path.');
  return source
    ? { ...source, name: PROVIDER.name, base_url: PROVIDER.base_url, supports_websockets: false }
    : PROVIDER;
}

export function restoreEdits(
  before: Snapshot,
  current: Snapshot,
  applied: Record<string, unknown> = PROVIDER,
): ConfigEdit[] {
  const edits: ConfigEdit[] = [];
  if (current.model_provider === APPLIED.model_provider)
    edits.push({ keyPath: 'model_provider', mergeStrategy: 'replace', value: before.model_provider ?? null });
  if (current.openai_base_url === APPLIED.openai_base_url)
    edits.push({ keyPath: 'openai_base_url', mergeStrategy: 'replace', value: before.openai_base_url ?? null });
  const provider = current.provider as Record<string, unknown> | undefined;
  if (isDeepStrictEqual(provider, applied))
    edits.push({ keyPath: 'model_providers.jev_runway', mergeStrategy: 'replace', value: before.provider ?? null });
  return edits;
}

export async function codexRequest(method: string, params: unknown): Promise<unknown> {
  // On Windows, npm installs Codex as `codex.cmd`, which only a shell resolves.
  const child = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  type Pending = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const pending = new Map<number, Pending>();
  let buffer = '';
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', code => fail(new Error(`Codex app-server exited (${code ?? 'signal'})`)));
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== 'object') continue;
      const message = value as { id?: unknown; result?: unknown; error?: { message?: unknown } };
      if (typeof message.id !== 'number') continue;
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error)
        request.reject(
          new Error(typeof message.error.message === 'string' ? message.error.message : 'Codex app-server error'),
        );
      else request.resolve(message.result);
    }
  });
  const call = (id: number, name: string, value: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`Codex app-server timed out during ${name}`));
      }, 10_000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, method: name, params: value })}\n`);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  try {
    await call(1, 'initialize', { clientInfo: { name: 'jev-runway', version: '0.6.0' }, capabilities: {} });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    return await call(2, method, params);
  } finally {
    fail(new Error('Codex app-server closed'));
    child.kill();
  }
}

export async function appServerBatchWrite(edits: ConfigEdit[]): Promise<void> {
  if (edits.length)
    await codexRequest('config/batchWrite', { edits, expectedVersion: null, filePath: null, reloadUserConfig: false });
}

async function accountAuthMode(): Promise<string | undefined> {
  const result = (await codexRequest('account/read', { refreshToken: false })) as {
    account?: { authMode?: unknown; type?: unknown };
    authMode?: unknown;
    type?: unknown;
  };
  const mode = result.account?.authMode ?? result.account?.type ?? result.authMode ?? result.type;
  return typeof mode === 'string' ? mode : undefined;
}

export function upstreamForAuthMode(authMode: string | undefined): string | undefined {
  if (authMode === 'chatgpt') return 'https://chatgpt.com/backend-api/codex';
  if (authMode === 'apikey' || authMode === 'apiKey') return 'https://api.openai.com/v1';
  return undefined;
}

export function validUpstream(value: string): string {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  )
    throw new Error('Upstream must be HTTPS or loopback HTTP, without credentials, query, or fragment.');
  return url.toString().replace(/\/$/, '');
}

function configuredUpstream(): string | undefined {
  if (!existsSync(codexConfigPath())) return undefined;
  const config = Bun.TOML.parse(readFileSync(codexConfigPath(), 'utf8')) as Record<string, unknown>;
  const provider = typeof config.model_provider === 'string' ? config.model_provider : undefined;
  const providers = config.model_providers as Record<string, { base_url?: unknown }> | undefined;
  const candidate = provider ? (providers?.[provider]?.base_url ?? config.openai_base_url) : config.openai_base_url;
  if (typeof candidate !== 'string' || isProxyUrl(candidate)) return undefined;
  return validUpstream(candidate);
}

function isProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const proxy = new URL(PROXY_URL);
    return url.hostname === proxy.hostname && url.port === proxy.port;
  } catch {
    return false;
  }
}

export async function installUpstream(direct: string | undefined): Promise<string> {
  if (direct) return validUpstream(direct);
  const saved = state();
  if (saved?.configPath === codexConfigPath() && selectedConfig().model_provider === APPLIED.model_provider)
    return saved.upstream;
  const configured = configuredUpstream();
  if (configured) return configured;
  const authMode = await accountAuthMode();
  const fallback = upstreamForAuthMode(authMode);
  if (fallback) return fallback;
  throw new Error('Cannot infer current provider upstream. Use `--upstream URL`.');
}
