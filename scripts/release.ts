#!/usr/bin/env bun
// Builds the npm release into dist/npm: a package per platform holding that platform's binary, and the
// jev-runway package whose launcher runs the one npm installed for the machine. `--publish` publishes them,
// the platform packages first, so the main package never points at a version that is not there yet.
// `--local` builds only this machine's binary, as dist/jev-runway.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PLATFORMS = [
  { os: 'darwin', cpu: 'arm64', target: 'bun-darwin-arm64' },
  { os: 'darwin', cpu: 'x64', target: 'bun-darwin-x64' },
  { os: 'linux', cpu: 'x64', target: 'bun-linux-x64', libc: 'glibc' },
  { os: 'linux', cpu: 'arm64', target: 'bun-linux-arm64', libc: 'glibc' },
] as const;

type Source = {
  version: string;
  description: string;
  license: string;
  author?: string;
  keywords?: string[];
  repository?: { type: string; url: string };
  homepage?: string;
  bugs?: { url: string };
};

/** The package.json of every package in a release, all at the source's version. */
export function manifests(source: Source) {
  const shared = {
    version: source.version,
    license: source.license,
    ...(source.author && { author: source.author }),
    ...(source.repository && { repository: source.repository, homepage: source.homepage, bugs: source.bugs }),
  };
  const platforms = PLATFORMS.map(platform => ({
    platform,
    manifest: {
      name: `jev-runway-${platform.os}-${platform.cpu}`,
      ...shared,
      description: `The Jev Runway binary for ${platform.os}-${platform.cpu}. Install jev-runway instead.`,
      os: [platform.os],
      cpu: [platform.cpu],
      ...('libc' in platform && { libc: [platform.libc] }),
      files: ['bin/jev-runway'],
      preferUnplugged: true,
    },
  }));
  const main = {
    name: 'jev-runway',
    ...shared,
    description: source.description,
    keywords: source.keywords,
    type: 'module',
    bin: { 'jev-runway': 'bin/jev-runway.js' },
    files: ['bin/jev-runway.js', 'README.md', 'README.ko.md', 'LICENSE'],
    engines: { node: '>=18' },
    optionalDependencies: Object.fromEntries(platforms.map(({ manifest }) => [manifest.name, source.version])),
  };
  return { main, platforms };
}

const readSource = (root: string) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Source;

/** Compiles the CLI, the proxy, and Bun into one executable, for `target` or this machine. */
export function compile(root: string, outfile: string, target?: string): void {
  const built = spawnSync(
    process.execPath,
    [
      'build',
      join(root, 'src', 'cli.ts'),
      '--compile',
      '--minify',
      ...(target ? [`--target=${target}`] : []),
      '--define',
      `RUNWAY_VERSION=${JSON.stringify(readSource(root).version)}`,
      '--outfile',
      outfile,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (built.status !== 0) throw new Error(`Building ${outfile} failed`);
  chmodSync(outfile, 0o755);
}

function build(root: string, out: string): string[] {
  const { main, platforms } = manifests(readSource(root));
  rmSync(out, { recursive: true, force: true });
  const dirs: string[] = [];
  for (const { platform, manifest } of platforms) {
    const dir = join(out, manifest.name);
    compile(root, join(dir, 'bin', 'jev-runway'), platform.target);
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    cpSync(join(root, 'LICENSE'), join(dir, 'LICENSE'));
    dirs.push(dir);
  }
  const dir = join(out, main.name);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  cpSync(join(root, 'bin', 'jev-runway.js'), join(dir, 'bin', 'jev-runway.js'));
  for (const file of ['README.md', 'README.ko.md', 'LICENSE']) cpSync(join(root, file), join(dir, file));
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(main, null, 2)}\n`);
  return [...dirs, dir];
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const args = process.argv.slice(2);
  if (args.includes('--local')) {
    compile(root, join(root, 'dist', 'jev-runway'));
    process.exit(0);
  }
  const dirs = build(root, join(root, 'dist', 'npm'));
  process.stdout.write(`Built ${dirs.length} packages in dist/npm.\n`);
  if (args.includes('--publish')) {
    const extra = args.filter(arg => arg !== '--publish');
    for (const dir of dirs) {
      const published = spawnSync('npm', ['publish', dir, ...extra], { stdio: 'inherit' });
      if (published.status !== 0) {
        process.stderr.write(`Publishing ${dir} failed; the packages before it are published.\n`);
        process.exit(1);
      }
    }
  }
}
