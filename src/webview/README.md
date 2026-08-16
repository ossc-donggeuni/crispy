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
- `initialState.graph`로 새 Graph View와 Graph State Store 초기화
- Mock Project Layout, Renderer, Camera 및 Navigator 조합
- Graph State 변경 시 Panel 상태와 함께 기존 Webview State 저장
- `webview.stateChanged` 메시지로 같은 전체 snapshot을 Extension Host에 전달
- Dock과 Resize 기능 초기화
- unload 시 Graph State subscription과 Graph View 정리
- 로드 후 ready 메시지 전송

### `webviewState.ts`

> Panel 및 Graph 상태를 하나의 저장 가능한 Webview snapshot으로 다룹니다.

- 전체 snapshot 검증 및 독립 객체 복사
- Camera와 사용자가 이동한 Node의 World 위치 저장
- VS Code Webview `getState()` / `setState()` 연결
- Extension Host가 HTML로 전달하는 초기 상태 직렬화 및 복원
- 저장 상태가 없거나 잘못된 경우 Panel 및 Graph 기본값 적용
- 기존 Camera-only Graph 상태를 빈 `nodePositions`로 호환 복원
- 새 Store와 Graph View를 사용한 Camera 및 일부 Node 위치 복원

### `graph/`

> Project Tree Graph의 Model, Layout, Renderer, Runtime State와 Camera 및 View lifecycle을 담당합니다.

- 안정적인 ID 기반 Project / Folder / File 모델과 고정 Mock Data
- 왼쪽에서 오른쪽으로 배치하는 deterministic Tree Layout
- Root / Folder Card와 Folder별 File Group 및 직접 관계 Edge 렌더링
- Folder, File Group 및 File Row Click interaction 구분
- Camera State 조회, 변경 및 구독
- Camera Pan / Zoom과 Viewport / World 좌표 변환
- Camera scale을 고려한 Node 자유 이동
- Drag 중 Node / Edge DOM 갱신과 종료 시 최종 World 위치 저장
- 이동한 Node만 저장하고 나머지는 기본 Layout 위치 사용
- 세부 구조와 동작은 `graph/README.md` 참고

### `panel/`

> Agent Chat Panel의 Runtime Layout 상태와 조정 동작을 담당합니다.

- `left`, `right`, `top`, `bottom` Dock 이동 및 Preview 처리
- Graph와 Agent Chat 사이의 가로·세로 Resize 처리
- 세부 구조와 동작은 `panel/README.md` 참고
