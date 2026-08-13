# `src/webview/panel/`

하나의 VS Code Webview 안에서 Graph 영역과 Agent Chat 영역의 Layout을 관리한다.

사용자가 선택한 Dock과 크기를 저장하며, Pointer 기반 Dock 이동과 Resize 동작을 제공한다.

## 구조

```text
src/webview/panel/
├── panelState.ts
├── panelDock.ts
└── panelResize.ts
```

### `panelState.ts`

> 사용자가 배치한 Dock 위치 ( 상하좌우 ) 와 너비-높이 상태를 정의하고 저장합니다.

- 유효한 저장 상태 복원 및 기본값 적용
- VS Code Webview `getState()` / `setState()` 연결
- 변경된 Layout을 Extension Host 인메모리 캐시에 전달

### `panelDock.ts`

> Agent Chat 영역의 `left`, `right`, `top`, `bottom` 배치 기능을 관리합니다.

- Drag Handle의 Pointer 이벤트 처리
- 드래그 중 Dock Preview 표시
- Drop 시 실제 Dock 위치 변경
- 좌우 공간 부족 시 임시 `bottom` 배치
- 공간 확보 시 사용자가 선택한 좌우 위치로 복귀

### `panelResize.ts`

> Agent Chat 영역의 Resize 기능을 관리합니다.

- 좌우 배치에서 Agent Chat 너비 조절
- 상하 배치에서 Agent Chat 높이 조절
- 최소 크기와 Webview 영역을 넘지 않는 최대 크기 적용