# `src/agent/`

## 최초 실행 가이드

이 절은 Crispy 저장소를 처음 받은 팀원이 Agent Terminal을 개발 환경에서 실행하고
테스트하는 데 필요한 절차를 설명한다. 완성된 VSIX 사용자는 Node.js나 pnpm을 설치할
필요가 없지만, **소스에서 Extension Development Host를 실행하는 개발자**는 아래 개발
toolchain과 repository dependency를 설치해야 한다.

### 1. 지원 환경과 필수 도구

현재 지원 target은 다음 세 가지다.

```text
darwin-arm64
linux-x64
win32-x64
```

`darwin-x64`와 cross packaging은 지원하지 않는다. 개발 환경에는 다음 도구가 필요하다.

| 도구 | 요구사항 | 용도 |
| --- | --- | --- |
| VS Code | `1.125.x` 이상 | Extension Development Host 실행 |
| Node.js | `24.x` | build, test 및 native runtime 준비 |
| pnpm | 정확히 `11.18.0` | lockfile 기반 dependency 설치 |
| Git | 현재 저장소 checkout | 소스 및 변경 이력 관리 |

세 target 모두 고정된 `node-pty` package의 target prebuild를 사용한다. `linux-x64`의
ABI baseline 검사에는 `readelf`를 제공하는 binutils가 필요하다. `win32-x64`는 Windows
버전에 따른 시스템 ConPTY 차이를 피하기 위해 VSIX에 포함된 `conpty.dll` backend를 사용한다.

버전을 먼저 확인한다.

```bash
node --version
pnpm --version
```

Node가 `v24.x`가 아니거나 pnpm이 `11.18.0`이 아니면 프로젝트 명세와 다른 환경이다.
pnpm이 없다면 Node.js 설치 후 다음처럼 정확한 버전을 설치할 수 있다.

```bash
npm install --global pnpm@11.18.0
```

### 2. 저장소 최초 설치

저장소 root에서 dependency를 설치한다.

```bash
pnpm install --frozen-lockfile
```

이 명령은 root dependency와 `node-pty@1.2.0-beta.14`를 설치하고 `postinstall`의
`prepare-node-pty.js`를 실행한다. 지원 환경에서는 별도의 `node-gyp rebuild`나
`chmod`를 수동으로 실행하지 않는다.

설치 직후 기본 검사를 실행해 환경이 정상인지 확인한다.

```bash
pnpm run check-types
pnpm run lint
pnpm run compile
```

### 3. Codex와 Claude CLI 준비

두 provider는 Crispy가 새 Terminal을 만든 뒤 각각의 CLI를 실행한다. macOS/Linux에서는
`codex` 또는 `claude`를 기본으로 사용한다. Windows에서는 실제 PowerShell에서 `--version`을
실행해 Codex는 `codex`, `codex.cmd`, `codex.exe`, Claude는 `claude`, `claude.cmd`,
`claude.exe` 순으로 첫 성공 후보를 선택한다. 사용할 CLI가 팀원의 머신에 설치되어 있고
VS Code Extension Host가 상속한 `PATH`에서도 resolve되어야 한다.

자동 탐색으로 찾을 수 없는 설치는 VS Code Settings의 `crispy.codexCliPath` 또는
`crispy.claudeCliPath`에 executable 전체 경로를 지정한다. 설정한 경로를 가장 먼저 검증하며,
검증에 실패하면 같은 provider의 기본 후보를 계속 탐색한다.

#### Codex

macOS/Linux에서는 OpenAI 공식 installer를 사용할 수 있다.

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

설치 후 일반 Terminal에서 다음을 확인한다.

```bash
codex --version
codex
```

최초 `codex` 실행에서는 안내에 따라 ChatGPT 또는 제공되는 다른 인증 방식으로 로그인한다.
플랫폼별 최신 설치·인증 방법은 [OpenAI Codex CLI 공식 문서](https://learn.chatgpt.com/docs/codex/cli)를
따른다.

#### Claude — macOS/Linux

Anthropic native installer를 사용한다.

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

설치 후 버전과 Shell에서 resolve되는 경로를 확인한다.

```bash
claude --version
command -v claude
```

macOS에서는 `which claude`도 사용할 수 있다. 일반 Terminal에서 찾을 수 있더라도 VS Code
Extension Host가 상속한 `PATH`에 설치 경로가 없으면 Crispy의 Shell에서는 실행되지 않는다.

#### Claude — Windows

PowerShell에서 Anthropic native installer를 사용한다.

```powershell
irm https://claude.ai/install.ps1 | iex
```

또는 WinGet으로 설치할 수 있다.

```powershell
winget install Anthropic.ClaudeCode
```

설치 후 native 실행 파일과 버전을 확인한다.

```powershell
Get-Command claude.exe -All
Test-Path "$env:USERPROFILE\.local\bin\claude.exe"
claude --version
```

native installer의 기본 실행 파일은 `%USERPROFILE%\.local\bin\claude.exe`다. Crispy는
native `claude.exe`뿐 아니라 설치 방식에 따라 만들어지는 `claude`와 `claude.cmd`도 자동
탐색한다. `Get-Command` 결과에서 Claude Desktop의 `Claude.exe` alias가 Claude Code보다 먼저
resolve되면 `crispy.claudeCliPath`에 원하는 Claude Code executable의 전체 경로를 지정한다.

Git for Windows는 권장 사항이지만 필수 prerequisite로 강제하지 않는다. Git Bash가 없으면
최신 Claude Code는 Windows PowerShell을 사용할 수 있다. 최신 설치 조건과 문제 해결 방법은
[Claude Code 설정 문서](https://code.claude.com/docs/en/setup)와
[Claude Code 설치 문제 해결 문서](https://code.claude.com/docs/en/troubleshoot-install)를 따른다.

#### 설치 및 인증 오류

Crispy는 Windows 후보 선택에 필요한 `--version` 성공 여부만 검사하며 CLI를 설치하거나
인증 상태를 판별하지 않는다. 모든 후보가 실패하면 문서 기준 기본 이름을 Shell에 입력해
`command not found` 또는 `not recognized` 출력을 그대로 표시한다. CLI가 로그인, workspace
trust 또는 초기 설정을 요구하면 기존 PTY/xterm.js 화면에서 사용자가 직접 진행한다. Crispy는
CLI의 설치 여부, version 또는 인증 상태를 사전에 보장하지 않으며 OAuth, API key 또는 provider
credential을 저장하거나 처리하지 않는다.

### 4. Extension Development Host 실행

1. VS Code에서 Crispy repository root를 연다.
2. `Run and Debug`에서 `Run Extension`을 선택하거나 `F5`를 누른다.
3. 기본 build task가 TypeScript와 esbuild watch를 시작할 때까지 기다린다.
4. 새로 열린 Extension Development Host에서 테스트할 로컬 폴더를 연다. multi-root를
   확인하려면 `File: Add Folder to Workspace...`로 두 번째 로컬 폴더를 추가한다.
5. Workspace Trust 요청이 나오면 신뢰할 수 있는 테스트 폴더에 한해 승인한다.
6. Command Palette에서 `Crispy: Open Canvas`를 실행한다.
7. Agent 영역에서 Workspace와 `Codex` 또는 `Claude`를 선택한다. 각 탭은
   Workspace root 하나를 독립적으로 선택할 수 있다.

현재 Terminal 시작 정책은 trusted local `file:` root를 허용한다. multi-root Workspace에서는
Host가 제공한 root ID로 선택한 폴더를 exact lookup하고 그 폴더의 fresh `fsPath`를 `cwd`로
사용한다. 다음 환경 또는 root에서는 PTY 시작이 거부된다.

- 폴더를 열지 않은 빈 window
- untrusted workspace
- virtual 또는 remote workspace
- 빈 경로, NUL 포함 경로 또는 현재 플랫폼에서 absolute가 아닌 경로

한 탭에 assignment가 생기면 Workspace는 잠긴다. provider만 바꾸면 현재 Workspace를
유지하지만 다른 Workspace를 선택하려면 먼저 Reset을 완료해야 한다. 이미 실행 중인 root가
Workspace에서 제거되면 현재 I/O는 유지되고 다음 start/restart/MCP restart가 차단된다.
Workspace Trust가 해제되면 입력과 출력 publication을 즉시 차단하고 Agent/MCP process tree를
종료하며, 기존 assignment와 retry 가능한 `workspace_untrusted` error session을 보존한다.

provider 선택 후 기본 Shell만 보이거나 CLI의 `command not found`가 출력되면 Crispy 설치
문제라기보다 Extension Host가 상속한 `PATH` 문제일 수 있다. VS Code를 완전히 종료한 뒤
해당 CLI를 찾을 수 있는 Terminal에서 `code .`로 다시 열어 비교한다.

### 5. 테스트

#### 전체 테스트

repository root에서 다음을 실행한다.

```bash
pnpm test
```

이 명령은 테스트 TypeScript compile, 일반 compile, lint를 먼저 수행하고 VS Code
Extension Host에서 전체 test suite를 실행한다. 테스트용 VS Code가 로컬에 없으면 최초
실행 시 다운로드하므로 네트워크와 디스크 공간이 필요하다.

Agent 관련 test는 `src/test/agent/`에 있으며 다음 범위를 포함한다.

- protocol 및 session state validation
- workspace와 Shell policy
- multi-root exact lookup, 탭별 selected-root `cwd`, POSIX/Windows path
- 탭별 Terminal routing
- provider 선택과 Codex/Claude 자동 실행 입력
- PTY input/output, resize, restart와 cleanup
- Workspace Trust revoke의 input/output gate, monitor, Agent/MCP cleanup과 복구
- process tree cleanup
- 실제 `node-pty` Terminal smoke
- UI tab, provider bar와 confirm dialog

#### 실제 process tree smoke

테스트가 생성한 child process tree를 종료하고 잔존 process가 없는지 확인한다.

```bash
pnpm run smoke:pty-kill
```

#### Production bundle 확인

target 정보 없이 일반 production bundle을 확인할 때 사용한다.

```bash
pnpm run package
```

#### Codex MCP session config 수동 smoke

Codex MCP adapter와 session-only CLI config serializer를 실제 설치된 Codex로 확인한다. 먼저
test source와 production `dist/mcp-server.mjs`를 준비한 뒤 smoke를 실행한다. Smoke는 config
파일이나 VS Code settings를 쓰지 않고 `--config` argv와 process environment만 사용한다.
Codex 로그, MCP URL 및 credential은 출력하지 않는다.

Smoke도 제품 연결과 같은 structured launch 경계를 사용한다. macOS/Linux에서는 `PATH`의
실행 가능한 native Codex 경로를 직접 resolve하고, Windows에서는 `.exe`를 direct process로,
npm `.cmd` shim을 `ComSpec /d /s /v:off /c` one-shot으로 구분한다. MCP plan에만 등록된
token overlay를 넣으며 bare plan과 최종 provider environment에서는 stale token casing과
`ELECTRON_RUN_AS_NODE`를 제거한다.

```bash
pnpm run prepare:codex-mcp-smoke
pnpm run smoke:codex-mcp
```

Codex CLI가 로그인되어 있어야 한다. 정상 실행은 아래 세 상태만 출력하며 authenticated MCP의 전체
lifecycle을 관찰하고 provider가 정상 종료한 뒤 Codex와 adapter를 정리한다.

```text
adapter_ready
awaiting_activity
lifecycle_observed
```

smoke는 Tool 이름을 직접 지시하지 않고 두 파일을 읽게 한다. `src/mcp` planned anchor, 두 파일의
active, 두 clear와 마지막 `src/mcp` completed가 모두 있고 이후 Activity가 없어야 통과한다.

실패 시에는 raw provider output 대신 `failed:<safe-reason>`만 출력한다. 요청이 늦다는 이유로
연결 실패를 추론하지 않으므로, activity를 기다리는 동안에는 임의 silence timeout을 두지 않는다.

#### 현재 platform VSIX 검증

아래 `<target>`에는 현재 머신과 정확히 일치하는 값만 사용할 수 있다.

```bash
pnpm run package:vsix -- --target <target>
pnpm run smoke:installed-vsix -- --target <target>
```

예를 들어 Apple Silicon Mac에서는 다음과 같다.

```bash
pnpm run package:vsix -- --target darwin-arm64
pnpm run smoke:installed-vsix -- --target darwin-arm64
```

첫 명령은 production bundle, target별 `node-pty` staging, native header와 PTY smoke,
VSIX 생성 및 ZIP archive 검사를 수행한다. 두 번째 명령은 기본적으로 VS Code `1.125.0`의 clean
profile에 생성된 VSIX를 설치하고 실제 Extension Host에서 module resolution, PTY
input/output, resize와 정상 종료를 확인한다. 이어서 disposable Codex-compatible process를 실제
Canvas에서 선택해 세 MCP Tool, Host/lease/Graph 경로, Webview Activity binding/effect DOM,
continuous CSS animation과 clear 후 제거까지 검증한다.

현재 Stable 또는 Insiders Host를 지정하려면 같은 명령에 version을 추가한다.

```bash
pnpm run smoke:installed-vsix -- --target <target> --vscode-version stable
pnpm run smoke:installed-vsix -- --target <target> --vscode-version insiders
```

Linux에서는 packaging 후 ABI baseline도 확인한다.

```bash
pnpm run verify:linux-abi
```

### 6. 빠른 문제 해결

| 증상 | 확인할 내용 |
| --- | --- |
| `Unsupported engine` | `node --version`이 `v24.x`인지 확인한다 |
| lockfile 또는 dependency 불일치 | `pnpm --version`이 `11.18.0`인지 확인하고 `pnpm install --frozen-lockfile`을 다시 실행한다 |
| `CRISPY_VSIX_TARGET is required` | 직접 `vsce package`를 실행하지 말고 `pnpm run package:vsix -- --target <target>`을 사용한다 |
| `cross packaging is not supported` | 현재 host와 같은 target을 지정한다 |
| `workspace_untrusted` | Workspace Trust를 복구한 뒤 보존된 session에서 다시 시도한다 |
| `workspace_root_unavailable` | Reset 없이 root를 바꾸지 말고, 선택했던 local folder를 Workspace에 다시 추가한 뒤 재시도한다 |
| `codex: command not found` | 일반 Terminal과 VS Code Extension Host가 같은 `PATH`에서 Codex CLI를 찾는지 확인한다 |
| Windows에서 `codex.ps1` 또는 `claude.ps1` 실행 정책 오류 | 최신 코드를 받은 뒤 다시 실행한다. Crispy가 `.cmd`와 `.exe` 후보를 차례로 검사한다 |
| `claude: command not found` 또는 Windows의 `not recognized` | VS Code Extension Host의 `PATH`에서 native Claude Code를 찾는지 확인한다 |
| Windows에서 잘못된 Claude가 실행됨 | `Get-Command claude -All`로 해석 순서를 확인하고 `crispy.claudeCliPath`에 원하는 executable 전체 경로를 지정한다 |
| `node-pty` load 실패 | 수동 rebuild/chmod 대신 Node 24에서 `pnpm install --frozen-lockfile`을 다시 실행한다 |
| 테스트용 VS Code 다운로드 실패 | npm registry와 VS Code update server에 접근 가능한지 확인한다 |

Agent 탭과 Terminal 세션을 담당한다.

탭은 Webview가, 세션과 실행 계약은 Extension Host가 소유한다. Webview는 `tabId`,
`providerId`와 Host가 제공한 `workspaceRootId`만 round-trip하고, 실행 파일·인자·환경·작업
디렉터리·URI·PID는 언제나 Host가 결정한다.

## 구조

```text
src/agent/
├── UI/
├── host/
├── protocol/
└── webview/
```

### `protocol/`

> Host와 Webview가 공유하는 메시지 계약과 runtime validator를 정의합니다.

- 메시지 type과 필드 계약을 단일 schema registry로 관리하고 TypeScript union을 여기서 추론
- `executable`, `args`, `env`, `cwd`, `path`, `uri`, `fsPath`, `workspaceRoot`, `workspace`,
  `root`, `pid` 등 Host 전용 필드는 Webview 방향에서 거부
- `providerId`는 `PROVIDER_IDS` allowlist 밖이면 `provider_not_allowed`로 거부

### `host/`

> 세션 lifecycle, 실행 정책과 provider 자동 실행을 담당합니다.

- `terminal/terminalHost.ts`가 탭 등록, 탭별 세션 Map, 입력·크기·재시작 routing을 관리
- `agent/agentProviderLaunch.ts`가 provider별 자동 실행 커맨드를 소유

### `UI/`

> 상단 bar, 탭 strip, xterm 중앙 Workspace/provider 선택기와 실행 중 Workspace
> 하단 status bar 등 Agent 영역 UI를 구성합니다.

- Workspace 선택은 Webview가 그리는 combobox/listbox를 사용해 플랫폼 native dropdown
  모양에 의존하지 않고, root 이름과 경로를 분리해 긴 항목을 말줄임 처리한다.
- provider assignment가 commit된 활성 탭에서는 Terminal 바깥 하단 status bar에
  `workspaceName`만 표시한다. 탭 전환 시 해당 세션 이름으로 바뀌고 Reset 완료 시 숨긴다.

### `webview/`

> 탭별 xterm 표면을 만들고 Host 메시지를 해당 탭으로만 전달합니다.

## 탭과 세션 흐름

| 동작 | 메시지 | Host 처리 |
| --- | --- | --- |
| `+` 버튼 | `tab.create` | 탭만 등록하고 세션은 만들지 않는다 |
| 탭 전환 | `tab.switch` | 활성 탭만 기록한다 |
| Workspace/provider 선택 | `agent.switch` | fresh root preflight 후 불변 assignment를 commit하고 `agent.switchAccepted`를 보낸다 |
| `⟳` 후 재시작 확인 | `agent.reset` | 현재 세션과 xterm을 정리하고 같은 탭을 provider 미선택 상태로 되돌린다 |
| retryable MCP 실패의 `MCP와 Agent 다시 시작` | `mcp.restart` | current tab/session의 Codex 또는 Claude와 MCP를 정리한 뒤 같은 provider로 fresh session을 시작한다 |
| 탭 닫기 확인 | `tab.close` | 세션을 정리하고 탭 등록을 해제한다 |
| 표면 준비 | `terminal.ready` | 크기를 기록하고 provider가 있으면 세션을 시작한다 |

`terminal.ready`와 `agent.switch` 중 나중에 도착한 쪽이 첫 세션 시작을 유발한다. provider가
정해지지 않은 탭에서는 어떤 경우에도 PTY를 만들지 않는다.

Graph와 Workspace Picker는 하나의 atomic `WorkspacePresentation` snapshot을 사용하지만, 이
presentation은 실행 권한이 아니다. Host는 시작, 일반 재시작, MCP 재시작, structured/bare
fallback과 native spawn 직전에 현재 `workspaceFolders`와 Trust를 다시 읽는다. Workspace
정책 실패는 provider fallback으로 전환하지 않고 안전한 Workspace 오류로 종료한다.

## Codex/Claude MCP 상태와 명시적 재시작

Codex와 Claude 탭의 MCP indicator는 탭별 current `tabId`와 Host 소유 `sessionId`가 모두 일치할
때만 반영된다. 준비 중이거나 아직 요청이 오지 않은 상태는 기존 `Starting…` 흐름에
포함되며 별도 indicator가 없다. 요청 silence는 실패가 아니며 timeout 기반의 빨간 상태를
만들지 않는다.

- 각 탭 상단의 초록 점은 정확한 route/token을 사용한 protocol-valid ID-bearing 요청이 정상
  JSON-RPC result를 만든 뒤에만 표시한다. 별도 연결 문구 없이 여러 탭의 상태를 탭별로
  동시에 구분한다.
- 빨간 상태는 current session의 명시적 MCP failure에만 표시하며 raw reason, stderr, 경로,
  인자와 credential을 표시하지 않는다.
- retryable failure에만 `MCP와 Agent 다시 시작` 버튼을 표시한다. non-retryable failure는
  안전한 고정 문구만 표시한다.
- 재시작 확인은 현재 Agent와 CLI 대화가 종료됨을 알린다. 수락하면 old process tree와
  MCP runtime을 먼저 정리한 뒤 fresh sessionId, child, random port/route/token, generation,
  config와 PTY를 만든다.
- CLI가 실행된 뒤 MCP child가 비정상 종료되면 해당 Codex/Claude PTY와 입출력은 유지한다.
  사용자가 확인하기 전에는 bare provider나 새 adapter를 자동 실행하지 않는다.
- 새 session, reset, provider 재선택, 정상 CLI exit, tab close, Panel dispose와 deactivate는
  이전 표시 상태를 지운다. old session/generation의 늦은 status는 fresh 상태를 지울 수 없다.

상단의 기존 `⟳`는 provider 선택 화면으로 돌아가는 generic reset이다. MCP retry는 실행 중
현재 Codex 또는 Claude를 같은 provider로 다시 해석하는 별도 protocol이며 두 동작은 서로 대체하지 않는다.

## provider 자동 실행 정책

Codex와 Claude는 Host가 executable과 version compatibility를 확인한 뒤 provider CLI 자체를
PTY root process로 실행한다. Windows npm-style `.cmd`만 `ComSpec` one-shot wrapper를 사용한다.

| provider | PTY root | 현재 MCP 동작 |
| --- | --- | --- |
| Codex | `codex` 또는 Windows one-shot wrapper | session MCP 자동 준비·연결, 공통 상태/retry UI |
| Claude | `claude` 또는 Windows one-shot wrapper | `>=2.1.121`에서 session MCP 자동 준비·연결, 공통 상태/retry UI |

Codex와 Claude는 공통 `AgentLaunchPlan`, final environment sanitizer, session별 MCP supervisor,
generation gate, direct PTY spawn과 process-tree cleanup을 공유한다. Claude version probe가 실패,
timeout, unparsable이거나 최소 기능 호환 버전 미만이면 MCP child/token/config를 만들지 않고
credential 없는 bare Claude를 실행한다. 이 경우 `provider_update_required`를 emit하지 않는다.

## ANSI 색상 계약

터미널 색은 기여자 환경에 따라 달라지면 안 되므로 양쪽 끝을 모두 고정한다.

**PTY 쪽** — `host/shell/shellResolver.ts`의 `buildShellEnv`가 `TERM=xterm-256color`,
`COLORTERM=truecolor`, `FORCE_COLOR=3`으로 고정한다. `TERM`은 널리 호환되는 xterm 이름을
유지하고, 나머지 두 값으로 xterm.js가 실제 렌더링하는 24bit 색상을 광고한다. 이 값들을
상속에 맡기면 VS Code를 Dock에서 띄웠는지, 터미널에서 `code .`로 띄웠는지, tmux 안에서
띄웠는지에 따라 CLI가 감지하는 색 단계가 달라진다. `NO_COLOR`와 `CLICOLOR=0`처럼 색을
끄는 상속 설정은 제거하고 `TERM_PROGRAM`도 상속하지 않는다.

**팔레트 쪽** — `webview/shellTerminal.ts`의 `readVsCodeAnsiTheme`가 `--vscode-terminal-ansi*`
변수를 `body` → `documentElement` 순서로 조회한다. CSS 변수는 아래로만 상속되므로 VS Code가
주입한 요소와 다른 쪽만 조회하면 값을 전부 놓치고 xterm 기본 팔레트로 조용히 떨어진다.
xterm DOM renderer가 기본 팔레트용 동적 `<style>`과 truecolor용 `style` attribute를 만들기
때문에 Webview CSP는 이 두 style 경계만 inline으로 허용하고 script는 Webview source로
계속 제한한다.

색이 이상할 때는 Crispy 터미널에서 `echo $TERM; echo "[$COLORTERM]"; tput colors`로 PTY 쪽을,
`Developer: Open Webview Developer Tools` 콘솔에서
`getComputedStyle(document.body).getPropertyValue('--vscode-terminal-ansiRed')`로 팔레트 쪽을
각각 확인한다.

## Claude MCP Phase L1 검증 기록 — 2026-08-22

L1은 TerminalHost 자동 실행에 연결하지 않고 `src/mcp/**`의 session-only inline serializer,
bare/authenticated launch plan, bounded version probe, managed-policy diagnostic과 node-pty 수동
smoke까지만 구현한다. Claude config는 `type: "http"`, loopback URL, literal
`Bearer ${CRISPY_MCP_TOKEN}`, `alwaysLoad: true`만 포함한다. `--strict-mcp-config`, discovery-cache
override, broad tool deny 또는 user MCP를 제외하는 설정은 넣지 않는다.

기술적 최소 기능 호환 버전은 `2.1.121`로 확정했다. 공식
[Claude Code changelog](https://code.claude.com/docs/en/changelog)는 이 버전에서 config-level
`alwaysLoad`를 추가했다고 기록한다. macOS Apple Silicon에서 아래 두 binary로 같은 검증을
실행했다.

| binary | 결과 |
| --- | --- |
| 현재 사용자 설치 `2.1.234` | inline config 인식, header env expansion, `crispy_ping`, authenticated activity 성공; token env 제거 시 자연 종료까지 authenticated activity 없음 |
| 격리한 공식 `2.1.121` | 기존 실행에서 위와 동일한 positive 결과 및 token-env 제거 시 authenticated activity 미관찰 |

`2.1.121`은 사용자 설치를 덮어쓰지 않고 `/tmp`에 다운로드했다. 공식 manifest의
`darwin-arm64` SHA-256 `3810e55d47ed4d413de6dc037e34d58948f779a4c6bdeeacf1748d850c5daad6`과
binary checksum이 일치한 뒤 실행했다. smoke의 exact `--allowedTools` 값은 random Crispy server의
`crispy_ping` 하나를 non-interactive run에서 승인하기 위한 진단 전용 값이다. 제품 serializer와
후속 L2 launch에는 이 flag를 넣지 않으며 다른 user MCP를 deny하거나 숨기지 않는다.

Token 없는 intentionally-invalid inline server 대조에서는 `2.1.234`가 잘못된 entry를 건너뛰고
계속 실행했으며, `2.1.121`은 prompt 전에 `Invalid MCP configuration`의 고정 schema rejection으로
종료했다. diagnostic은 broad 문구가 아니라 non-zero exit, prompt 미도달, 두 줄의 exact 문구와
current random server name이 모두 일치할 때만 `provider_config_rejected`로 분류한다. 공식 managed
MCP workstation rejection도 문서의 exact 문구가 일치할 때만 `provider_policy_blocked`로 분류한다.

```bash
pnpm run prepare:claude-mcp-smoke
pnpm run smoke:claude-mcp
pnpm run smoke:claude-mcp -- --claude-executable /path/to/isolated/claude
```

정상 실행은 각 positive/negative transaction에서 `version_compatible`, `adapter_ready`,
`awaiting_activity` 뒤 각각 `lifecycle_observed`, `negative_control_no_authenticated_activity`를 출력한다.
positive는 planned anchor, 두 active child, 두 clear와 마지막 completed anchor를 모두 확인하고 provider가
정상 종료한 뒤에만 통과한다.
후자는 token env가 없는 Claude의 자연 종료까지 authenticated activity가 없었다는 뜻이며 exit code,
config rejection 또는 HTTP `401` 관찰을 뜻하지 않는다. signal 종료는
`failed:negative_control_inconclusive`다. token, URL, route와 inline config는 출력하지 않는다.
version probe 실패·timeout·unparsable 또는 최소 미만은
credential/config를 만들지 않고 L2에서 bare Claude로 fail-open할 근거만 반환한다.
`provider_update_required` emit과 사용자-visible 업데이트 안내는 여전히 별도 제품 결정이다.

## Claude MCP Phase L2 자동 실행 기록 — 2026-08-22

L2는 Claude 선택을 `executable resolve → bounded version probe → adapter ready → auth registered →
inline config plan → final environment sanitizer → direct PTY spawn` transaction에 연결한다. 각 await
뒤 current tab/session/provider를 다시 확인하므로 probe나 adapter 준비 중 reset, provider 변경,
tab close가 발생한 stale attempt는 Claude PTY나 MCP credential을 만들지 않는다.

Authenticated spawn이 실패하면 token과 child를 정리한 뒤 같은 resolved executable로 bare Claude를
최대 한 번 실행한다. 두 spawn이 모두 실패하면 세 번째 시도 없이 `start_failed`로 끝난다. 실행 전
adapter crash도 bare로 전환하지만 실행 후 crash는 Claude PTY와 Terminal 입출력을 유지하고 token과
adapter ownership만 정리한다.

자동 bare relaunch는 non-zero exit, signal 없음, interactive input/authenticated activity 미관찰과
exact managed-policy 또는 current session server의 exact schema diagnostic이 모두 일치할 때만 한 번
수행한다. 정상 종료, login/auth, 일반 network 오류와 MCP request silence는 relaunch 근거가 아니다.
L2는 Claude 상태 indicator와 MCP 재시작 UI를 아직 연결하지 않으며 해당 범위는 L3 gate로 남긴다.

## Claude MCP Phase L3/L4 상태와 최종 범위 — 2026-08-22

L3에서 Claude를 위의 공통 MCP 상태와 명시적 재시작 경계에 연결했다. authenticated activity 전에는
indicator가 없고 정상 result 뒤에만 초록, current session의 명시적 failure에만 빨강을 표시한다.
retryable failure에서 사용자 확인을 받으면 현재 Claude 탭만 fresh session/child/port/route/token/
config/PTY로 교체하며 Codex와 다른 Claude 탭은 유지한다. Host와 Webview가 각각 중복 요청을 막고
old session/generation의 늦은 event는 current 상태를 변경하지 못한다.

L4에서는 Claude `2.1.121` inclusive minimum, 현재 설치 `2.1.239`, minimum 미만과 version probe
실패/timeout/unparsable fake case를 포함해 Codex/Claude 공통 lifecycle 회귀를 다시 검증한다.
최신 CLI의 credential-free version/config surface는 macOS 15, Ubuntu 24.04, Windows 2025 scheduled
workflow에서 계속 확인하고, authenticated header expansion과 `crispy_ping`은 로그인된 provider
smoke로 분리한다. 상세 명령, 실기 결과와 OS별 `not_run` 기록은 `../mcp/README.md`를 따른다.

이 L3/L4 기록 시점에는 Graph report tool/state를 연결하지 않았다. 이후 2026-08-26 Phase 5에서
아래 VS Code Host capability gate를 통해 Codex/Claude Agent Activity와 Graph/Store 연결을 추가했다.

## Codex/Claude Agent Activity production 연결 — 2026-08-26

Extension은 activation 때 `vscode.version`을 strict canonical version으로 한 번 parse한다.
`AGENT_ACTIVITY_MINIMUM_VSCODE_VERSION`은 `1.125.0`이며 stable Host는 `2.0.0` 전까지 지원한다.
prerelease는 core version이 minimum stable보다 새 버전일 때만 허용하고, malformed, 구버전,
minimum prerelease와 next major는 false다. 이 경계는 manifest의 `engines.vscode: ^1.125.0` stable
지원 범위와 맞춘다. provider, child, environment, setting과 persisted session은 Host가 capture한
boolean을 바꿀 수 없다.

true이면 Codex의 session-only `enabled_tools`와 request-local MCP 등록에 다음 세 Tool이 exact
순서로 들어간다.

```text
crispy_ping
crispy_saa
crispy_caa
```

Codex capability true에서는 MCP initialize `instructions`와 동일한 공통 계약을
`developer_instructions` CLI override로도 주입한다. 이는 MCP server text만 보았을 때 provider가
Workspace prompt injection으로 오인하는 경로를 피하고, Crispy Host가 승인한 세션 UI 계측임을
명확히 하기 위한 것이다. `model_instructions_file`은 설정하지 않으므로 built-in/`AGENTS.md` 경로는
교체하지 않는다. capability false에서는 Activity 지시를 주입하지 않는다.

Claude는 기존 inline `type: "http"`, URL/header placeholder와 `alwaysLoad: true` shape를 유지하고
같은 세 Tool을 server에서 노출한다. Codex와 Claude는 server의 initialize `instructions`를 공통
도구 workflow로 사용하고, 각각 `developer_instructions`와 `--append-system-prompt`에서 정확히 같은
Host 승인 계약을 받는다. 계약 첫 표식은 `[REQUIRED FOR USER-VISIBLE GRAPH]`이며 호출이 사용자 선택
그래프의 필수 시각 계측이고 파일·범위·권한을 변경하지 않는다고 밝힌다. completion roll-up은 provider
공통 규약이다. false이면 두 provider 모두 `crispy_ping`만 노출하고 initialize instructions에도 Activity Tool
이름이나 사용법을 넣지 않는다. `crispy_ping`의 legacy `mode: "observation-only"`는 ping 응답 전용이며
server 전체 capability 설명이 아니다.

true의 initialize instructions는 assigned root 상대 path만 사용하게 한다. root는 `.`과
`targetKind: "folder"`로 나타내고 target kind는 `file`/`folder`, activity는 `planned`, `active`,
`editing`, `completed`, `mentioned`, `rejected` 중 하나다. Agent가 반드시 보고하는 lifecycle은 다음과 같다.

- `planned`: workspace operation 전에 작업 전체를 포함하는 completion anchor에 가장 먼저 설정하는 상태
- `active`: 읽기·분석·검색·검증·테스트를 시작하기 전에 보고하는 상태
- `editing`: 파일이나 폴더를 실제로 생성·수정·삭제하기 전에 보고하는 상태
- `mentioned`: Codex 또는 Claude가 자신의 자연어 응답에서 workspace 파일이나 폴더를 언급하기 전에 보고하는 상태.
  단, Target×Session에는 한 상태만 저장되므로 기존 `planned`/`active`/`editing`/`completed`/`rejected`를
  단순 언급 때문에 `mentioned`로 downgrade하지 않는다.
- `completed`: 대상 작업과 필요한 검증이 성공한 상태
- `rejected`: 범위·안전·선행조건 때문에 의도적으로 취소하거나 건너뛴 상태. 일반 Tool 오류에는
  사용하지 않는다.

모든 호환 Agent는 요청 시작 시 작업 전체를 포함하는 가장 좁은 공통 target을 completion anchor로
정한다. 작업 중에는 서로 다른 의미 있는 하위 target을 작업 전에 반드시 표시하지만, 같은 target/state의
반복 command나 access에는 다시 호출하지 않는다. 전체 요청이 성공하면 최종 응답 전에 anchor가 아닌 이번 요청의
target을 깊은 순서부터 `crispy_caa`로 지우고 마지막 Activity 호출로 anchor만 `completed`로 바꾼다.
최종 완료 응답에서 하위 경로를 언급해도 `mentioned` marker를 다시 만들지 않으며, 다른 요청이나 범위의
target은 이 roll-up에 포함하지 않는다. roll-up 전에 최종 응답을 시작하거나 anchor `completed` 뒤에
Activity를 더 호출하면 lifecycle 검증이 실패한다. 필수 lifecycle 호출 하나라도 빠지면 작업 결과와
무관하게 smoke는 실패한다.

`mentioned`, `completed`, `rejected`는 현재 응답 동안 유지하고 즉시 clear하지 않는다. 다음 사용자
요청이나 범위 변경, 대상의 관련성 상실, rename/delete로 marker가 무효가 된 때 clear한다. 모든
command/file access를 보고하지 않고 의미 있는 주 작업 대상과 상태 전환만 호출하며, 넓은 작업에만
folder/root를 사용한다. `crispy_ping`은 startup/restart 또는 명시적인 연결 진단에만 사용한다.
Activity는 agent가 필수 정책에 따라 명시적으로 보고하며 PTY output이나 filesystem change에서 추론하지
않는다. Host는 PTY prose를 파싱하지 않고 실제 provider smoke가 자연어 파일 읽기에서 자율 `saa` 호출을
검증한다. Tool이 root/session/runtime/URI/token/internal identity를 제공하거나 선택하는 필드는
없다. 축약된 `crispy_saa`/`crispy_caa`는 Claude의 완전한 MCP Tool 이름을 64자 이하로 유지한다.

Tool success는 MCP child의 handoff 수락까지만 의미한다. exact lease, selected-root validation,
Host quota, Webview delivery, Store 적용과 화면 표시의 ACK가 아니다. `postMessage: true`도 같은
이유로 delivery proof가 아니며 tracked clear receipt는 Host occupancy/quota 정산에만 사용한다.
cleanup은 lease revoke 뒤 best-effort `clearSession`을 보내므로 Webview 반영을 보장하지 않는다.

Codex config에는 `CRISPY_MCP_TOKEN` environment 변수 이름만, Claude inline header에는 literal
`${CRISPY_MCP_TOKEN}` placeholder만 들어간다. token 값은 final PTY spawn environment에서만 합성하며
argv, config, setting, Webview state, log와 telemetry에는 넣지 않는다.

Graph 연결의 현재 제약은 다음과 같다.

- set의 bounded Node path walk는 fail-closed하지만 atomic하지 않아 TOCTOU 가능성이 남는다.
- 같은 Panel의 `postMessage` invocation FIFO를 pinned assumption으로 사용한다. Promise settlement
  순서가 뒤집혀도 wire 순서를 바꾸지 않으며 public sequence는 추가하지 않는다.
- 지원 범위 밖에서는 Activity lease, bridge, receipt/quota와 cleanup state 자체를 만들지 않는다.
- 끝나지 않는 validation/post work는 고정 cap 안에서 detach하고 quota를 낙관적으로 반환하지 않는다.

minimum, current Stable과 current Insiders Host에서 parser와 gate true/false config, Codex
Project/User instruction 보존, 공통 initialize instructions와 Claude의 동일 공통 prompt,
ping과 credential placeholder 회귀, HTTP→SDK→IPC→Supervisor→Terminal lease→selected-root
Graph→Webview Store→receipt/quota full chain, settlement 역전/FIFO, multi-root 및
Trust/root/restart lifecycle, unsupported zero-state를 검증한다. 이어서 실제 Codex/Claude smoke와
해당 native VSIX smoke를 실행하고 환경과 미실행 항목을 기록한다. minimum 또는 major boundary를
바꿀 때에는 manifest와 capability constant를 함께 갱신한다. 상세 명령과 진단은
`../mcp/README.md`, repository `README.md`, `SUPPORT.md`를 따른다.

## Task Work provider instructions — 2026-08-27

Task 소유 ordinary Agent tab의 사용자 prompt는 Task 내용과 배정 영역을 그대로 전달하고, Codex와
Claude 모두 마지막 문단으로 `crispy_task_complete` 호출 reminder를 한 번 덧붙인다. 이전처럼 긴
`CRISPY TASK EXECUTION CONTRACT`를 사용자 prompt에 합치지 않는다. Terminal Host는 Task lease와
동일한 조건으로 Codex launch plan의 `taskToolCompatible`, Claude launch plan의
`taskToolCompatible`을 설정한다. 그 결과 Task 완료·영역 요청·영역 결과 규약이 MCP initialize와
같은 공통 source에서 Codex `developer_instructions` 및 Claude `--append-system-prompt`로 주입된다.

공통 system 규약은 lifecycle 전체를 소유하고, 사용자 prompt 끝의 짧은 reminder는 Agent가 완료를
자연어 응답으로만 끝내지 않도록 terminal action을 가까운 위치에서 반복한다. reminder는 성공 시
`completed`, 의도적인 범위/사용자 거절 시 `rejected`와 요약을 보내고 accepted Tool call 전에는 Work가
끝나지 않는다고 명시한다. Task가 아닌 tab의 prompt는 바뀌지 않는다.

Claude의 완전한 MCP Tool 이름은 64자 이하여야 한다. 따라서 Claude session server 이름은
`crispy_<24 hex>`로 생성하고, Task permission allowlist를 만들 때 `mcp__<server>__<tool>` 전체 길이를
검증한다. 이 경계에서 `crispy_task_complete`, scope request와 scope result는 각각 58, 63, 62자로
노출된다. 이전 `crispy_canvas_<32 hex>` 이름은 같은 도구를 73~78자로 만들어 Claude가 Task Tool을
모델에 제공하지 못하는 원인이었다. Codex의 session server naming과 Task 실행 경로에는 영향이 없다.

## Task Work provider turn lifecycle — 2026-08-27

Task 완료는 계속 accepted `crispy_task_complete` Tool 호출만으로 확정한다. 응답 종료 자체를 작업
완료로 추론하지 않는다. 대신 Task가 소유한 현재 ordinary Agent tab 안에서 provider별 turn 종료를
관찰해, 자연어 응답만 끝난 경우 같은 세션에 completion 후속 지시를 최대 두 번 전달한다. 세 번째
누락이나 provider API 실패는 Work 실패로 보고하며 scheduler를 진행시키지 않는다.

Codex Task launch는 session-only TUI config로 `agent-turn-complete` OSC 9 알림을 켠다. Terminal Host는
해당 PTY 출력만 파싱하고 250ms grace 뒤 같은 PTY에 후속 입력을 쓴다. grace 안에 exact MCP completion
IPC가 먼저 오면 예약 입력을 취소한다. Claude Task launch는 같은 session MCP child의 bearer 인증
loopback route를 `Stop`/`StopFailure` HTTP hook으로 설정한다. Stop hook은 child가 이미 관찰한 completion
또는 pending scope를 존중하고, 그 외에는 provider-native `decision: block`과 `reason`으로 후속 지시를
반환한다. 이 형식은 기존 Claude 최소 호환 버전에서도 지원된다.
별도 app server, Agent SDK, background Agent process는 만들지 않는다.

모든 Claude lifecycle IPC는 generation, session, execution, Work identity를 포함하며 Supervisor와
Terminal Host에서 exact lease와 다시 대조한다. scope request가 미결인 동안 들어온 completion은
terminal completion으로 인정하지 않는다. 일반 Agent tab에는 OSC 알림 설정과 Claude hook을 주입하지
않으며 기존 session lifecycle을 그대로 사용한다.
