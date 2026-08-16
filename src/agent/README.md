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

`linux-x64`는 `node-pty`를 source에서 build하므로 Python 3, `make`, C/C++ compiler와
`readelf`를 제공하는 binutils도 필요하다. macOS ARM64와 Windows x64는 현재 고정된
`node-pty` package의 target prebuild를 사용한다.

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

이 명령은 root dependency와 `node-pty@1.1.0`을 설치하고 `postinstall`의
`prepare-node-pty.js`를 실행한다. 지원 환경에서는 별도의 `node-gyp rebuild`나
`chmod`를 수동으로 실행하지 않는다.

설치 직후 기본 검사를 실행해 환경이 정상인지 확인한다.

```bash
pnpm run check-types
pnpm run lint
pnpm run compile
```

### 3. Codex CLI 준비

현재 provider 중 **Codex만 CLI를 자동 실행**한다. Crispy가 새 Terminal을 만든 뒤 Shell에
`codex`를 입력하는 방식이므로, 팀원의 머신에 Codex CLI가 설치되어 있고 VS Code가
상속한 `PATH`에서 `codex`를 찾을 수 있어야 한다.

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

> Claude와 Antigravity는 현재 UI에서 선택하고 PTY 세션을 만들 수 있지만 CLI를 자동으로
> 실행하지 않는다. 선택하면 기본 Shell만 열린다.

### 4. Extension Development Host 실행

1. VS Code에서 Crispy repository root를 연다.
2. `Run and Debug`에서 `Run Extension`을 선택하거나 `F5`를 누른다.
3. 기본 build task가 TypeScript와 esbuild watch를 시작할 때까지 기다린다.
4. 새로 열린 Extension Development Host에서 테스트할 **로컬 단일 root 폴더**를 연다.
5. Workspace Trust 요청이 나오면 신뢰할 수 있는 테스트 폴더에 한해 승인한다.
6. Command Palette에서 `Crispy: Open Canvas`를 실행한다.
7. Agent 영역에서 새 탭을 만들거나 현재 탭의 provider로 `Codex`를 선택한다.

현재 Terminal 시작 정책은 trusted, single-root, local file workspace만 허용한다. 다음
환경에서는 PTY 시작이 거부된다.

- 폴더를 열지 않은 빈 window
- untrusted workspace
- multi-root workspace
- virtual 또는 remote workspace

Codex 선택 후 기본 Shell만 보이거나 `command not found: codex`가 출력되면 Crispy 설치
문제라기보다 Extension Host가 상속한 `PATH` 문제다. VS Code를 완전히 종료한 뒤 Codex
CLI를 찾을 수 있는 Terminal에서 `code .`로 다시 열어 비교한다.

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
- provider 선택과 Codex 자동 실행 입력
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

> 상단 bar, 탭 strip과 하단 provider bar 등 Agent 영역 UI를 구성합니다.

### `webview/`

> 탭별 xterm 표면을 만들고 Host 메시지를 해당 탭으로만 전달합니다.

## 탭과 세션 흐름

| 동작 | 메시지 | Host 처리 |
| --- | --- | --- |
| `+` 버튼 | `tab.create` | 탭만 등록하고 세션은 만들지 않는다 |
| 탭 전환 | `tab.switch` | 활성 탭만 기록한다 |
| provider 선택 / `⟳` | `agent.switch` | provider를 기록하고 세션을 시작 또는 재시작한다 |
| 탭 닫기 확인 | `tab.close` | 세션을 정리하고 탭 등록을 해제한다 |
| 표면 준비 | `terminal.ready` | 크기를 기록하고 provider가 있으면 세션을 시작한다 |

`terminal.ready`와 `agent.switch` 중 나중에 도착한 쪽이 첫 세션 시작을 유발한다. provider가
정해지지 않은 탭에서는 어떤 경우에도 PTY를 만들지 않는다.

## provider 자동 실행 정책

세션은 항상 Host가 정한 기본 Shell로 시작한다. Shell이 실행된 뒤 provider에 자동 실행
커맨드가 정의되어 있으면 Host가 그 커맨드를 Shell 입력으로 그대로 전달한다.

| provider | 자동 실행 |
| --- | --- |
| Codex | Codex CLI를 자동으로 실행한다 |
| Claude | 자동 실행 없이 기본 Shell 상태로 둔다 |
| Antigravity | 자동 실행 없이 기본 Shell 상태로 둔다 |

Claude와 Antigravity는 드롭다운에서 선택할 수 있고 세션도 정상적으로 시작되지만, CLI
자동 실행은 이후 단계에서 Codex와 같은 방식으로 커맨드만 추가해 지원할 예정이다.

## ANSI 색상 계약

터미널 색은 기여자 환경에 따라 달라지면 안 되므로 양쪽 끝을 모두 고정한다.

**PTY 쪽** — `host/shell/shellResolver.ts`의 `buildShellEnv`가 `TERM`과 `FORCE_COLOR`를
256색으로 고정하고, `COLORTERM`과 `TERM_PROGRAM`은 상속하지 않는다. 이 값들을 상속하면
VS Code를 Dock에서 띄웠는지, 터미널에서 `code .`로 띄웠는지, tmux 안에서 띄웠는지에 따라
CLI가 감지하는 색 단계가 달라진다. `NO_COLOR`와 `CLICOLOR=0`처럼 색을 끄는 상속 설정도
제거한다.

`COLORTERM`을 지우는 이유는 별도다. 이 값이 있으면 CLI가 24bit 출력으로 올라가는데,
현재 Terminal은 그 출력을 색 없이 흰색으로만 그린다. 실제로 그릴 수 있는 수준만
광고한다는 뜻이며, 24bit 렌더링이 해결되면 `COLORTERM=truecolor`와 `FORCE_COLOR=3`을
함께 되돌리면 된다.

**팔레트 쪽** — `webview/shellTerminal.ts`의 `readVsCodeAnsiTheme`가 `--vscode-terminal-ansi*`
변수를 `body` → `documentElement` 순서로 조회한다. CSS 변수는 아래로만 상속되므로 VS Code가
주입한 요소와 다른 쪽만 조회하면 값을 전부 놓치고 xterm 기본 팔레트로 조용히 떨어진다.

색이 이상할 때는 Crispy 터미널에서 `echo $TERM; echo "[$COLORTERM]"; tput colors`로 PTY 쪽을,
`Developer: Open Webview Developer Tools` 콘솔에서
`getComputedStyle(document.body).getPropertyValue('--vscode-terminal-ansiRed')`로 팔레트 쪽을
각각 확인한다.
