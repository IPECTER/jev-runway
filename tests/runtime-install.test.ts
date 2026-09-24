import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverInstalledService, replaceRuntime, rotateLog } from '../src/service.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function installation() {
  const root = mkdtempSync(join(tmpdir(), 'jev-runway-install-'));
  temporaryDirectories.push(root);
  const runtime = join(root, 'runtime');
  const state = join(root, 'state', 'codex-config.json');
  mkdirSync(runtime);
  mkdirSync(join(root, 'state'));
  writeFileSync(join(runtime, 'previous-marker'), 'previous runtime');
  writeFileSync(state, '{"before":{"model_provider":"original"}}');
  // Stands in for copying or compiling the new binary into the staged runtime.
  const place = (dir: string) => writeFileSync(join(dir, 'jev-runway'), 'new binary');
  return { runtime, place, state, previousState: readFileSync(state, 'utf8') };
}

test('failed installation can restore its previous runtime without losing external state', () => {
  const fixture = installation();
  const change = replaceRuntime(fixture.runtime, fixture.place);
  expect(existsSync(join(fixture.runtime, 'jev-runway'))).toBe(true);
  expect(existsSync(`${fixture.runtime}.previous`)).toBe(true);
  change.rollback();
  expect(readFileSync(join(fixture.runtime, 'previous-marker'), 'utf8')).toBe('previous runtime');
  expect(existsSync(join(fixture.runtime, 'jev-runway'))).toBe(false);
  expect(existsSync(`${fixture.runtime}.previous`)).toBe(false);
  expect(readFileSync(fixture.state, 'utf8')).toBe(fixture.previousState);
});

test('successful installation keeps its new runtime and removes only the old backup', () => {
  const fixture = installation();
  const change = replaceRuntime(fixture.runtime, fixture.place);
  change.commit();
  expect(readFileSync(join(fixture.runtime, 'jev-runway'), 'utf8')).toBe('new binary');
  expect(existsSync(join(fixture.runtime, 'previous-marker'))).toBe(false);
  expect(existsSync(`${fixture.runtime}.previous`)).toBe(false);
  expect(readFileSync(fixture.state, 'utf8')).toBe(fixture.previousState);
});

test('failed update restores old runtime before restarting and restores the immediately prior connection', async () => {
  const fixture = installation();
  const change = replaceRuntime(fixture.runtime, fixture.place);
  let running = true;
  let connection = 'new-proxy-settings';
  writeFileSync(fixture.state, 'new state');
  await recoverInstalledService({
    stop: () => {
      running = false;
    },
    restoreFiles: () => {
      change.rollback();
      writeFileSync(fixture.state, fixture.previousState);
    },
    restart: async () => {
      expect(readFileSync(join(fixture.runtime, 'previous-marker'), 'utf8')).toBe('previous runtime');
      running = true;
      return true;
    },
    restoreConfig: async original => {
      expect(running).toBe(true);
      connection = original ? 'original-upstream' : 'previous-proxy-settings';
    },
  });
  expect(connection).toBe('previous-proxy-settings');
  expect(running).toBe(true);
  expect(readFileSync(fixture.state, 'utf8')).toBe(fixture.previousState);
});

test('failed restart restores a direct connection before stopping the service', async () => {
  let connection = 'proxy';
  let stops = 0;
  await expect(
    recoverInstalledService({
      stop: () => {
        if (stops++) expect(connection).toBe('original-upstream');
      },
      restoreFiles: () => {},
      restart: async () => false,
      restoreConfig: async original => {
        expect(original).toBe(true);
        connection = 'original-upstream';
      },
    }),
  ).rejects.toThrow('original upstream');
  expect(connection).toBe('original-upstream');
  expect(stops).toBe(2);
});

test('a config restore failure keeps the recovered service running', async () => {
  let running = true;
  await expect(
    recoverInstalledService({
      stop: () => {
        running = false;
      },
      restoreFiles: () => {},
      restart: async () => {
        running = true;
        return true;
      },
      restoreConfig: async () => {
        throw new Error('RPC failed');
      },
    }),
  ).rejects.toThrow('Previous service is running');
  expect(running).toBe(true);
});

test('a log past its limit becomes <log>.1 before the service starts again', () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-runway-log-'));
  temporaryDirectories.push(root);
  const log = join(root, 'jev-runway.log');
  rotateLog(log, 4);
  expect(existsSync(log)).toBe(false);
  writeFileSync(log, 'four');
  rotateLog(log, 4);
  expect(readFileSync(log, 'utf8')).toBe('four');
  writeFileSync(log, 'longer');
  writeFileSync(`${log}.1`, 'oldest');
  rotateLog(log, 4);
  expect(existsSync(log)).toBe(false);
  expect(readFileSync(`${log}.1`, 'utf8')).toBe('longer');
});
