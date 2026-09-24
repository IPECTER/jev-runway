#!/usr/bin/env bun
// The jev-runway command: install, update, and remove the background service, show its status, and manage the Jev key.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { confirm, intro, isCancel, log, outro, spinner } from '@clack/prompts';
import {
  checkConfiguredCredentials,
  clearCredentials,
  configureCredentials,
  credentialStatus,
  setupCredentials,
} from './auth.js';
import {
  appServerBatchWrite,
  codexConfigPath,
  inspectCodexConfig,
  installUpstream,
  proxyEdits,
  proxyProvider,
  restoreEdits,
  type Snapshot,
  STATE_PATH,
  saveState,
  selectedConfig,
  state,
  usesAppliedProxy,
} from './codex-config.js';
import { serve } from './codex-proxy.js';
import { codexHome, loadCodexEnvironment } from './config.js';
import {
  installDebug,
  LAUNCHER,
  ownsLauncher,
  RUNTIME_BINARY,
  RUNTIME_DIR,
  recoverInstalledService,
  replaceRuntime,
  type ServiceManager,
  serviceManager,
  version,
  writeAtomic,
  writeLauncher,
} from './service.js';
import { colorEnabled, isTerminal, paint, renderHelp, renderStatus } from './terminal.js';
import { update } from './update.js';

export function upstreamArgument(args: string[]): string | undefined {
  if (!args.length) return undefined;
  if (args.length !== 2 || args[0] !== '--upstream' || !args[1] || args[1].startsWith('--'))
    throw new Error('Usage: jev-runway <start|install> [--upstream URL]');
  return args[1];
}

export function debugArguments(args: string[]): { args: string[]; debug?: boolean } {
  const rest: string[] = [];
  let debug: boolean | undefined;
  for (const arg of args) {
    if (arg === '--debug' || arg === '--no-debug') {
      if (debug !== undefined) throw new Error('Choose --debug or --no-debug once.');
      debug = arg === '--debug';
    } else rest.push(arg);
  }
  upstreamArgument(rest);
  return { args: rest, debug };
}

export function statusArguments(args: string[]): { json: boolean; details: boolean; watch: boolean; session?: string } {
  const options = { json: false, details: false, watch: false, session: undefined as string | undefined };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--json' && !options.json) {
      options.json = true;
      continue;
    }
    if (flag === '--details' && !options.details) {
      options.details = true;
      continue;
    }
    if (flag === '--watch' && !options.watch) {
      options.watch = true;
      continue;
    }
    if (
      flag === '--session' &&
      options.session === undefined &&
      args[index + 1] &&
      !args[index + 1]!.startsWith('--')
    ) {
      options.session = args[++index];
      continue;
    }
    throw new Error('Usage: jev-runway status [--details] [--watch] [--json] [--session SESSION_ID]');
  }
  return options;
}

function proxyUrl(): string {
  return `http://127.0.0.1:${process.env.JEV_RUNWAY_PORT ?? '8788'}`;
}

async function ownProxy(): Promise<boolean> {
  try {
    const response = await fetch(`${proxyUrl()}/_jev/status`, { signal: AbortSignal.timeout(1_500) });
    return response.ok && ((await response.json()) as { service?: string }).service === 'jev-runway';
  } catch {
    return false;
  }
}

async function proxyMetrics(session?: string): Promise<Record<string, unknown> | undefined> {
  try {
    const query = session ? `?session=${encodeURIComponent(session)}` : '';
    const response = await fetch(`${proxyUrl()}/_jev/status${query}`, { signal: AbortSignal.timeout(1_500) });
    if (response.status === 404 && session) return {};
    if (!response.ok) return undefined;
    const value = await response.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function rollbackAndStop(
  before: Snapshot,
  applied: Record<string, unknown>,
  service: ServiceManager,
  reason: string,
  cleanup: () => void,
): Promise<never> {
  try {
    await appServerBatchWrite(restoreEdits(before, selectedConfig(), applied));
  } catch (error) {
    throw new Error(
      `${reason}; rollback failed and proxy remains running: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (usesAppliedProxy(selectedConfig())) {
    throw new Error(`${reason}; rollback left Codex routed to proxy, so proxy remains running.`);
  }
  service.stop();
  cleanup();
  throw new Error(reason);
}

async function statusValue(session?: string) {
  const configPath = codexConfigPath();
  const config = existsSync(configPath) ? inspectCodexConfig(readFileSync(configPath, 'utf8')) : { usesProxy: false };
  const saved = state();
  const metrics = await proxyMetrics(session);
  const noData = Boolean(session && metrics && Object.keys(metrics).length === 0);
  return {
    proxy: metrics ? 'ok' : 'down',
    upstream: saved?.configPath === configPath ? saved.upstream : 'not-configured',
    codexUsesProxy: config.usesProxy,
    credentials: credentialStatus(),
    metrics,
    session,
    noData,
  };
}

export async function status(options: ReturnType<typeof statusArguments>): Promise<void> {
  const text = async () => {
    const value = await statusValue(options.session);
    return options.json || !isTerminal() ? JSON.stringify(value) : renderStatus(value, { details: options.details });
  };
  if (!options.watch) {
    process.stdout.write(`${await text()}\n`);
    return;
  }
  if (options.json || !isTerminal()) throw new Error('--watch needs a terminal and cannot be combined with --json.');
  // The alternate screen keeps the scrollback as it was once watching stops.
  const leave = () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    process.exit(0);
  };
  process.once('SIGINT', leave);
  process.once('SIGTERM', leave);
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  for (;;) {
    const rendered = await text();
    process.stdout.write(`\x1b[H\x1b[2J${rendered}\n${paint().dim('Refreshing every 2 seconds · Ctrl-C to stop')}`);
    await Bun.sleep(2_000);
  }
}

export async function start(args: string[]): Promise<void> {
  const options = debugArguments(args);
  if (options.debug !== undefined) process.env.JEV_RUNWAY_DEBUG = options.debug ? '1' : '0';
  args = options.args;
  await setupCredentials();
  const upstream = await installUpstream(upstreamArgument(args));
  if (await ownProxy())
    throw new Error(
      `Jev Runway is already running on ${proxyUrl()}. See it with jev-runway status, or stop the background service with jev-runway uninstall.`,
    );
  const p = paint(colorEnabled(process.stderr));
  process.stderr.write(
    `${p.bold('◆ Jev Runway')} in the foreground\n  Upstream  ${upstream}\n  ${p.dim(`Point Codex at ${proxyUrl()}/v1 · Ctrl-C to stop`)}\n`,
  );
  serve(upstream);
}

export async function install(args: string[]): Promise<void> {
  const options = debugArguments(args);
  args = options.args;
  const service = serviceManager();
  const path = service.path;
  const logFile = join(codexHome(), 'log', 'jev-runway.log');
  const previousService = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (previousService && !service.owns(previousService))
    throw new Error(`Refusing to replace unrelated service file: ${path}`);
  const before = selectedConfig();
  const saved = state();
  const previousState = existsSync(STATE_PATH) ? readFileSync(STATE_PATH, 'utf8') : undefined;
  if (saved && saved.configPath !== codexConfigPath())
    throw new Error('Install snapshot belongs to another CODEX_HOME. Uninstall from that profile first.');
  const p = paint();
  intro(p.bold(saved ? 'Updating Jev Runway' : 'Installing Jev Runway'));
  const key = await setupCredentials();
  log.step(`Jev key  ${key.provider === 'gateway' ? 'Vercel AI Gateway' : 'TypeSafe'} ${p.dim(`· ${key.source}`)}`);
  const upstream = await installUpstream(upstreamArgument(args));
  log.step(`Upstream  ${upstream}`);
  const applied = proxyProvider();
  if (!saved && usesAppliedProxy(before))
    throw new Error(
      'Codex already uses Jev Runway without an install snapshot. Restore its prior provider before installing.',
    );
  mkdirSync(dirname(logFile), { recursive: true });
  const progress = steps();
  progress.start(saved ? 'Updating the background service' : 'Starting the background service');
  const runtime = replaceRuntime();
  const stop = () => service.stop();
  const restoreFiles = () => {
    runtime.rollback();
    if (previousService === undefined) rmSync(path, { force: true });
    else writeAtomic(path, previousService);
    if (previousState === undefined || !previousService) rmSync(STATE_PATH, { force: true });
    else writeAtomic(STATE_PATH, previousState, 0o600);
  };
  const startService = async (): Promise<boolean> => {
    if (!service.start()) return false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await ownProxy()) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  };
  try {
    writeAtomic(
      path,
      service.render(RUNTIME_BINARY, logFile, upstream, codexHome(), installDebug(options.debug, previousService)),
    );
    stop();
    if (!(await startService())) throw new Error('Background service did not become healthy.');
    progress.message('Routing Codex through Runway');
    saveState(saved?.before ?? before, upstream, applied);
    await appServerBatchWrite(proxyEdits(applied));
  } catch (error) {
    progress.error(saved ? 'Update failed' : 'Install failed');
    const reason = error instanceof Error ? error.message : String(error);
    if (saved && previousService) {
      try {
        await recoverInstalledService({
          stop,
          restoreFiles,
          restart: startService,
          restoreConfig: async original => {
            await appServerBatchWrite(restoreEdits(original ? saved.before : before, selectedConfig(), applied));
            if (original && usesAppliedProxy(selectedConfig()))
              throw new Error('Could not restore the original connection; Codex still points to the proxy.');
          },
        });
      } catch (recoveryError) {
        throw new Error(`${reason} ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
      }
      throw new Error(`${reason} The previous installation was restored.`);
    }
    await rollbackAndStop(saved?.before ?? before, applied, service, reason, restoreFiles);
  }
  runtime.commit();
  progress.stop(`Running on ${proxyUrl()}; Codex now sends requests through it`);
  if (writeLauncher() === 'taken')
    log.warn(`${LAUNCHER} belongs to something else, so it was left alone. Run Runway with: ${RUNTIME_BINARY}`);
  else if (!(process.env.PATH ?? '').split(':').includes(dirname(LAUNCHER)))
    log.info(`Add ${dirname(LAUNCHER)} to your PATH to run ${p.bold('jev-runway')} from anywhere.`);
  outro(
    `${saved ? `Updated to ${version()}` : 'Installed'}. Start a new Codex task, then check savings with ${p.bold('jev-runway status')}.`,
  );
}

export async function uninstall(): Promise<void> {
  const service = serviceManager();
  const saved = state();
  if (saved && saved.configPath !== codexConfigPath()) {
    throw new Error('Install snapshot belongs to another CODEX_HOME. Uninstall from that profile first.');
  }
  intro(paint().bold('Uninstalling Jev Runway'));
  if (saved) {
    const progress = steps();
    progress.start("Restoring Codex's previous connection");
    await appServerBatchWrite(restoreEdits(saved.before, selectedConfig(), saved.provider));
    if (usesAppliedProxy(selectedConfig())) {
      progress.error('Codex still points at Runway');
      throw new Error('Codex remains routed to Jev Runway; service remains running.');
    }
    rmSync(STATE_PATH, { force: true });
    progress.stop('Codex restored to its previous connection');
  } else if (
    inspectCodexConfig(existsSync(codexConfigPath()) ? readFileSync(codexConfigPath(), 'utf8') : '').usesProxy
  ) {
    throw new Error('Codex uses this proxy but no matching install snapshot exists. Restore its prior provider first.');
  }
  if (existsSync(service.path)) {
    service.remove();
    log.step('Background service stopped and removed');
  }
  if (existsSync(LAUNCHER) && ownsLauncher(readFileSync(LAUNCHER, 'utf8'))) rmSync(LAUNCHER, { force: true });
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  outro('Uninstalled. Your saved Jev key stays; remove it with jev-runway auth reset.');
}

/** A spinner in a terminal; elsewhere, such as a log or a pipe, one line per step instead of animation frames. */
function steps(): Pick<ReturnType<typeof spinner>, 'start' | 'message' | 'stop' | 'error'> {
  if (isTerminal()) return spinner();
  return {
    start: text => log.step(text ?? ''),
    message: text => log.step(text ?? ''),
    stop: text => log.success(text ?? ''),
    error: text => log.error(text ?? ''),
  };
}

const PROVIDER_NAMES = { gateway: 'Vercel AI Gateway', typesafe: 'TypeSafe' } as const;

const SOURCES = { saved: 'saved by jev-runway auth set', environment: 'environment variable', none: 'none' } as const;

async function auth(args: string[]): Promise<void> {
  const command = args[0];
  const p = paint();
  if (command === 'status' || command === 'check') {
    if (args.length > 2 || (args[1] !== undefined && args[1] !== '--json'))
      throw new Error('Usage: jev-runway auth <status|check> [--json]');
    const json = args[1] === '--json' || !isTerminal();
    const progress = json || command !== 'check' ? undefined : spinner({ withGuide: false });
    progress?.start('Sending a test request to Jev');
    const result = command === 'check' ? await checkConfiguredCredentials() : credentialStatus();
    progress?.clear();
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      const lines = [p.bold('◆ Jev key')];
      if (result.configured)
        lines.push(
          `  ${'Service'.padEnd(9)}${result.provider ? PROVIDER_NAMES[result.provider] : 'unknown'}`,
          `  ${'Source'.padEnd(9)}${SOURCES[result.source]}`,
        );
      if ('valid' in result)
        lines.push(
          result.valid
            ? `  ${p.good('✓')} Jev answered a test request.`
            : result.configured
              ? `  ${p.bad('✖')} Jev did not answer a test request. Check the key, the service it belongs to, and the network.`
              : `  ${p.warn('!')} No key. Run ${p.bold('jev-runway auth set')}.`,
        );
      else
        lines.push(
          result.configured
            ? `  ${p.dim('Verify it with jev-runway auth check.')}`
            : `  ${p.warn('!')} No key. Run ${p.bold('jev-runway auth set')}.`,
        );
      process.stdout.write(`${lines.join('\n')}\n`);
    }
    if ('valid' in result && !result.valid) process.exitCode = 1;
    return;
  }
  if (command === 'set' && args.length === 1) {
    intro(p.bold('Jev key'));
    await configureCredentials();
    outro('Saved. Runway uses it from the next evaluation.');
    return;
  }
  if (command === 'reset' && (args.length === 1 || (args.length === 2 && args[1] === '--yes'))) {
    if (args[1] !== '--yes') {
      if (!isTerminal()) throw new Error('Usage: jev-runway auth reset --yes');
      const sure = await confirm({ message: 'Remove the saved Jev key?', initialValue: false });
      if (isCancel(sure) || !sure) {
        process.stdout.write('Kept the saved key.\n');
        return;
      }
    }
    clearCredentials();
    process.stdout.write(`${p.good('✓')} Saved key removed. A key in the environment still applies.\n`);
    return;
  }
  throw new Error('Usage: jev-runway auth <set|check|status|reset> (see jev-runway --help)');
}

function usage(): void {
  process.stdout.write(`${renderHelp()}\n`);
}

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    usage();
    return;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    process.stdout.write(`${version()}\n`);
    return;
  }
  switch (args[0]) {
    case 'start':
      await start(args.slice(1));
      return;
    case 'status':
      await status(statusArguments(args.slice(1)));
      return;
    case 'install':
      await install(args.slice(1));
      return;
    case 'update':
      debugArguments(args.slice(1));
      await update(args.slice(1));
      return;
    // What the background service runs.
    case 'serve':
      serve();
      return;
    case 'uninstall':
      await uninstall();
      return;
    case 'auth':
      await auth(args.slice(1));
      return;
    default:
      usage();
      process.exitCode = args[0] ? 1 : 0;
  }
}

if (import.meta.main) {
  loadCodexEnvironment();
  void main().catch(error => {
    process.stderr.write(
      `${paint(colorEnabled(process.stderr)).bad('✖')} ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
