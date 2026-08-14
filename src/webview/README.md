# `src/webview/`

하나의 VS Code `WebviewPanel` 안에 Graph 영역과 Agent Chat 영역을 표시한다.

Graph와 Agent Chat은 각각 별도의 VS Code Panel이 아니며, 하나의 Webview 내부에서 CSS Grid로 배치된다.

## 구조

```text
src/webview/
├── graph/
├── panel/
├── README.md
├── webviewState.ts
├── webview.ts
└── webview.css
```

### `webview.ts`

> Webview 를 사용하기 위해 관련 요소들을 초기화하는 진입점입니다.

- VS Code Webview API 단일 획득
- 필요한 DOM 요소 조회
- `restoreWebviewState()`로 전체 초기 상태 복원
- `initialState.panel`을 Panel Runtime State로 분리
- `initialState.graph`로 Graph View와 Graph State Store 초기화
- `webview.stateChanged` 메시지로 같은 전체 snapshot을 Extension Host에 전달
- Dock과 Resize 기능 초기화
- unload 시 Graph State subscription과 Graph View 정리
- 로드 후 ready 메시지 전송

### `webviewState.ts`

> Panel 및 Graph 상태를 하나의 저장 가능한 Webview snapshot으로 다룹니다.

- 전체 snapshot 검증 및 독립 객체 복사
- VS Code Webview `getState()` / `setState()` 연결
- Extension Host가 HTML로 전달하는 초기 상태 직렬화 및 복원
- 저장 상태가 없거나 잘못된 경우 Panel 및 Graph 기본값 적용

### `graph/`

> Graph Runtime State와 Camera 및 View lifecycle을 담당합니다.

- Graph State 조회, 변경 및 구독
- Camera Pan / Zoom과 좌표 변환
- 세부 구조와 동작은 `graph/README.md` 참고

### `panel/`

> Agent Chat Panel의 Runtime Layout 상태와 조정 동작을 담당합니다.

- `left`, `right`, `top`, `bottom` Dock 이동 및 Preview 처리
- Graph와 Agent Chat 사이의 가로·세로 Resize 처리
- 세부 구조와 동작은 `panel/README.md` 참고
