# `src/agent/`

하나의 Crispy `WebviewPanel` 안에서 workspace root를 작업 디렉터리로 사용하는 shell terminal을 제공한다.

Extension Host가 shell 실행 정책, PTY session 및 process tree를 소유하고, Webview는 xterm 화면과 검증된 입력·크기 변경만 담당한다.

## 구조

```text
src/
└── agent/
    ├── policy.ts
    ├── protocol.ts
    ├── workspace.ts
    ├── host/
    │   ├── hostMessageBuffer.ts
    │   ├── ptySessionManager.ts
    │   └── shellTerminalController.ts
    ├── webview/
    │   ├── shellTerminalView.ts
    │   └── styles.d.ts
    ├── tooling/
    │   ├── prepare-node-pty.mjs
    │   ├── pty-smoke.mjs
    │   └── process-cleanup-smoke.mjs
    ├── fixtures/
    │   ├── terminal-fixture.mjs
    │   └── process-tree-fixture.mjs
    └── test/
```

### `policy.ts`

- 플랫폼별 기본 shell 실행 계약 결정
- Unix에서는 `$SHELL` 또는 `/bin/sh`, Windows에서는 `powershell.exe` 사용
- PTY의 truecolor 및 VS Code terminal 환경 구성
- 입력, 크기, 출력 buffer 및 종료 timeout 제한값 관리

### `protocol.ts`

- Host와 Webview 사이의 terminal 메시지 타입 정의
- Webview의 `ready`, `restart`, `input`, `resize` 요청 검증
- Host의 시작, 출력, 종료 및 오류 메시지 검증
- 허용되지 않은 필드와 범위를 벗어난 입력을 exact allowlist 방식으로 거부
- Webview가 executable, args 또는 cwd를 지정하지 못하도록 실행 권한을 Host에 한정

### `workspace.ts`

- VS Code Workspace Trust 확인
- 하나의 local `file` workspace folder만 허용
- Graph와 terminal이 공유할 workspace root를 PTY의 cwd로 확정
- 지원하지 않는 workspace에는 사용자 표시 오류 반환

### `host/hostMessageBuffer.ts`

- Host 메시지의 FIFO 순서 보존
- 연속된 동일 session 출력을 하나의 메시지로 병합
- 숨겨진 Webview 또는 전송 실패 중에도 메시지 보류
- session별 UTF-8 출력 buffer 크기 계산 및 상한 적용
- 전송 실패한 queue head를 제거하지 않고 다음 전달 때 재시도

### `host/ptySessionManager.ts`

- `node-pty`를 사용한 interactive shell 생성
- Host가 생성한 고유 session ID별 입력, resize 및 종료 상태 관리
- terminal 본문을 제외한 PTY lifecycle만 로그에 기록
- 종료 시 Unix process group에 `SIGHUP`을 보내고, timeout 후 `SIGKILL`로 전환
- Panel 또는 Extension 종료 시 소속 process tree의 실제 종료 확인

### `host/shellTerminalController.ts`

- Crispy Panel 하나와 단일 활성 PTY session 연결
- Webview 메시지 검증 후 현재 session의 입력과 resize만 전달
- shell 시작, 재시작, 출력, 종료 및 오류 상태 조정
- 숨김 Webview의 Host 메시지를 순서 보존 buffer에 저장하고 다시 보일 때 전달
- 보류 출력이 상한을 넘으면 해당 session을 중단하고 복구 가능 오류 표시
- Panel dispose와 Extension deactivate에서 session 및 event 구독 정리

### `webview/shellTerminalView.ts`

- `@xterm/xterm`과 `FitAddon` 초기화
- VS Code terminal 색상 및 editor font 설정 반영
- 사용자 입력과 terminal 크기 변경을 Host에 전달
- Host 출력, 종료 및 오류 메시지를 현재 session에만 반영
- Dock, resize, visibility 및 focus 변경 시 terminal 크기와 화면 복원
- 종료 또는 복구 가능 오류 상태에서 Restart UI 제공

### `tooling/`과 `fixtures/`

- macOS 설치본의 `node-pty` spawn helper 실행 권한 준비
- 실제 PTY의 ANSI, truecolor, alternate screen, Unicode cwd, resize 및 입력 전달 검증
- PTY parent와 child process tree가 함께 종료되는지 smoke test
- smoke test에 사용할 terminal 및 process tree fixture 제공

### `test/`

- shell 정책과 환경 변수 구성
- Host↔Webview protocol allowlist 및 제한값
- workspace trust와 local single-root 제약
- 출력 buffer 순서, 병합, retry 및 overflow 처리
- PTY session 입출력, resize 및 cleanup
- Controller의 session 소유권과 lifecycle
- 실제 VS Code Panel 통합 및 Webview bundle 검증

## 실행 계약

```ts
cwd = trustedSingleFileWorkspaceRoot;
maxBufferedOutputBytes = 8 * 1024 * 1024;
maxInputBytes = 64 * 1024;
minDimension = 1;
maxDimension = 1_000;
gracefulShutdownTimeoutMs = 2_000;
forceShutdownTimeoutMs = 2_000;
```

Webview는 terminal 준비 시 현재 열과 행을 전달하며, Host는 검증된 workspace와 기본 shell 정책으로 session을 한 번만 시작한다. 종료 후에는 기존 session ID를 폐기하고 사용자가 Restart를 선택했을 때 새 session을 생성한다.

Panel이 숨겨진 동안 PTY는 유지된다. 출력은 session별 8 MiB까지 Host 메모리에 보류되며, Panel이 다시 표시되면 원래 순서대로 전달된다.

## 검증 명령

```sh
pnpm test
pnpm run test:agent-pty
pnpm run test:agent-cleanup
```

`test:agent-pty`와 `test:agent-cleanup`은 실제 process와 PTY를 사용하는 smoke test다.
