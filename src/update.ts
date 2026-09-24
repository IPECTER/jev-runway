// Self-update from npm: this machine's release binary, checked against the registry's integrity hash.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from './service.js';
import { paint } from './terminal.js';

/** npm's registry, or the one npm is configured to use. */
const REGISTRY = (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/$/, '');

/** The npm package holding the release binary for this machine. */
export function platformPackage(os: string = process.platform, cpu: string = process.arch): string {
  if (!['darwin', 'linux'].includes(os) || !['arm64', 'x64'].includes(cpu))
    throw new Error(`There is no Jev Runway release for ${os}-${cpu}; run it from a source checkout instead.`);
  return `jev-runway-${os}-${cpu}`;
}

/** Whether `data` matches npm's `integrity` field, a list of `algorithm-base64digest` entries. */
export function matchesIntegrity(data: Uint8Array, integrity: string): boolean {
  const sha512 = integrity.split(/\s+/).find(entry => entry.startsWith('sha512-'));
  return sha512 !== undefined && sha512 === `sha512-${createHash('sha512').update(data).digest('base64')}`;
}

async function registryJson(path: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${REGISTRY}/${path}`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error(`Could not reach the npm registry at ${REGISTRY}.`);
  }
  if (response.status === 404) throw new Error(`${path.split('/')[0]} is not published on ${REGISTRY}.`);
  if (!response.ok) throw new Error(`The npm registry answered HTTP ${response.status}.`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Installs the newest release when it is newer than this one: downloads this machine's binary package from
 * npm, checks it against the registry's integrity hash, and lets the new binary install itself.
 */
export async function update(args: string[]): Promise<void> {
  const latest = (await registryJson('jev-runway/latest')).version;
  if (typeof latest !== 'string') throw new Error('The npm registry did not say which version is newest.');
  if (latest === version() && !args.length) {
    process.stdout.write(`${paint().good('✓')} Jev Runway ${latest} is the newest version.\n`);
    return;
  }
  const release = await registryJson(`${platformPackage()}/${latest}`);
  const dist = (release.dist ?? {}) as { tarball?: unknown; integrity?: unknown };
  if (typeof dist.tarball !== 'string' || typeof dist.integrity !== 'string')
    throw new Error('The npm registry did not give a download for this release.');
  process.stdout.write(`Updating Jev Runway ${version()} → ${latest}\n`);
  const download = await fetch(dist.tarball, { signal: AbortSignal.timeout(300_000) });
  const archive = new Uint8Array(await download.arrayBuffer());
  if (!download.ok || !matchesIntegrity(archive, dist.integrity))
    throw new Error('The downloaded release did not match its integrity hash, so it was not installed.');
  const dir = mkdtempSync(join(tmpdir(), 'jev-runway-update-'));
  try {
    writeFileSync(join(dir, 'release.tgz'), archive);
    if (spawnSync('tar', ['-xzf', join(dir, 'release.tgz'), '-C', dir]).status !== 0)
      throw new Error('Could not unpack the downloaded release.');
    const binary = join(dir, 'package', 'bin', 'jev-runway');
    chmodSync(binary, 0o755);
    const child = spawnSync(binary, ['install', ...args], { stdio: 'inherit' });
    if (child.status !== 0)
      throw new Error(
        `The update did not finish (exit ${child.status ?? 'signal'}). The installed version keeps running.`,
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
