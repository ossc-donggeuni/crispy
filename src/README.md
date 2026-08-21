# `src/`

VS Code Extension Host와 Webview에서 실행되는 소스 코드를 관리한다.

Extension Host는 `WebviewPanel`의 생명 주기와 마지막 Webview snapshot을 관리한다.

## 구조

```text
src/
├── agent/
├── test/
├── webview/
├── README.md
├── extension.ts
└── messages.ts
```

### `webview/`

> Webview의 화면 구성과 사용자 상호작용을 담당합니다.

- Webview 진입점과 스타일 관리
- Graph와 Agent Chat 영역 구성
- Project / Folder / File Multi-Root Graph와 Root Promotion / Reattach 처리
- Backlink 및 Context Label 기반 양방향 Camera Focus
- Panel과 Graph Runtime State 관리
- Panel/Camera Session과 Workspace Graph 상태 snapshot 저장 경계
- Agent Chat Panel의 Dock 및 Resize 처리
- 세부 구조와 동작은 `webview/README.md` 참고

### `extension.ts`

> Extension의 활성화와 비활성화 및 WebviewPanel의 생명 주기를 관리합니다.

- `crispy.openCanvas` Command 등록
- 기존 `WebviewPanel` 표시 또는 새 Panel 생성
- Webview HTML 구성
- 빌드된 CSS와 JavaScript 리소스 연결
- Webview 메시지 수신 및 응답
- 유효한 `webview.stateChanged`와 `workspace.stateChanged` snapshot을 Host 메모리에 병합
- Panel 재생성 시 마지막 snapshot을 `data-webview-state`로 전달
- `deactivate()` 시 현재 Panel과 마지막 snapshot 정리

### `messages.ts`

> Extension Host와 Webview 사이에서 사용하는 메시지 타입을 정의합니다.

- Session/Workspace 상태 메시지와 Agent / Terminal wire protocol 타입 통합
- Webview state와 Agent / Terminal validation boundary 분리
- `webview.ready`와 `extension.ready` handshake 계약 관리

### `agent/`

> Agent 탭과 Terminal 세션의 프로토콜, 실행 정책과 UI를 담당합니다.

- Host와 Webview가 공유하는 메시지 계약 및 runtime validator
- 탭별 Terminal 세션 lifecycle과 provider 자동 실행 정책
- 세부 구조와 동작은 `agent/README.md` 참고
