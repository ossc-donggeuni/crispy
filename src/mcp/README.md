# Codex MCP 실행 방법

## 사전 준비

```bash
cd /Users/idonghyeon/crispy
pnpm install
codex --version
```

Codex CLI는 미리 로그인되어 있어야 한다. Crispy Terminal은 신뢰된 로컬 단일-root workspace에서만 실행된다.
실행 시 `codex --version`을 확인해 `0.149.0` 미만에는
`shell_environment_policy.exclude=["CRISPY_MCP_TOKEN"]`을, `0.149.0` 이상에는
`shell_environment_policy.filters.CRISPY_MCP_TOKEN="exclude"`를 사용한다. 버전 또는 config
문법을 안전하게 판정할 수 없으면 credential 없는 bare Codex로 fail-open한다.

## Extension Development Host에서 실행

1. VS Code에서 `/Users/idonghyeon/crispy`를 연다.
2. `F5`를 누르고 `Run Extension`을 실행한다.
3. 새 Extension Development Host 창에서 테스트할 로컬 단일 폴더를 열고 Workspace Trust를 승인한다.
4. Command Palette에서 `Crispy: Open Canvas`를 실행한다.
5. Agent 영역에서 `Codex`를 선택한다.

MCP 연결을 확인하려면 열린 Codex에 다음 프롬프트를 입력한다.

```text
Call the crispy_ping MCP tool once. Do not run shell commands and do not modify files.
```

정상 연결 시 `crispy_ping`이 다음 형태의 결과를 반환한다.

```json
{"ok":true,"server":"crispy","mode":"observation-only"}
```

## 상태 UI의 의미

- indicator 없음: MCP를 준비 중이거나 authenticated activity를 아직 관찰하지 않은 상태다.
  요청 silence는 실패가 아니며 handshake timeout이나 추측성 connection-lost 상태를 만들지 않는다.
- 각 탭 상단의 초록 점: 올바른 bearer token과 exact route를 사용한 protocol-valid ID-bearing
  요청이 SDK의 정상 JSON-RPC result를 만든 상태다. 화면에는 별도 연결 문구를 표시하지 않는다.
- 빨강: current tab/session에서 명시적인 MCP failure가 발생한 상태다. UI에는 raw reason,
  stderr, executable, args, port, route, token 또는 config가 아닌 reason별 고정 문구만 나온다.

retryable 빨간 상태에만 `MCP와 Agent 다시 시작` 버튼이 보인다. 확인 문구는 이 탭의 현재
Codex와 CLI 대화가 종료됨을 명시한다. 수락하면 old CLI process tree와 MCP child를 먼저
정리하고 old token을 revoke한 뒤 fresh sessionId/child/random port/route/token/generation/
config/PTY로 Codex를 자동 실행한다. 다른 탭의 PTY와 MCP runtime은 영향을 받지 않는다.

Codex PTY가 실행된 뒤 MCP child가 비정상 종료되면 현재 Codex 입출력은 유지되고
`adapter_exited` 빨간 상태만 표시된다. 사용자 확인 전에는 bare relaunch나 adapter 자동
재생성을 하지 않는다. 반대로 startup MCP 실패는 기존 정책대로 credential 없는 bare
Codex를 한 번 실행하므로 CLI 자체는 계속 사용할 수 있다.

## 보안 및 지원 경계

- session마다 최소 256-bit CSPRNG bearer token, opaque route, random loopback port와 generation을
  따로 만들며 파일, settings, Webview state, argv, log와 telemetry에 영속화하지 않는다.
- MCP server는 `127.0.0.1`의 exact random route에서만 요청을 받고 `crispy_ping`만 등록한다.
- 배포 보장 target은 macOS Apple Silicon `darwin-arm64`, Linux glibc `linux-x64`, Windows native
  `win32-x64`다. 지원 밖 환경에서는 MCP만 비활성화하고 bare CLI를 막지 않는다.
- Windows `.cmd`만 `ComSpec` one-shot wrapper를 사용하며 macOS/Linux native executable과
  Windows `.exe`는 PTY root process로 직접 실행한다.

## VSIX로 실행

macOS Apple Silicon용 VSIX를 빌드하고 설치한다.

```bash
cd /Users/idonghyeon/crispy
pnpm run package:vsix -- --target darwin-arm64
code --install-extension /Users/idonghyeon/crispy/artifacts/vsix/crispy-0.0.1-darwin-arm64.vsix --force
```

설치 후 VS Code에서 `Developer: Reload Window`를 실행한 다음, 신뢰된 로컬 단일 폴더에서 `Crispy: Open Canvas`를 열고 `Codex`를 선택한다.

## 자동 smoke 실행

```bash
cd /Users/idonghyeon/crispy
pnpm run prepare:codex-mcp-smoke
pnpm run smoke:codex-mcp
```

정상 실행 결과는 다음과 같다.

```text
adapter_ready
awaiting_activity
activity_observed
```

설치된 Codex의 config parsing과 node-pty 실행 경계만 확인하려면 다음을 실행한다.

```bash
pnpm run smoke:codex-config-compat
```

정상 출력 예시는 다음과 같다.

```text
[codex-config-compat-smoke] keyed-filters config parsed through node-pty.
```

Windows에서는 설치된 실제 `codex.cmd`의 config parsing과, 특수문자 경로에 둔
독립 fixture의 `cmd.exe` one-shot 인자 보존을 분리해 검증한다.

```text
[codex-config-compat-smoke] keyed-filters config parsed through node-pty.
[codex-config-compat-smoke] Windows cmd-one-shot special-path launch passed.
```

version probe가 실패하면 `spawn_error`, `exit_nonzero`, `timeout`,
`unparsable_version`처럼 credential을 포함하지 않는 원인이 출력된다.

production/VSIX와 process cleanup까지 포함한 release 확인은 다음 순서로 실행한다.

```bash
pnpm run check-types
pnpm run lint
pnpm run test
pnpm run package
pnpm run package:vsix -- --target darwin-arm64
pnpm run inspect:vsix
pnpm run smoke:pty-kill
pnpm run smoke:codex-config-compat
pnpm run prepare:codex-mcp-smoke
pnpm run smoke:codex-mcp
pnpm run smoke:installed-vsix -- --target darwin-arm64
```

실제 Codex smoke는 로그인된 provider와 loopback/PTY 실행 권한이 필요하므로 일반 CI unit gate와
구분한다. C5 gate가 완료된 뒤에만 Claude L0을 시작한다. Antigravity MCP 연결과
`provider_update_required`의 실제 emit/update 정책은 별도 제품 결정이며 이 단계에서는
구현하지 않는다.
