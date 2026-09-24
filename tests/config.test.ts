import { expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCodexEnvironment } from '../src/config.js';

// Set by the launchd plist or by the CLI, never by Codex's environment policy.
const SERVICE_OWNED = new Set(['JEV_RUNWAY_UPSTREAM', 'JEV_RUNWAY_PORT']);

function codexHomeWith(settings: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'jev-runway-config-'));
  writeFileSync(
    join(home, 'config.toml'),
    '[shell_environment_policy.set]\n' +
      Object.entries(settings)
        .map(([name, value]) => `${name} = "${value}"`)
        .join('\n') +
      '\n',
  );
  return home;
}

it('lets every setting the proxy reads come from the Codex environment policy', () => {
  // The managed service receives no other environment, so a setting read at runtime but missing from
  // the allowlist is documented as configurable yet impossible to set.
  const src = join(import.meta.dir, '..', 'src');
  const source = readdirSync(src)
    .filter(name => name.endsWith('.ts'))
    .map(name => readFileSync(join(src, name), 'utf8'))
    .join('\n');
  const names = [...new Set(source.match(/JEV_RUNWAY_[A-Z_]+/g))].filter(name => !SERVICE_OWNED.has(name));
  expect(names).toContain('JEV_RUNWAY_MODEL');
  const home = codexHomeWith(Object.fromEntries(names.map(name => [name, '1'])));
  try {
    const environment: NodeJS.ProcessEnv = { CODEX_HOME: home };
    loadCodexEnvironment(environment);
    expect(names.filter(name => environment[name] !== '1')).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it('keeps the port and any value the process already has', () => {
  const home = codexHomeWith({ JEV_RUNWAY_PORT: '9999', JEV_RUNWAY_MODEL: 'jev-from-policy' });
  try {
    const environment: NodeJS.ProcessEnv = { CODEX_HOME: home, JEV_RUNWAY_MODEL: 'jev-from-environment' };
    loadCodexEnvironment(environment);
    // A port from config.toml would move the listener without moving Codex's base_url.
    expect(environment.JEV_RUNWAY_PORT).toBeUndefined();
    expect(environment.JEV_RUNWAY_MODEL).toBe('jev-from-environment');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
