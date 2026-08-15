# `src/agent/`

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
