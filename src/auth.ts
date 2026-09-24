import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isCancel, password, select, spinner } from '@clack/prompts';
import { type JevAsker, jevCaller, probability } from './jev.js';

export type CredentialProvider = 'gateway' | 'typesafe';
export interface Credentials {
  provider: CredentialProvider;
  apiKey: string;
}
export type CredentialSource = 'saved' | 'environment' | 'none';
export interface CredentialStatus {
  configured: boolean;
  provider?: CredentialProvider;
  source: CredentialSource;
}
export interface AuthOptions {
  path?: string;
  environment?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Test seam for the same `ask` contract used by JevClient. */
  createAsker?: (credentials: Credentials) => Pick<JevAsker, 'ask'>;
}

export function credentialPath(home = homedir()): string {
  return join(home, '.config', 'jev-runway', 'credentials.json');
}

function pathOf(options: AuthOptions): string {
  return options.path ?? credentialPath();
}
function validProvider(value: unknown): value is CredentialProvider {
  return value === 'gateway' || value === 'typesafe';
}
function validCredentials(value: unknown): value is Credentials {
  return (
    !!value &&
    typeof value === 'object' &&
    validProvider((value as Credentials).provider) &&
    typeof (value as Credentials).apiKey === 'string' &&
    (value as Credentials).apiKey.trim().length > 0
  );
}
function check(credentials: Credentials): Credentials {
  if (!validCredentials(credentials))
    throw new Error('Provider must be gateway or typesafe, and API key must not be empty.');
  return { provider: credentials.provider, apiKey: credentials.apiKey };
}

export function loadStoredCredentials(options: AuthOptions = {}): Credentials | undefined {
  const path = pathOf(options);
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Invalid credentials file: ${path}`);
  }
  if (!validCredentials(value)) throw new Error(`Invalid credentials file: ${path}`);
  return value;
}

export function saveCredentials(credentials: Credentials, options: AuthOptions = {}): void {
  const path = pathOf(options);
  const parent = dirname(path);
  const value = check(credentials);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function clearCredentials(options: AuthOptions = {}): void {
  const path = pathOf(options);
  if (existsSync(path)) unlinkSync(path);
}

function environmentCredentials(environment: NodeJS.ProcessEnv): Credentials | undefined {
  if (environment.TYPESAFE_API_KEY) return { provider: 'typesafe', apiKey: environment.TYPESAFE_API_KEY };
  if (environment.AI_GATEWAY_API_KEY) return { provider: 'gateway', apiKey: environment.AI_GATEWAY_API_KEY };
  return undefined;
}

/** Applies selected app credentials through internal process-only variables. */
export function resolveCredentials(
  options: AuthOptions = {},
): (Credentials & { source: Exclude<CredentialSource, 'none'> }) | undefined {
  const environment = options.environment ?? process.env;
  const credentials = loadStoredCredentials(options);
  if (credentials) return { ...credentials, source: 'saved' };
  const fallback = environmentCredentials(environment);
  return fallback && { ...fallback, source: 'environment' };
}

/** Noninteractive credentials for the proxy's explicit JevClient options. */
export function loadDaemonCredential(
  options: AuthOptions = {},
): { provider: 'typesafe' | 'vercel-ai-gateway'; apiKey: string } | undefined {
  const credentials = resolveCredentials(options);
  if (!credentials) return undefined;
  return {
    provider: credentials.provider === 'gateway' ? 'vercel-ai-gateway' : 'typesafe',
    apiKey: credentials.apiKey,
  };
}

/** Sets only current process's selected provider variable; daemons load the file directly. */
export function applyStoredCredentials(options: AuthOptions = {}): CredentialStatus {
  const environment = options.environment ?? process.env;
  const credentials = resolveCredentials(options);
  if (!credentials) return { configured: false, source: 'none' };
  if (credentials.source === 'saved') {
    if (credentials.provider === 'gateway') environment.AI_GATEWAY_API_KEY = credentials.apiKey;
    else environment.TYPESAFE_API_KEY = credentials.apiKey;
  }
  return { configured: true, provider: credentials.provider, source: credentials.source };
}

export function credentialStatus(options: AuthOptions = {}): CredentialStatus {
  return applyStoredCredentials(options);
}

function streams(options: AuthOptions): [NodeJS.ReadStream, NodeJS.WriteStream] {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY)
    throw new Error('Interactive setup needs a terminal. Run `jev-runway auth set` in a terminal.');
  return [input, output];
}

export async function promptCredentials(options: AuthOptions = {}): Promise<Credentials> {
  const [input, output] = streams(options);
  // A closed input would leave the prompt waiting for keys that never come.
  const closed = new AbortController();
  const onClosed = (): void => closed.abort();
  input.once('end', onClosed);
  input.once('close', onClosed);
  const stopped = (): never => {
    throw new Error(closed.signal.aborted ? 'Input closed before setup completed.' : 'Setup cancelled.');
  };
  try {
    const common = { input, output, signal: closed.signal };
    const provider = await select<CredentialProvider>({
      message: 'Which service is your Jev key from?',
      options: [
        { value: 'gateway', label: 'Vercel AI Gateway', hint: 'keys start with vck_' },
        { value: 'typesafe', label: 'TypeSafe' },
      ],
      ...common,
    });
    if (isCancel(provider)) stopped();
    const apiKey = await password({
      message: 'Paste the key (hidden)',
      validate: value => (value?.trim() ? undefined : 'Paste the key, or press Esc to cancel.'),
      ...common,
    });
    if (isCancel(apiKey)) stopped();
    return check({ provider: provider as CredentialProvider, apiKey: apiKey as string });
  } finally {
    input.removeListener('end', onClosed);
    input.removeListener('close', onClosed);
  }
}

/** Makes one synthetic Jev request and validates its normal answer schema. */
export async function validateCredentials(credentials: Credentials, options: AuthOptions = {}): Promise<void> {
  const checked = check(credentials);
  const asker =
    options.createAsker?.(checked) ??
    jevCaller({
      provider: checked.provider === 'gateway' ? 'vercel-ai-gateway' : 'typesafe',
      apiKey: checked.apiKey,
    });
  try {
    const response = await asker.ask(
      { purpose: 'Jev Runway credential verification' },
      { connection: { type: 'noul', instructions: 'Return whether this credential can evaluate this request.' } },
    );
    probability(response.answers, 'connection');
  } catch {
    throw new Error('Could not verify credentials. Check provider, API key, and network connection.');
  }
}

/** Interactive credential change is atomic: prompt, verify, then persist and apply. */
export async function configureCredentials(options: AuthOptions = {}): Promise<CredentialStatus> {
  const credentials = await promptCredentials(options);
  const progress = spinner({ output: options.output ?? process.stdout });
  progress.start('Checking the key with a test request to Jev');
  try {
    await validateCredentials(credentials, options);
  } catch (error) {
    progress.error('Jev did not accept the key');
    throw error;
  }
  progress.stop('Key verified');
  saveCredentials(credentials, options);
  return applyStoredCredentials(options);
}

/** Prompts only when neither stored nor inherited credentials exist. */
export async function setupCredentials(options: AuthOptions = {}): Promise<CredentialStatus> {
  const current = credentialStatus(options);
  if (current.configured) return current;
  return configureCredentials(options);
}

/** Verifies the same saved-or-inherited credential selected by the proxy. */
export async function checkConfiguredCredentials(
  options: AuthOptions = {},
): Promise<CredentialStatus & { valid: boolean }> {
  const credentials = resolveCredentials(options);
  if (!credentials) return { configured: false, source: 'none', valid: false };
  const status = { configured: true, provider: credentials.provider, source: credentials.source };
  try {
    await validateCredentials(credentials, options);
    return { ...status, valid: true };
  } catch {
    return { ...status, valid: false };
  }
}
