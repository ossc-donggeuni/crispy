# `src/webview/panel/`

하나의 VS Code Webview 안에서 Graph 위에 떠 있는 Agent Chat Panel의 Layout을 관리한다.

Graph는 항상 Webview 전체 영역을 사용하고 Agent Chat은 그 위에 여백을 두고 Floating으로 배치되므로,
Chat의 Dock, 크기와 접힘 상태는 Graph의 width / height를 바꾸지 않는다.

## 구조

```text
src/webview/panel/
├── panelCollapse.ts
├── panelDock.ts
├── panelResize.ts
├── panelState.ts
└── README.md
```

### `panelState.ts`

> 사용자가 배치한 Dock 위치 ( 상하좌우 ), 너비-높이와 접힘 여부 Runtime State를 정의합니다.

- Panel Layout 상태 타입 및 기본값 정의 ( Side `460px`, Vertical `400px`, 접힘 `false` )
- Floating Panel의 외곽 여백과 Dock 방향별 최소 크기 정의
- 저장된 크기를 현재 가용 영역 기준으로 제한하는 공통 clamp 계산
- 복원 후보의 Panel 상태 검증 및 독립 객체 복사
- `collapsed`가 없는 이전 저장 상태를 Dock과 크기를 유지한 채 펼침 상태로 호환 복원
- Webview 전체 저장 및 복원은 상위 `webviewState.ts`에서 처리

### `panelDock.ts`

> Agent Chat 영역의 `left`, `right`, `top`, `bottom` 배치 기능을 관리합니다.

- Drag Handle의 Pointer 이벤트 처리
- 드래그 중 해당 방향에 Floating Panel이 놓일 자리를 나타내는 Dock Preview 표시
- Drop 시 실제 Dock 위치 변경
- 좁은 Webview에서도 사용자가 선택한 `preferredDock`을 그대로 유지
- Bottom에서 좌우로 옮길 때만 Side 크기를 초기 너비로 복원
- 선호 Dock이 실제로 변경된 경우 상위 callback 호출

### `panelResize.ts`

> Agent Chat 영역의 Resize와 표시 크기 계산을 관리합니다.

- Chat Panel의 Graph를 향하는 안쪽 경계에 있는 Resize Handle 처리
- 좌우 배치에서 Agent Chat 너비, 상하 배치에서 높이 조절
- 최소 크기와 Floating Panel의 외곽 여백을 제외한 최대 크기 적용
- Webview 크기 변화 시 저장된 크기는 유지한 채 표시 크기만 다시 제한
- 좁은 Webview에서는 표시 중인 크기를 기준으로 Resize 시작
- Resize 완료 시 상위 callback 호출

### `panelCollapse.ts`

> Agent Chat 영역의 접기와 Sticker 열기 동작을 관리합니다.

- Chat Header 접기 버튼으로 Chat Panel과 Resize Handle을 함께 숨김
- 접힘 상태에서 현재 Dock 가장자리에 Sticker 열기 버튼 표시
- Dock 방향에 맞는 Sticker 위치와 열림 방향 아이콘 적용
- 접어도 저장된 Side / Vertical 크기를 그대로 두어 같은 크기로 복원
- 접힘 여부가 바뀐 경우에만 상위 저장 callback 호출
- 다시 펼친 뒤 Terminal fit 등 layout 의존 기능 갱신 callback 호출
