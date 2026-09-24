<div align="center">

# Jev Runway

**Fewer tokens. More runway.**

A local proxy for Codex that asks [Jev](https://docs.typesafe.ai) which old tool output your session still needs, and trims the rest before each request leaves your machine.

[![npm](https://img.shields.io/npm/v/jev-runway)](https://www.npmjs.com/package/jev-runway)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [한국어](README.ko.md)

</div>

---

A long Codex session carries every file it has read, every search, and every command output, and Codex sends all of it again with each request. Most of that stopped mattering several steps ago, yet you pay for it on every turn.

Jev Runway sits between Codex and your model provider. Between turns it asks Jev, TypeSafe's decision model, which tool output the task still depends on. On every request it trims the rest. Your messages, the model's replies, and anything Jev keeps go through untouched.

```text
Codex ──▶ Jev Runway (127.0.0.1:8788) ──▶ your provider (ChatGPT sign-in, OpenAI API, or a custom one)
               │
               └──▶ Jev: "does this session still need this output?"
```

Replaying two real Codex sessions through Runway removed 66–76% of the readable input the model would otherwise have received again. In daily use, the model rarely went back for anything Runway had trimmed.

## Highlights

- **Trims what stopped mattering.** Jev judges each old tool call against the task. Output the session no longer needs is cut to a 300-character head. The call itself stays, so the model still knows what it already looked at.
- **Loses nothing.** Every trimmed output is saved on your machine, and the note left in its place says where. The model can read it back instead of running the tool again.
- **Never makes you wait.** Jev decides between turns, in the background. No request waits for Jev.
- **Fails safe.** If Jev is unavailable, or a request is not one Runway can read safely, it goes out exactly as Codex sent it.
- **Shows its work.** `jev-runway status` reports the savings in your provider's own token counts, whether trimming ever cost the model anything, and what needs your attention.
- **One binary.** Runway installs as a single self-contained executable. It needs neither Node nor Bun once installed.

## Quick start

```sh
npx jev-runway install
jev-runway status
```

That is the whole setup. `install`:

1. Asks for your Jev key the first time. Pick TypeSafe or Vercel AI Gateway with the arrow keys and paste the key; it is verified before it is saved.
2. Finds where Codex connects today, whether your ChatGPT sign-in, an OpenAI API key, or a custom provider in `~/.codex/config.toml`, and forwards requests there.
3. Starts Runway as a background service (a launchd agent on macOS, a systemd user service on Linux) and points Codex at it. Your previous connection is saved for `uninstall`.
4. Adds a `jev-runway` command to `~/.local/bin`, and tells you if that folder is not on your `PATH`.

Start a new Codex task afterwards; tasks already running may keep their old connection.

### Requirements

- macOS (Apple silicon or Intel), or Linux (x64 or arm64, glibc) with systemd
- Node.js, only to run `npx` once
- Codex CLI or the Codex desktop app, signed in and working
- A Jev API key from [TypeSafe](https://console.typesafe.ai/settings/keys) or [Vercel AI Gateway](https://vercel.com/ai-gateway)

<details>
<summary><b>Linux</b>: keep the service running after you log out</summary>

Runway runs as the systemd user service `jev-runway` (`systemctl --user status jev-runway`). A user service stops when you log out. To keep it running, enable lingering once:

```sh
loginctl enable-linger "$USER"
```

</details>

<details>
<summary><b>Windows</b> (experimental)</summary>

There is no Windows release or background service yet, and Runway has not been tested there. With [Bun](https://bun.sh) installed, run it from a source checkout (see [Development](#development)):

```sh
bun src/cli.ts start
```

Then point Codex at it in `~/.codex/config.toml`, and remove these lines to go back:

```toml
model_provider = "jev_runway"

[model_providers.jev_runway]
name = "Jev Runway"
base_url = "http://127.0.0.1:8788/v1"
requires_openai_auth = true
supports_websockets = false
```

</details>

## Commands

| Command | What it does |
| --- | --- |
| `install [--upstream URL] [--debug \| --no-debug]` | Install or update the background service and connect Codex |
| `update` | Install the newest release, if it is newer than yours |
| `uninstall` | Stop the service, restore your previous Codex connection, and remove Runway |
| `start [--upstream URL]` | Run in the foreground without changing Codex's configuration |
| `status [--details] [--watch] [--json] [--session ID]` | Savings, quality signals, and health |
| `auth set` | Choose a provider and save a verified key |
| `auth check` · `auth status` | Test the key with a small Jev request, or just show which one is used |
| `auth reset [--yes]` | Remove the saved key |

If `install` cannot tell where Codex connects, pass the base URL of the API Codex uses, such as `--upstream https://api.openai.com/v1`. Never point it at Runway itself.

## Reading `status`

```text
◆ Jev Runway                                                  ● running · up 2h 42m
─────────────────────────────────────────────────────────────────────────────────────

SAVINGS
  Input tokens  ███████████░░░░░░░░░░░░░  46% fewer
                58.7M removed · 68.7M sent · in your provider's own counts
  Trimmed       607 of 880 model requests (69%)
  Cache         92% of input served from cache · 95% on trimmed requests

QUALITY
  Re-runs       ✓ 5 of 564 trimmed calls run again (0.9%)
  Re-reads      ✓ 13% of trimmed files read again · 60% of files otherwise
```

- **Savings** compares what your provider received with what it would have received. Runway's own token estimate runs high, so each session calibrates it against the provider's reported counts; until a session has enough samples, `status` shows the raw estimate instead. It is an estimate either way, not billing data.
- **Quality** tells you whether trimming costs the model anything. A ✓ means the model rarely needed a trimmed output again; a ! means Jev may be letting go of output that still matters.
- **Jev** and **Connection** show evaluations and their timing, whether Codex goes through Runway, the upstream, and the key in use. Anything that needs attention is listed at the end with what to do.

`--watch` refreshes every two seconds, `--details` adds every counter behind the summary, and `--json` is for scripts. Figures cover the time since the service last started.

## Update and uninstall

```sh
jev-runway update      # after Codex has finished responding
jev-runway uninstall
```

`update` downloads the newest release for your machine from npm, checks it against npm's integrity hash, and installs it, keeping your upstream, key, and settings. `uninstall` stops the service, restores your previous Codex connection, and removes the installed files; your saved Jev key stays until `jev-runway auth reset`.

## Configuration

**Jev key.** `auth set` stores it in `~/.config/jev-runway/credentials.json`, readable only by you. You can use Codex's shell environment policy instead; a saved key takes precedence, and `TYPESAFE_API_KEY` wins if both are set.

```toml
# ~/.codex/config.toml
[shell_environment_policy.set]
TYPESAFE_API_KEY = "..."    # or AI_GATEWAY_API_KEY = "..."
```

**TypeSafe or Vercel?** Both work. Vercel AI Gateway rejects large Jev requests, so through Vercel, Runway judges a long session in several parts. A TypeSafe key lets Jev see a whole session at once.

**Settings.** Set these in the same policy, then run `install` again.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JEV_RUNWAY_MODEL` | `jev-latest`, or `typesafe-ai/jev` on Vercel | The Jev model to use |
| `JEV_RUNWAY_DEBUG` | off | Metadata-only debug log; toggle with `install --debug` / `--no-debug` |
| `JEV_RUNWAY_WEBSOCKET` | on | `0` sends every request upstream over HTTP |

**Another proxy.** Runway works on its own, but it can sit in front of another OpenAI-compatible proxy such as [Headroom](https://github.com/chopratejas/headroom), making the chain Codex → Jev Runway → your proxy → provider:

```sh
jev-runway install --upstream http://127.0.0.1:8787/v1
```

## Privacy

- Runway listens on `127.0.0.1` only, and forwards your authorization headers to the upstream you configured.
- To decide what to trim, it sends Jev the conversation's text and tool inputs, with tool output reduced to short size notes. Do not use Runway if that conflicts with your data policy.
- Trimmed outputs are saved under `~/.codex/jev-runway/archive/`, readable only by you, and deleted a week after the session last saved one.
- Metrics and the debug log never contain prompts, tool output, headers, or keys.

## Troubleshooting

- **Codex does not seem to use Runway.** Check **Codex** under Connection in `status`, and start a new Codex task.
- **`status` shows Jev failures.** Run `jev-runway auth check`. A 402 from TypeSafe means the account needs credits; occasional 503s from Vercel are retried automatically.
- **Something else.** Turn on the debug log, reproduce the problem, and read the last lines. Turn it off again with `install --no-debug`.

  ```sh
  jev-runway install --debug
  tail -n 50 ~/.codex/log/jev-runway.log
  ```

## Limits

- Only Codex's Responses requests are trimmed, and only text tool output; images and other media stay as they are.
- The first message and the six newest items of a session are never trimmed.
- Codex talks to Runway over HTTP, because Runway needs each request's whole history. Runway uses a WebSocket upstream when the upstream accepts one.
- Token figures are estimates. Check your provider's usage report before you count savings.

## How it works

Runway builds on the approach of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction): instead of summarizing a long conversation, let Jev decide which tool output it still needs.

1. **Between turns.** Once at least 32,000 characters of new tool output have arrived, Runway asks Jev two questions about each old tool call: does the call still matter, and is its full output still needed? Jev sees the task and the whole conversation, with tool output reduced to size notes.
2. **On every request.** Codex resends its whole history each time, so Runway applies the session's decisions to every request. Output Jev let go is cut to its first 300 characters and a note naming the saved file. The model's saved reasoning for a step whose calls were all trimmed goes too, since providers bill it as input.
3. **Within budget.** Each Jev request is sized to what your Jev provider accepts. A session too long for one request is judged in parts, each with the task and the newest messages, rather than squeezed until Jev can no longer read it.
4. **When Codex compacts.** Runway trims Codex's own summarization request too, so the summary is written without the stale output, then starts over.
5. **Over a WebSocket.** When the upstream accepts one, Runway sends each session over a WebSocket as Codex itself would: the trimmed history once, then only what follows the previous response. When Jev trims more, the history is sent whole again. If the WebSocket cannot be used, the request goes over HTTP.

## Development

```sh
git clone https://github.com/IPECTER/jev-runway.git jev-runway
cd jev-runway
bun install --frozen-lockfile
bun run check              # typecheck, lint, build dist/jev-runway, tests
./dist/jev-runway install  # install this checkout instead of the npm release
```

`bun run format` formats and fixes with Biome. `bun run benchmark:replay` runs compaction on a synthetic session against a mocked Jev, with no paid calls.

**Releasing.** `bun run release` builds `dist/npm`: one package per platform holding its binary, and the `jev-runway` package whose launcher runs the right one. `bun scripts/release.ts --publish` publishes them, platform packages first. Pushing a `v*` tag does the same in GitHub Actions, given an `NPM_TOKEN` secret.

## License

[MIT](LICENSE)
