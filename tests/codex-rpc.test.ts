import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { codexRequest } from '../src/codex-config.js';

const originalPath = process.env.PATH;
const directories: string[] = [];
afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeCodex(exitEarly = false) {
  const directory = mkdtempSync(join(tmpdir(), 'jev-runway-rpc-'));
  directories.push(directory);
  writeFileSync(
    join(directory, 'codex'),
    '#!/usr/bin/env bun\n' +
      'let buffer = ""; process.stdin.setEncoding("utf8");\n' +
      'process.stdin.on("data", chunk => { buffer += chunk; let end; while ((end = buffer.indexOf("\\n")) >= 0) {\n' +
      'const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); if (message.id === undefined) continue;\n' +
      (exitEarly ? 'if (message.id === 2) process.exit(7);\n' : '') +
      'const result = message.id === 1 ? {} : { authMode: "chatgpt" };\n' +
      'process.stdout.write(JSON.stringify({ method: "test/notification", params: {} }) + "\\n" + JSON.stringify({ id: message.id, result }) + "\\n");\n' +
      '} });\n',
    { mode: 0o700 },
  );
  process.env.PATH = [directory, dirname(process.execPath), originalPath ?? ''].join(':');
}

test('Codex RPC handles notifications and replies in a single stdout write', async () => {
  fakeCodex();
  await expect(codexRequest('account/read', { refreshToken: false })).resolves.toEqual({ authMode: 'chatgpt' });
});

test('Codex RPC rejects a child exit while awaiting a response', async () => {
  fakeCodex(true);
  await expect(codexRequest('account/read', { refreshToken: false })).rejects.toThrow('Codex app-server exited (7)');
});
