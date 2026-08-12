# `src/webview/`

하나의 VS Code `WebviewPanel` 안에 Graph 영역과 Agent Chat 영역을 표시한다.

Graph와 Agent Chat은 각각 별도의 VS Code Panel이 아니며, 하나의 Webview 내부에서 CSS Grid로 배치된다.

## 구조

```text
src/webview/
├── webview.ts
├── panelState.ts
├── panelDock.ts
├── panelResize.ts
└── webview.css
```

### `extension.ts`

- `crispy.openCanvas` Command 등록
- `WebviewPanel` 생성
- Webview HTML 구성
- 빌드된 CSS와 JavaScript 리소스 연결
- Panel 종료 후 다시 열 때 사용할 마지막 Layout 상태를 Extension Host 메모리에 유지

### `webview.ts`

- Webview의 진입점
- VS Code Webview API 단일 획득
- 필요한 DOM 요소 조회
- 저장된 Layout 상태 복원
- Dock과 Resize 기능 초기화
- 로드 후 ready 메시지 전송

### `panelState.ts`

- 사용자 선호 Dock과 가로·세로 크기 상태 정의
- 유효한 저장 상태 복원 및 기본값 적용
- VS Code Webview `getState()` / `setState()` 연결
- 변경된 Layout을 Extension Host 인메모리 캐시에 전달
- 실제 반응형 Dock 및 Pointer 진행 상태는 저장하지 않음

### `panelDock.ts`

- Agent Chat의 `left`, `right`, `top`, `bottom` 배치 관리
- Drag Handle의 Pointer 이벤트 처리
- 드래그 중 Dock Preview 표시
- Drop 시 실제 Dock 위치 변경
- 좌우 공간 부족 시 임시 `bottom` 배치
- 공간 확보 시 사용자가 선택한 좌우 위치로 복귀

### `panelResize.ts`

- Graph와 Agent Chat 사이의 Resize 처리
- 좌우 배치에서 Agent Chat 너비 조절
- 상하 배치에서 Agent Chat 높이 조절
- 최소 크기와 Webview 영역을 넘지 않는 최대 크기 적용

## 기본 상태

```ts
preferredDock = 'right';
sideSize = INITIAL_SIDE_SIZE;
verticalSize = INITIAL_VERTICAL_SIZE;
```

사용자가 Drop으로 변경한 `preferredDock`과 Resize 완료 시점의 크기는 VS Code Webview 상태에 저장한다.
