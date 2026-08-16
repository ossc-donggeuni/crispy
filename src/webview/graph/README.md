# `src/webview/graph/`

하나의 VS Code Webview 안에서 Graph를 렌더링하고 Camera 상태와 Pan / Zoom 동작을 관리한다.

Graph State를 단일 상태 기준으로 사용하며, World 변환과 Grid 및 좌표 변환 기능을 제공한다.

## 구조

```text
src/webview/graph/
├── graphCamera.ts
├── graphNavigator.ts
├── graphState.ts
├── graphView.css
├── graphView.ts
└── README.md
```

### `graphView.ts`

> Graph를 렌더링할 DOM 계층과 Graph View lifecycle을 관리합니다.

- Viewport, World, Edge / Node / Overlay Layer 생성
- 전달받은 초기 `GraphState`로 기존 `createGraphState(initialState)` Store 초기화
- 초기 Camera 상태를 World transform과 Grid에 적용
- 외부 Graph 기능을 위한 State와 Camera 인터페이스 제공
- `dispose()` 시 Camera와 Graph View DOM 정리

### `graphState.ts`

> Camera를 포함한 Graph 전체 상태를 정의하고 변경 사항을 관리합니다.

- 기본 Camera 상태 적용
- 외부에서 직접 변경할 수 없는 State snapshot 제공
- Graph State 조회 및 변경
- State 변경 구독 및 구독 해제
- 복원 후보의 Graph 상태 검증 및 독립 객체 복사
- Camera `scale` 최소값과 최대값 적용

### `graphCamera.ts`

> Graph State의 Camera 값을 기준으로 Pan / Zoom과 좌표 변환을 관리합니다.

- Pointer Capture 기반 Drag Pan 처리
- Cursor 아래 World 좌표를 유지하는 Wheel Zoom 처리
- Camera State 변경을 World transform과 Grid에 반영
- Viewport / World 좌표 상호 변환
- `data-graph-camera-ignore` 입력 차단 규약 처리
- `dispose()` 시 Pointer / Wheel Listener와 State 구독 정리

### `graphNavigator.ts`

> Overlay에서 현재 Camera 좌표와 중앙 기준 Zoom Control을 표시합니다.

- 복원된 Graph State 기준으로 좌표와 scale 최초 표시
- Camera State 변경 구독 및 표시 갱신
- 기존 Camera Zoom 동작과 입력 차단 규약 재사용
- `dispose()` 시 Button Listener, State 구독 및 DOM 정리
