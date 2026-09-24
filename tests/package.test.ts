import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { manifests, PLATFORMS } from '../scripts/release.ts';

const root = resolve(import.meta.dir, '..');
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('the source package cannot be published by mistake; the release is built from it', () => {
  expect(source.private).toBe(true);
  expect(existsSync(join(root, 'dist', 'jev-runway'))).toBe(true);
});

test('the release is a launcher package over one binary package per platform, all at one version', () => {
  const { main, platforms } = manifests(source);
  expect(main).toMatchObject({
    name: 'jev-runway',
    version: source.version,
    bin: { 'jev-runway': 'bin/jev-runway.js' },
    files: ['bin/jev-runway.js', 'README.md', 'README.ko.md', 'LICENSE'],
    engines: { node: '>=18' },
  });
  expect(main).not.toHaveProperty('dependencies');
  expect(Object.keys(main.optionalDependencies)).toEqual(PLATFORMS.map(p => `jev-runway-${p.os}-${p.cpu}`));
  expect(new Set(Object.values(main.optionalDependencies))).toEqual(new Set([source.version]));
  for (const { platform, manifest } of platforms) {
    expect(manifest).toMatchObject({
      version: source.version,
      os: [platform.os],
      cpu: [platform.cpu],
      files: ['bin/jev-runway'],
    });
    if (platform.os === 'linux') expect(manifest).toMatchObject({ libc: ['glibc'] });
  }
});

test('the launcher runs the platform binary with Node, passing arguments and the exit code through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-runway-launcher-'));
  temporary.push(dir);
  const main = join(dir, 'node_modules', 'jev-runway');
  const platform = join(dir, 'node_modules', `jev-runway-${process.platform}-${process.arch}`, 'bin');
  mkdirSync(join(main, 'bin'), { recursive: true });
  mkdirSync(platform, { recursive: true });
  cpSync(join(root, 'bin', 'jev-runway.js'), join(main, 'bin', 'jev-runway.js'));
  writeFileSync(join(main, 'package.json'), '{"type":"module"}');
  writeFileSync(join(platform, 'jev-runway'), '#!/bin/sh\necho "ran with $*"\nexit 3\n');
  chmodSync(join(platform, 'jev-runway'), 0o755);
  const run = spawnSync('node', [join(main, 'bin', 'jev-runway.js'), 'status', '--json'], { encoding: 'utf8' });
  expect(run.stdout).toBe('ran with status --json\n');
  expect(run.status).toBe(3);
  rmSync(platform, { recursive: true });
  const missing = spawnSync('node', [join(main, 'bin', 'jev-runway.js')], { encoding: 'utf8' });
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('no release for');
});
