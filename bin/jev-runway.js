#!/usr/bin/env node
// Runs the Jev Runway binary npm installed for this machine, from the platform package beside this one.
// It needs only Node to start; the binary carries its own runtime.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const target = `${process.platform}-${process.arch}`;
let binary;
try {
  binary = createRequire(import.meta.url).resolve(`jev-runway-${target}/bin/jev-runway`);
} catch {
  process.stderr.write(
    `Jev Runway has no release for ${target}. Releases cover darwin-arm64, darwin-x64, linux-x64, and linux-arm64 with glibc.\n` +
      'On one of those, reinstall without --omit=optional or --no-optional, which skip the binary.\n',
  );
  process.exit(1);
}
// The binary handles Ctrl-C itself, for one thing to restore the terminal after `status --watch`; this
// process waits for it instead of exiting first.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => undefined);
const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`Could not run ${binary}: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
