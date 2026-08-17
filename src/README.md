# `src/`

VS Code Extension Host와 Webview에서 실행되는 소스 코드를 관리한다.

Extension Host는 WebviewPanel의 생명 주기를 담당하며, Webview와 공유 메시지 타입을 통해 통신한다.

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

### `extension.ts`

> Extension의 활성화와 비활성화 및 WebviewPanel의 생명 주기를 관리합니다.

- `crispy.openCanvas` Command 등록
- 기존 `WebviewPanel` 표시 또는 새 Panel 생성
- Webview HTML 구성
- 빌드된 CSS와 JavaScript 리소스 연결
- Webview 메시지 수신 및 응답
- Panel 종료 후 다시 열 때 사용할 마지막 Layout 상태를 Extension Host 메모리에 유지

### `messages.ts`
z
> Extension Host와 Webview 사이에서 사용하는 메시지 타입을 정의합니다.

- Webview에서 Extension Host로 전송하는 `WebviewToExtensionMessage` 정의
- Extension Host에서 Webview로 전송하는 `ExtensionToWebviewMessage` 정의
- `webview.ready`와 `extension.ready` 메시지 계약 관리

### `agent/`

> Agent 탭과 Terminal 세션의 프로토콜, 실행 정책과 UI를 담당합니다.

- Host와 Webview가 공유하는 메시지 계약 및 runtime validator
- 탭별 Terminal 세션 lifecycle과 provider 자동 실행 정책
- 세부 구조와 동작은 `agent/README.md` 참고

### `webview/`

> Webview의 화면 구성과 사용자 상호작용을 담당합니다.

- Webview 진입점과 스타일 관리
- Graph와 Agent Chat 영역 구성
- Agent Chat Panel의 Dock, Resize 및 Layout 상태 관리
- 세부 구조와 동작은 `webview/README.md` 참고
