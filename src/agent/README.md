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

### 3. Codex, Claude와 Antigravity CLI 준비

세 provider는 Crispy가 새 Terminal을 만든 뒤 같은 Shell PTY 경로에서 각각의 CLI를 자동
실행한다. macOS/Linux에서는 `codex`, `claude` 또는 `agy`를 기본으로 사용한다. Windows에서는
실제 PowerShell에서 `--version`을 실행해 Codex는 `codex`, `codex.cmd`, `codex.exe`, Claude는
`claude`, `claude.cmd`, `claude.exe`, Antigravity는 `agy`, `agy.cmd`, `agy.exe` 순으로 첫 성공
후보를 선택한다. 사용할 CLI가 팀원의 머신에 설치되어 있고 VS Code Extension Host가 상속한
`PATH`에서도 resolve되어야 한다.

자동 탐색으로 찾을 수 없는 설치는 VS Code Settings의 `crispy.codexCliPath` 또는
`crispy.claudeCliPath`, `crispy.antigravityCliPath`에 executable 전체 경로를 지정한다. 설정한
경로를 가장 먼저 검증하며, 검증에 실패하면 같은 provider의 기본 후보를 계속 탐색한다.

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

#### Antigravity

macOS/Linux에서는 공식 installer를 사용한다. 기본 설치 위치는 `~/.local/bin/agy`다.

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy --version
command -v agy
```

Windows PowerShell에서는 다음 installer를 사용한다.

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

Windows CMD에서는 installer를 내려받아 실행한 뒤 삭제한다.

```batch
curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Windows 기본 설치 디렉터리는 `%LOCALAPPDATA%\agy\bin`이며 일반적으로
`C:\Users\<Username>\AppData\Local\agy\bin`에 해당한다. 설치 후 PowerShell에서 실제 해석
순서와 버전을 확인한다.

```powershell
Get-Command agy -All
Get-Command agy.exe -All
agy --version
```

원하는 실행 파일을 자동 탐색하지 못하면 `crispy.antigravityCliPath`에 전체 executable 경로를
지정한다. 최신 설치 방법은 [Antigravity CLI 설치 문서](https://antigravity.google/docs/cli/install)와
[공식 저장소](https://github.com/google-antigravity/antigravity-cli)를 따른다.

#### 설치 및 인증 오류

Crispy는 Windows 후보 선택에 필요한 `--version` 성공 여부만 검사하며 CLI를 설치하거나
인증 상태를 판별하지 않는다. 모든 후보가 실패하면 문서 기준 기본 이름을 Shell에 입력해
`command not found` 또는 `not recognized` 출력을 그대로 표시한다. Claude Code나 Antigravity가
Google 로그인, workspace trust 또는 초기 설정을 요구하면 기존 PTY/xterm.js 화면에서 사용자가
직접 진행한다. Crispy는 CLI의 설치 여부, version 또는 인증 상태를 사전에 보장하지 않으며
OAuth, API key, Google 계정 또는 provider credential을 저장하거나 처리하지 않는다.

### 4. Extension Development Host 실행

1. VS Code에서 Crispy repository root를 연다.
2. `Run and Debug`에서 `Run Extension`을 선택하거나 `F5`를 누른다.
3. 기본 build task가 TypeScript와 esbuild watch를 시작할 때까지 기다린다.
4. 새로 열린 Extension Development Host에서 테스트할 **로컬 단일 root 폴더**를 연다.
5. Workspace Trust 요청이 나오면 신뢰할 수 있는 테스트 폴더에 한해 승인한다.
6. Command Palette에서 `Crispy: Open Canvas`를 실행한다.
7. Agent 영역에서 새 탭을 만들거나 현재 탭의 provider로 `Codex`, `Claude` 또는
   `Antigravity`를 선택한다.

현재 Terminal 시작 정책은 trusted, single-root, local file workspace만 허용한다. 다음
환경에서는 PTY 시작이 거부된다.

- 폴더를 열지 않은 빈 window
- untrusted workspace
- multi-root workspace
- virtual 또는 remote workspace

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
- 탭별 Terminal routing
- provider 선택과 Codex/Claude/Antigravity 자동 실행 입력
- PTY input/output, resize, restart와 cleanup
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

Codex CLI가 로그인되어 있어야 한다. 정상 실행은 아래 세 상태만 출력하며 authenticated MCP
activity를 관찰한 뒤 Codex와 adapter를 정리한다.

```text
adapter_ready
awaiting_activity
activity_observed
```

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
VSIX 생성 및 ZIP archive 검사를 수행한다. 두 번째 명령은 VS Code `1.125.0`의 clean
profile에 생성된 VSIX를 설치하고 실제 Extension Host에서 module resolution, PTY
input/output, resize와 정상 종료를 확인한다.

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
| `workspace_untrusted` 또는 workspace 오류 | trusted single-root local folder를 연다 |
| `codex: command not found` | 일반 Terminal과 VS Code Extension Host가 같은 `PATH`에서 Codex CLI를 찾는지 확인한다 |
| Windows에서 `codex.ps1` 또는 `claude.ps1` 실행 정책 오류 | 최신 코드를 받은 뒤 다시 실행한다. Crispy가 `.cmd`와 `.exe` 후보를 차례로 검사한다 |
| `claude: command not found` 또는 Windows의 `not recognized` | VS Code Extension Host의 `PATH`에서 native Claude Code를 찾는지 확인한다 |
| Windows에서 잘못된 Claude가 실행됨 | `Get-Command claude -All`로 해석 순서를 확인하고 `crispy.claudeCliPath`에 원하는 executable 전체 경로를 지정한다 |
| `agy: command not found` 또는 Windows의 `not recognized` | VS Code Extension Host의 `PATH`에서 `agy`가 resolve되는지 `command -v agy` 또는 `Get-Command agy -All`로 확인한다 |
| Windows에서 잘못된 Antigravity가 실행됨 | `Get-Command agy -All`로 해석 순서를 확인하고 `crispy.antigravityCliPath`에 원하는 executable 전체 경로를 지정한다 |
| `node-pty` load 실패 | 수동 rebuild/chmod 대신 Node 24에서 `pnpm install --frozen-lockfile`을 다시 실행한다 |
| 테스트용 VS Code 다운로드 실패 | npm registry와 VS Code update server에 접근 가능한지 확인한다 |

Agent 탭과 Terminal 세션을 담당한다.

탭은 Webview가, 세션과 실행 계약은 Extension Host가 소유한다. Webview는 `tabId`와
`providerId`만 지정하고, 실행 파일·인자·환경·작업 디렉터리·PID는 언제나 Host가 결정한다.

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
- `executable`, `args`, `env`, `cwd`, `pid` 등 Host 전용 필드는 Webview 방향에서 거부
- `providerId`는 `PROVIDER_IDS` allowlist 밖이면 `provider_not_allowed`로 거부

### `host/`

> 세션 lifecycle, 실행 정책과 provider 자동 실행을 담당합니다.

- `terminal/terminalHost.ts`가 탭 등록, 탭별 세션 Map, 입력·크기·재시작 routing을 관리
- `agent/agentProviderLaunch.ts`가 provider별 자동 실행 커맨드를 소유

### `UI/`

> 상단 bar, 탭 strip과 xterm 중앙 provider 선택기 등 Agent 영역 UI를 구성합니다.

### `webview/`

> 탭별 xterm 표면을 만들고 Host 메시지를 해당 탭으로만 전달합니다.

## 탭과 세션 흐름

| 동작 | 메시지 | Host 처리 |
| --- | --- | --- |
| `+` 버튼 | `tab.create` | 탭만 등록하고 세션은 만들지 않는다 |
| 탭 전환 | `tab.switch` | 활성 탭만 기록한다 |
| 중앙 목록의 provider 선택 | `agent.switch` | provider를 기록하고 세션을 시작한다 |
| `⟳` 후 재시작 확인 | `agent.reset` | 현재 세션과 xterm을 정리하고 같은 탭을 provider 미선택 상태로 되돌린다 |
| retryable MCP 실패의 `MCP와 Agent 다시 시작` | `mcp.restart` | current tab/session의 Codex 또는 Claude와 MCP를 정리한 뒤 같은 provider로 fresh session을 시작한다 |
| 탭 닫기 확인 | `tab.close` | 세션을 정리하고 탭 등록을 해제한다 |
| 표면 준비 | `terminal.ready` | 크기를 기록하고 provider가 있으면 세션을 시작한다 |

`terminal.ready`와 `agent.switch` 중 나중에 도착한 쪽이 첫 세션 시작을 유발한다. provider가
정해지지 않은 탭에서는 어떤 경우에도 PTY를 만들지 않는다.

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
Antigravity는 현재 MCP 범위 밖이므로 기존 기본 Shell을 시작한 뒤 `agy` 입력을 전달한다.

| provider | PTY root | 현재 MCP 동작 |
| --- | --- | --- |
| Codex | `codex` 또는 Windows one-shot wrapper | session MCP 자동 준비·연결, 공통 상태/retry UI |
| Claude | `claude` 또는 Windows one-shot wrapper | `>=2.1.121`에서 session MCP 자동 준비·연결, 공통 상태/retry UI |
| Antigravity | 기존 interactive Shell | `agy` 자동 입력, MCP config/token 주입 없음 |

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
`awaiting_activity` 뒤 각각 `activity_observed`, `negative_control_no_authenticated_activity`를 출력한다.
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
