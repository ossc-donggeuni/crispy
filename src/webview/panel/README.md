# `src/webview/panel/`

하나의 VS Code Webview 안에서 Graph 영역과 Agent Chat 영역의 Layout을 관리한다.

사용자가 선택한 Dock과 크기를 관리하며, Pointer 기반 Dock 이동과 Resize 동작을 제공한다.

## 구조

```text
src/webview/panel/
├── panelDock.ts
├── panelResize.ts
├── panelState.ts
└── README.md
```

### `panelState.ts`

> 사용자가 배치한 Dock 위치 ( 상하좌우 ) 와 너비-높이 Runtime State를 정의합니다.

- Panel Layout 상태 타입 및 기본값 정의
- 복원 후보의 Panel 상태 검증 및 독립 객체 복사
- Webview 전체 저장 및 복원은 상위 `webviewState.ts`에서 처리

### `panelDock.ts`

> Agent Chat 영역의 `left`, `right`, `top`, `bottom` 배치 기능을 관리합니다.

- Drag Handle의 Pointer 이벤트 처리
- 드래그 중 Dock Preview 표시
- Drop 시 실제 Dock 위치 변경
- 좌우 공간 부족 시 임시 `bottom` 배치
- 공간 확보 시 사용자가 선택한 좌우 위치로 복귀
- 선호 Dock이 실제로 변경된 경우 상위 callback 호출

### `panelResize.ts`

> Agent Chat 영역의 Resize 기능을 관리합니다.

- 좌우 배치에서 Agent Chat 너비 조절
- 상하 배치에서 Agent Chat 높이 조절
- 최소 크기와 Webview 영역을 넘지 않는 최대 크기 적용
- Resize 완료 시 상위 callback 호출