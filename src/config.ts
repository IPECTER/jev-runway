import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// The launchd service gets only its upstream, debug flag, and CODEX_HOME from the plist; every other
// setting reaches it through this list or not at all. JEV_RUNWAY_PORT stays out on purpose: moving the
// listener from config.toml would leave Codex's base_url pointing at the old port.
const NAMES = [
  'AI_GATEWAY_API_KEY',
  'TYPESAFE_API_KEY',
  'JEV_RUNWAY_MODEL',
  'JEV_RUNWAY_DEBUG',
  'JEV_RUNWAY_WEBSOCKET',
] as const;

export function codexHome(environment = process.env): string {
  const value = environment.CODEX_HOME || join(homedir(), '.codex');
  if (!isAbsolute(value)) throw new Error('CODEX_HOME must be an absolute path');
  return resolve(value);
}

export function loadCodexEnvironment(environment = process.env): void {
  const config = join(codexHome(environment), 'config.toml');
  if (!existsSync(config)) return;
  const document = Bun.TOML.parse(readFileSync(config, 'utf8')) as {
    shell_environment_policy?: { set?: Record<string, unknown> };
    model_providers?: Record<string, Record<string, unknown>>;
  };
  const configured = document.shell_environment_policy?.set ?? {};
  const providers = document.model_providers as Record<string, Record<string, unknown>> | undefined;
  const provider = providers?.jev_runway;
  const dynamic = [
    provider?.env_key,
    ...Object.values((provider?.env_http_headers as Record<string, unknown>) ?? {}),
  ].filter((value): value is string => typeof value === 'string');
  for (const name of [...NAMES, ...dynamic])
    if (environment[name] === undefined && configured[name] !== undefined) environment[name] = String(configured[name]);
}
