<div align="center">

# Jev Runway

**Fewer tokens. More runway.**

Codex용 로컬 프록시입니다. 세션이 아직 필요로 하는 오래된 도구 출력이 무엇인지 [Jev](https://docs.typesafe.ai)에게 물어보고, 나머지는 요청이 컴퓨터를 떠나기 전에 정리합니다.

[![npm](https://img.shields.io/npm/v/jev-runway)](https://www.npmjs.com/package/jev-runway)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[English](README.md) · **한국어**

</div>

---

Codex 세션이 길어지면, 지금까지 읽은 파일과 검색 결과와 명령 출력이 모두 기록에 쌓입니다. Codex는 요청을 보낼 때마다 이 기록을 전부 다시 보냅니다. 그중 대부분은 이미 몇 단계 전에 쓸모를 다했지만, 비용은 매 턴마다 다시 발생합니다.

Jev Runway는 Codex와 모델 제공자 사이에서 동작합니다. 턴과 턴 사이에 TypeSafe의 판단 모델인 Jev에게 작업에 아직 필요한 도구 출력이 무엇인지 묻고, 요청을 보낼 때마다 나머지를 정리합니다. 사용자의 메시지와 모델의 답변, 그리고 Jev가 남기기로 한 내용은 바꾸지 않고 그대로 전달합니다.

```text
Codex ──▶ Jev Runway (127.0.0.1:8788) ──▶ 모델 제공자 (ChatGPT 로그인, OpenAI API, 또는 사용자 지정 제공자)
               │
               └──▶ Jev: "이 세션에 이 출력이 아직 필요한가?"
```

실제 Codex 세션 두 개를 Runway로 재생해 본 결과, 모델이 다시 받게 될 읽기 가능한 입력 중 66~76%를 제거했습니다. 평소 사용에서도 모델이 Runway가 정리한 내용을 다시 찾는 경우는 드물었습니다.

## 주요 기능

- **쓸모를 다한 출력만 정리합니다.** Jev는 오래된 도구 호출을 하나씩 작업과 비교해서 판단합니다. 세션에 더 이상 필요하지 않은 출력은 앞의 300자만 남깁니다. 호출 기록은 그대로 두므로, 모델은 무엇을 이미 확인했는지 계속 알 수 있습니다.
- **잃어버리는 내용이 없습니다.** 정리한 출력은 모두 사용자의 컴퓨터에 저장되고, 그 자리에 남긴 안내문이 저장 위치를 알려 줍니다. 모델은 도구를 다시 실행하는 대신 저장된 출력을 읽을 수 있습니다.
- **요청을 기다리게 하지 않습니다.** Jev는 턴과 턴 사이에 백그라운드에서 판단합니다. 어떤 요청도 Jev의 판단을 기다리지 않습니다.
- **문제가 생기면 원래대로 보냅니다.** Jev를 사용할 수 없거나 Runway가 안전하게 읽을 수 없는 요청이면, Codex가 보낸 그대로 전달합니다.
- **효과를 직접 보여 줍니다.** `jev-runway status`는 절감량을 제공자의 토큰 계산 기준으로 보여 주고, 정리 때문에 모델이 손해를 보았는지와 확인이 필요한 문제를 함께 알려 줍니다.
- **실행 파일 하나로 동작합니다.** Runway는 독립적인 실행 파일 하나로 설치되며, 설치한 뒤에는 Node나 Bun이 필요하지 않습니다.

## 빠른 시작

```sh
npx jev-runway install
jev-runway status
```

설치는 이것으로 끝납니다. `install`은 다음 순서로 진행됩니다.

1. 처음 실행할 때 Jev 키를 묻습니다. 방향키로 TypeSafe와 Vercel AI Gateway 중 하나를 고르고 키를 붙여 넣으면, 키를 확인한 뒤에 저장합니다.
2. Codex가 지금 어디로 연결하는지 찾습니다. ChatGPT 로그인, OpenAI API 키, `~/.codex/config.toml`에 설정한 사용자 지정 제공자 중 무엇이든 그곳으로 요청을 전달합니다.
3. Runway를 백그라운드 서비스로 시작하고 Codex가 Runway를 거치도록 설정합니다. macOS에서는 launchd 에이전트로, Linux에서는 systemd 사용자 서비스로 실행합니다. 기존 연결 설정은 `uninstall`을 위해 저장해 둡니다.
4. `~/.local/bin`에 `jev-runway` 명령을 추가하고, 이 폴더가 `PATH`에 없으면 알려 줍니다.

설치한 뒤에는 새 Codex 작업을 시작하세요. 이미 실행 중인 작업은 이전 연결을 계속 사용할 수 있습니다.

### 요구 사항

- macOS(Apple silicon 또는 Intel)나, systemd를 사용하는 Linux(x64 또는 arm64, glibc)
- `npx`를 한 번 실행하기 위한 Node.js
- 로그인이 끝나서 정상적으로 동작하는 Codex CLI 또는 Codex 데스크톱 앱
- [TypeSafe](https://console.typesafe.ai/settings/keys) 또는 [Vercel AI Gateway](https://vercel.com/ai-gateway)에서 발급한 Jev API 키

<details>
<summary><b>Linux</b>: 로그아웃한 뒤에도 서비스를 계속 실행하기</summary>

Runway는 systemd 사용자 서비스 `jev-runway`로 실행되며, 상태는 `systemctl --user status jev-runway`로 확인할 수 있습니다. 사용자 서비스는 로그아웃하면 멈추므로, 계속 실행하려면 다음 명령을 한 번 실행해서 lingering을 켜세요.

```sh
loginctl enable-linger "$USER"
```

</details>

<details>
<summary><b>Windows</b> (실험적)</summary>

Windows용 릴리스와 백그라운드 서비스는 아직 없으며, Windows에서는 테스트하지 않았습니다. [Bun](https://bun.sh)이 설치되어 있다면 소스 체크아웃에서 실행할 수 있습니다([개발](#개발) 참고).

```sh
bun src/cli.ts start
```

그다음 `~/.codex/config.toml`에 아래 설정을 추가해서 Codex가 Runway를 거치도록 합니다. 원래 연결로 돌아가려면 이 설정을 지우세요.

```toml
model_provider = "jev_runway"

[model_providers.jev_runway]
name = "Jev Runway"
base_url = "http://127.0.0.1:8788/v1"
requires_openai_auth = true
supports_websockets = false
```

</details>

## 명령

| 명령 | 설명 |
| --- | --- |
| `install [--upstream URL] [--debug \| --no-debug]` | 백그라운드 서비스를 설치하거나 업데이트하고 Codex를 연결합니다 |
| `update` | 설치된 버전보다 새로운 릴리스가 있으면 설치합니다 |
| `uninstall` | 서비스를 멈추고, 이전 Codex 연결을 복원한 뒤, Runway를 삭제합니다 |
| `start [--upstream URL]` | Codex 설정을 바꾸지 않고 터미널에서 직접 실행합니다 |
| `status [--details] [--watch] [--json] [--session ID]` | 절감량과 품질 신호, 동작 상태를 보여 줍니다 |
| `auth set` | 제공자를 고르고, 확인이 끝난 키를 저장합니다 |
| `auth check` · `auth status` | 작은 Jev 요청으로 키를 확인하거나, 사용 중인 키만 보여 줍니다 |
| `auth reset [--yes]` | 저장된 키를 삭제합니다 |

`install`이 Codex의 연결 대상을 알아내지 못하면, Codex가 사용하는 API의 기본 주소를 `--upstream https://api.openai.com/v1`처럼 지정하세요. Runway 자신의 주소를 지정하면 안 됩니다.

## `status` 읽는 법

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

- **Savings**는 정리하지 않았을 때 제공자가 받았을 양과 실제로 받은 양을 비교합니다. Runway가 자체적으로 계산한 토큰 추정치는 실제보다 크게 나오므로, 세션마다 제공자가 보고한 값으로 보정합니다. 세션에 표본이 충분히 쌓이기 전에는 보정하지 않은 추정치를 보여 줍니다. 어느 쪽이든 추정치이며 청구 금액이 아닙니다.
- **Quality**는 정리 때문에 모델이 손해를 보았는지 알려 줍니다. ✓는 모델이 정리된 출력을 다시 찾는 경우가 드물었다는 뜻이고, !는 Jev가 아직 필요한 출력을 정리하고 있을 수 있다는 뜻입니다.
- **Jev**와 **Connection**은 판단 횟수와 소요 시간, Codex가 Runway를 거치는지, upstream, 사용 중인 키를 보여 줍니다. 확인이 필요한 문제는 맨 아래에 해결 방법과 함께 표시됩니다.

`--watch`는 2초마다 화면을 새로 고치고, `--details`는 요약에 쓰인 모든 수치를 추가로 보여 주며, `--json`은 스크립트에서 사용하기 위한 형식입니다. 수치는 서비스가 마지막으로 시작된 이후의 합계입니다.

## 업데이트와 삭제

```sh
jev-runway update      # Codex의 응답이 모두 끝난 뒤에 실행하세요
jev-runway uninstall
```

`update`는 npm에서 사용자의 기기에 맞는 최신 릴리스를 받아서 npm의 무결성 해시로 확인한 뒤에 설치합니다. upstream과 키, 설정은 그대로 유지합니다. `uninstall`은 서비스를 멈추고 이전 Codex 연결을 복원한 뒤에 설치된 파일을 삭제합니다. 저장된 Jev 키는 `jev-runway auth reset`을 실행하기 전까지 남아 있습니다.

## 설정

**Jev 키.** `auth set`은 키를 `~/.config/jev-runway/credentials.json`에 저장하며, 이 파일은 본인만 읽을 수 있습니다. 대신 Codex의 셸 환경 정책에 키를 설정할 수도 있습니다. 저장된 키가 환경 변수보다 우선하며, 두 환경 변수가 모두 있으면 `TYPESAFE_API_KEY`를 사용합니다.

```toml
# ~/.codex/config.toml
[shell_environment_policy.set]
TYPESAFE_API_KEY = "..."    # 또는 AI_GATEWAY_API_KEY = "..."
```

**TypeSafe와 Vercel 중 무엇을 써야 할까요?** 둘 다 동작합니다. Vercel AI Gateway는 큰 Jev 요청을 거부하므로, Vercel을 사용하면 Runway가 긴 세션을 여러 부분으로 나누어 판단합니다. TypeSafe 키를 사용하면 Jev가 세션 전체를 한 번에 볼 수 있습니다.

**환경 변수.** 아래 변수는 같은 셸 환경 정책에 설정한 뒤에 `install`을 다시 실행해야 적용됩니다.

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `JEV_RUNWAY_MODEL` | `jev-latest`, Vercel에서는 `typesafe-ai/jev` | 사용할 Jev 모델을 지정합니다 |
| `JEV_RUNWAY_DEBUG` | 꺼짐 | 메타데이터만 기록하는 디버그 로그입니다. `install --debug`와 `--no-debug`로 켜고 끕니다 |
| `JEV_RUNWAY_WEBSOCKET` | 켜짐 | `0`으로 설정하면 모든 요청을 HTTP로 upstream에 보냅니다 |

**다른 프록시와 연결하기.** Runway는 단독으로 동작하지만, [Headroom](https://github.com/chopratejas/headroom) 같은 다른 OpenAI 호환 프록시 앞에 둘 수도 있습니다. 이렇게 설정하면 요청은 Codex, Jev Runway, 사용자의 프록시, 제공자 순서로 전달됩니다.

```sh
jev-runway install --upstream http://127.0.0.1:8787/v1
```

## 개인정보

- Runway는 `127.0.0.1`에서만 연결을 받고, 인증 헤더는 사용자가 설정한 upstream으로 그대로 전달합니다.
- 무엇을 정리할지 판단하기 위해 대화의 텍스트와 도구 입력을 Jev에 보냅니다. 이때 도구 출력은 크기만 알려 주는 짧은 안내문으로 줄여서 보냅니다. 이러한 데이터 전송이 사용자의 데이터 정책에 맞지 않는다면 Runway를 사용하지 마세요.
- 정리한 출력은 `~/.codex/jev-runway/archive/`에 본인만 읽을 수 있도록 저장되며, 세션이 마지막으로 출력을 저장한 뒤 일주일이 지나면 삭제됩니다.
- 통계와 디버그 로그에는 프롬프트, 도구 출력, 헤더, 키가 기록되지 않습니다.

## 문제 해결

- **Codex가 Runway를 거치지 않는 것 같을 때**: `status`의 Connection에서 **Codex** 항목을 확인하고, 새 Codex 작업을 시작하세요.
- **`status`에 Jev 실패가 표시될 때**: `jev-runway auth check`를 실행하세요. TypeSafe가 402를 반환하면 계정에 크레딧이 필요하다는 뜻입니다. Vercel에서 가끔 발생하는 503은 자동으로 재시도합니다.
- **그 밖의 문제가 있을 때**: 디버그 로그를 켠 뒤에 문제를 재현하고 로그의 마지막 줄을 확인하세요. 확인이 끝나면 `install --no-debug`로 로그를 다시 끄세요.

  ```sh
  jev-runway install --debug
  tail -n 50 ~/.codex/log/jev-runway.log
  ```

## 한계

- Runway는 Codex의 Responses 요청만 정리하며, 그중에서도 텍스트로 된 도구 출력만 정리합니다. 이미지를 비롯한 미디어는 그대로 둡니다.
- 세션의 첫 메시지와 가장 최근 항목 6개는 정리하지 않습니다.
- Runway가 요청마다 전체 기록을 받아야 하므로, Codex와 Runway 사이의 연결은 HTTP를 사용합니다. upstream이 WebSocket을 지원하면 Runway와 upstream 사이에서는 WebSocket을 사용합니다.
- 토큰 수치는 추정치입니다. 절감액을 계산하기 전에 제공자의 사용량 보고서를 확인하세요.

## 동작 원리

Runway는 [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)의 접근 방식을 바탕으로 합니다. 긴 대화를 요약하는 대신, 어떤 도구 출력이 아직 필요한지 Jev가 판단하게 하는 방식입니다.

1. **턴과 턴 사이**: 새 도구 출력이 32,000자 이상 쌓이면, Runway는 오래된 도구 호출마다 Jev에게 두 가지를 묻습니다. 이 호출이 아직 의미가 있는지, 그리고 전체 출력이 아직 필요한지를 묻습니다. Jev는 도구 출력을 크기만 알려 주는 안내문으로 줄인 대화 전체와 작업 내용을 보고 판단합니다.
2. **요청을 보낼 때마다**: Codex는 요청할 때마다 전체 기록을 다시 보내므로, Runway는 세션마다 저장한 판단을 모든 요청에 적용합니다. Jev가 필요 없다고 판단한 출력은 앞의 300자와 저장 위치를 알려 주는 안내문만 남깁니다. 호출이 모두 정리된 단계에서는 모델이 저장해 둔 reasoning도 함께 제거합니다. 제공자가 그 reasoning을 입력 토큰으로 과금하기 때문입니다.
3. **예산 안에서**: Jev 요청은 사용하는 Jev 제공자가 받아 주는 크기에 맞춥니다. 한 번에 들어가지 않는 긴 세션은 작업 내용과 최신 메시지를 붙인 여러 부분으로 나누어 판단하며, Jev가 읽을 수 없을 만큼 기록을 압축하지는 않습니다.
4. **Codex가 스스로 압축할 때**: Runway는 Codex가 기록을 요약하려고 보내는 요청에서도 오래된 출력을 정리하므로, 요약에 쓸모없는 출력이 섞이지 않습니다. 요약이 끝나면 판단을 처음부터 다시 시작합니다.
5. **WebSocket으로 보낼 때**: upstream이 WebSocket을 지원하면, Runway는 Codex가 직접 보낼 때와 같은 방식으로 세션마다 WebSocket을 사용합니다. 정리된 기록을 한 번 보낸 뒤에는 직전 응답 이후에 추가된 항목만 보냅니다. Jev가 기록을 더 정리하면 전체 기록을 다시 보내며, WebSocket을 사용할 수 없으면 HTTP로 보냅니다.

## 개발

```sh
git clone https://github.com/IPECTER/jev-runway.git jev-runway
cd jev-runway
bun install --frozen-lockfile
bun run check              # 타입 검사, 린트, dist/jev-runway 빌드, 테스트
./dist/jev-runway install  # npm 릴리스 대신 이 체크아웃을 설치합니다
```

`bun run format`은 Biome으로 코드를 포맷하고 수정합니다. `bun run benchmark:replay`는 모의 Jev를 사용해서 합성 세션에 정리를 실행하며, 유료 호출을 하지 않습니다.

**릴리스.** `bun run release`는 `dist/npm`에 릴리스를 만듭니다. 플랫폼마다 실행 파일을 담은 패키지 하나와, 기기에 맞는 실행 파일을 실행하는 `jev-runway` 패키지로 구성됩니다. `bun scripts/release.ts --publish`는 플랫폼 패키지부터 차례로 배포합니다. `v*` 태그를 push하면 GitHub Actions가 `NPM_TOKEN` secret을 사용해서 같은 작업을 수행합니다.

## 라이선스

[MIT](LICENSE)
