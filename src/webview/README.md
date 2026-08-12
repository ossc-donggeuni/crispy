# `src/webview/`

하나의 VS Code `WebviewPanel` 안에 Graph 영역과 Agent Chat 영역을 표시한다.

Graph와 Agent Chat은 각각 별도의 VS Code Panel이 아니며, 하나의 Webview 내부에서 CSS Grid로 배치된다.

## 구조

```text
src/
├── extension.ts
└── webview/
    ├── webview.ts
    ├── panelDock.ts
    ├── panelResize.ts
    └── webview.css
```

### `extension.ts`

- `crispy.openCanvas` Command 등록
- `WebviewPanel` 생성
- Webview HTML 구성
- 빌드된 CSS와 JavaScript 리소스 연결

### `webview.ts`

- Webview의 진입점
- 필요한 DOM 요소 조회
- 기본 Panel 상태 설정
- Dock과 Resize 기능 초기화

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
effectiveDock = 'right';
sideSize = 360;
verticalSize = 300;
```

Panel 위치와 크기는 Webview가 열려 있는 동안만 유지되며 별도로 저장하지 않는다.

## 현재 미구현된 기능

- Graph 및 Agent Chat의 실제 콘텐츠
- Extension과 Webview 사이 메시지 통신
- 위치와 크기 영구 저장
- 외부 Dock 또는 Resize 라이브러리
