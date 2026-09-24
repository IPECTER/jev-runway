// The background service and what it runs: the installed binary, its launcher, and the launchd agent or systemd unit.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexHome } from './config.js';

const LABEL = 'dev.jev-runway';

export const RUNTIME_DIR = join(homedir(), '.local', 'share', 'jev-runway');

/** The installed binary: the CLI, the proxy, and Bun in one file, which the service and the launcher run. */
export const RUNTIME_BINARY = join(RUNTIME_DIR, 'jev-runway');

/** The `jev-runway` command `install` puts on PATH, so a run through npx leaves one behind. */
export const LAUNCHER = join(homedir(), '.local', 'bin', 'jev-runway');

/** Set when a release binary is built; a source checkout reads package.json instead. */
declare const RUNWAY_VERSION: string | undefined;

/** Whether this is a release binary, whose code lives inside the executable, rather than a source checkout run by Bun. */
const COMPILED = import.meta.url.includes('$bunfs');

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function packageVersion(root = packageRoot()): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

export function version(): string {
  return typeof RUNWAY_VERSION === 'string' ? RUNWAY_VERSION : (packageVersion() ?? 'unknown');
}

function xml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!,
  );
}

export function launchdPlist(
  binary: string,
  log: string,
  upstream: string,
  configuredCodexHome = codexHome(),
  debug = false,
): string {
  const values = [LABEL, binary, 'serve', log, upstream, configuredCodexHome].map(xml);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${values[0]}</string>\n<key>ProgramArguments</key><array><string>${values[1]}</string><string>${values[2]}</string></array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>JEV_RUNWAY_UPSTREAM</key><string>${values[4]}</string><key>JEV_RUNWAY_DEBUG</key><string>${debug ? '1' : '0'}</string><key>CODEX_HOME</key><string>${values[5]}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>\n<key>StandardOutPath</key><string>${values[3]}</string><key>StandardErrorPath</key><string>${values[3]}</string>\n</dict></plist>\n`;
}

/** Text for a systemd unit: `%` starts a specifier there, and a line break would end the setting. */
function unitText(value: string): string {
  if (/[\n\r]/.test(value)) throw new Error('A service path or URL cannot contain a line break.');
  return value.replace(/%/g, '%%');
}

/** A quoted systemd word; `ExecStart` also expands `$`, so there it is doubled. */
function unitWord(value: string, command = false): string {
  const text = unitText(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${command ? text.replace(/\$/g, '$$$$') : text}"`;
}

/** The systemd user unit that runs the proxy on Linux; the first line marks it as Runway's own. */
export function systemdUnit(
  binary: string,
  log: string,
  upstream: string,
  configuredCodexHome = codexHome(),
  debug = false,
): string {
  const environment = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    JEV_RUNWAY_UPSTREAM: upstream,
    JEV_RUNWAY_DEBUG: debug ? '1' : '0',
    CODEX_HOME: configuredCodexHome,
  };
  return [
    `# ${LABEL}: managed by jev-runway; \`jev-runway uninstall\` removes it.`,
    '[Unit]',
    'Description=Jev Runway',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${unitWord(binary, true)} serve`,
    ...Object.entries(environment).map(([key, value]) => `Environment=${unitWord(`${key}=${value}`)}`),
    'Restart=always',
    'RestartSec=5',
    `StandardOutput=append:${unitText(log)}`,
    `StandardError=append:${unitText(log)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** How the background service is registered: launchd on macOS, a systemd user unit on Linux. */
export interface ServiceManager {
  /** The service definition file. */
  path: string;
  /** Whether an existing file at `path` is Runway's to replace. */
  owns(contents: string): boolean;
  render(binary: string, log: string, upstream: string, configuredCodexHome: string, debug: boolean): string;
  /** Loads the written definition and starts the service; false when the service manager refused. */
  start(): boolean;
  stop(): void;
  /** Stops the service and removes its definition. */
  remove(): void;
}

export function serviceManager(): ServiceManager {
  if (platform() === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('Cannot determine current user for launchd');
    const domain = `gui/${uid}`;
    const stop = () => {
      spawnSync('launchctl', ['bootout', domain, path], { stdio: 'ignore' });
    };
    return {
      path,
      owns: contents => contents.includes(`<string>${LABEL}</string>`),
      render: launchdPlist,
      stop,
      start: () => spawnSync('launchctl', ['bootstrap', domain, path], { stdio: 'inherit' }).status === 0,
      remove: () => {
        stop();
        rmSync(path, { force: true });
      },
    };
  }
  if (platform() === 'linux') {
    const unit = 'jev-runway.service';
    const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', unit);
    const systemctl = (...args: string[]) =>
      spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' }).status === 0;
    return {
      path,
      owns: contents => contents.startsWith(`# ${LABEL}:`),
      render: systemdUnit,
      start: () => systemctl('daemon-reload') && systemctl('enable', unit) && systemctl('restart', unit),
      stop: () => {
        spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' });
      },
      remove: () => {
        spawnSync('systemctl', ['--user', 'disable', '--now', unit], { stdio: 'ignore' });
        rmSync(path, { force: true });
        spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      },
    };
  }
  throw new Error(
    'install and uninstall need macOS or Linux. On this platform, run `jev-runway start` and point Codex at http://127.0.0.1:8788/v1 as the README describes.',
  );
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A launcher that runs the installed binary. */
export function launcherScript(binary: string): string {
  return `#!/bin/sh\n# jev-runway launcher: runs the installed Jev Runway\nexec ${shellQuote(binary)} "$@"\n`;
}

/** Ours when written by install, or a hand-made one that runs the installed runtime. */
export function ownsLauncher(contents: string): boolean {
  return contents.includes('# jev-runway launcher') || contents.includes('.local/share/jev-runway/');
}

/** Writes the launcher unless an unrelated file holds its place. */
export function writeLauncher(): 'written' | 'taken' {
  if (existsSync(LAUNCHER) && !ownsLauncher(readFileSync(LAUNCHER, 'utf8'))) return 'taken';
  writeAtomic(LAUNCHER, launcherScript(RUNTIME_BINARY), 0o755);
  return 'written';
}

/**
 * Puts this version's binary in `dir`: a copy of this one when it is a release binary, wherever npm or an
 * update left it, or one compiled for this machine when running from a source checkout.
 */
function placeBinary(dir: string): void {
  const target = join(dir, 'jev-runway');
  if (COMPILED) {
    cpSync(process.execPath, target);
    chmodSync(target, 0o755);
    return;
  }
  const built = spawnSync(
    process.execPath,
    [
      'build',
      join(packageRoot(), 'src', 'cli.ts'),
      '--compile',
      '--minify',
      '--define',
      `RUNWAY_VERSION=${JSON.stringify(version())}`,
      '--outfile',
      target,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (built.status !== 0) throw new Error('Could not build the Runway binary from this checkout.');
}

export function replaceRuntime(
  runtime = RUNTIME_DIR,
  place: (dir: string) => void = placeBinary,
): { commit(): void; rollback(): void } {
  mkdirSync(dirname(runtime), { recursive: true });
  const staged = mkdtempSync(`${runtime}.next-`);
  const backup = `${runtime}.previous`;
  try {
    place(staged);
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(runtime)) renameSync(runtime, backup);
    try {
      renameSync(staged, runtime);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, runtime);
      throw error;
    }
    return {
      commit: () => rmSync(backup, { recursive: true, force: true }),
      rollback: () => {
        rmSync(runtime, { recursive: true, force: true });
        if (existsSync(backup)) renameSync(backup, runtime);
      },
    };
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The service appends to its log for as long as it runs, and it holds the file open, so the log can
 * only be replaced while the service is stopped: a log past `limit` becomes `<log>.1`.
 */
export function rotateLog(log: string, limit = 10 * 1024 * 1024): void {
  try {
    if (statSync(log).size > limit) renameSync(log, `${log}.1`);
  } catch {
    // No log yet, or it cannot be moved: the service appends to it as before.
  }
}

/** Replaces a file whole, so a crash leaves the old contents or the new, never part of either. */
export function writeAtomic(path: string, contents: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, { mode });
  renameSync(temporary, path);
}

export async function recoverInstalledService(actions: {
  stop(): void;
  restoreFiles(): void;
  restart(): Promise<boolean>;
  restoreConfig(original: boolean): Promise<void>;
}): Promise<void> {
  actions.stop();
  let restored = false;
  try {
    actions.restoreFiles();
    restored = await actions.restart();
  } catch {
    /* Restore a direct connection if the previous runtime cannot start. */
  }
  if (restored) {
    try {
      await actions.restoreConfig(false);
    } catch {
      throw new Error('Previous service is running, but its Codex configuration could not be restored.');
    }
    return;
  }
  await actions.restoreConfig(true);
  actions.stop();
  throw new Error('Previous service could not restart; Codex was restored to its original upstream.');
}

/** Debug stays as the previous install left it unless a flag or JEV_RUNWAY_DEBUG says otherwise. */
export function installDebug(flag: boolean | undefined, previousService: string | undefined): boolean {
  if (flag !== undefined) return flag;
  if (process.env.JEV_RUNWAY_DEBUG !== undefined) return process.env.JEV_RUNWAY_DEBUG === '1';
  return Boolean(
    previousService?.includes('<key>JEV_RUNWAY_DEBUG</key><string>1</string>') ||
      previousService?.includes('JEV_RUNWAY_DEBUG=1'),
  );
}
