# `src/webview/`

하나의 VS Code `WebviewPanel` 안에 Graph 영역과 Agent Chat 영역을 표시한다.

Graph와 Agent Chat은 각각 별도의 VS Code Panel이 아니며, 하나의 Webview 내부에서 CSS Grid로 배치된다.

## 구조

```text
src/
├── extension.ts
└── webview/
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

### `webview.css`

- Dock 방향별 CSS Grid Layout
- Graph와 Agent Chat 영역 스타일
- Drag Handle과 Resize Handle 스타일
- Dock Preview 스타일
- VS Code 테마 변수 적용

## 기본 상태

```ts
preferredDock = 'right';
sideSize = 360;
verticalSize = 300;
```

사용자가 Drop으로 변경한 `preferredDock`과 Resize 완료 시점의 크기는 VS Code Webview 상태에 저장한다.
좌우 공간 부족으로 적용되는 임시 `bottom` 배치는 저장하지 않으며, Webview 크기에 따라 다시 계산한다.
Panel 자체를 닫으면 VS Code Webview 상태가 삭제되므로, 마지막 Layout은 Extension Host 메모리에도 복사해 새 Panel에 전달한다.
이 인메모리 상태는 Extension 비활성화 또는 VS Code 재시작 시 삭제된다.

## 현재 미구현된 기능

- Graph 및 Agent Chat의 실제 콘텐츠
- Layout 상태 외 Extension과 Webview 사이 애플리케이션 메시지
- VS Code 재시작 후 닫힌 WebviewPanel 복원
- 외부 Dock 또는 Resize 라이브러리
