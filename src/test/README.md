# 대응하는 테스트 목록

## `extension.test.ts`

- Extension을 활성화하고 manifest의 Canvas command를 등록한다
- Canvas command가 실제 설정으로 WebviewPanel을 최초 생성한다
- 열린 Canvas command를 다시 실행하면 같은 Panel을 재사용한다
- Panel을 dispose한 뒤 Canvas command가 새 Panel을 생성한다
- deactivate가 열린 Panel과 참조를 정리해 다음 생성에 영향을 주지 않는다
- Panel dispose 후 전체 Webview state를 복원하고 deactivate 시 초기화한다
- 잘못된 `webview.stateChanged` snapshot은 마지막 유효 상태를 덮어쓰지 않는다
- `handleWebviewMessage`가 `webview.ready`에 `extension.ready`로 응답한다

## `webviewState.test.ts`

- 저장 상태가 없으면 Panel 및 Graph 기본 상태를 새 snapshot으로 복원한다
- `getState()`의 전체 Webview 상태를 외부 객체와 분리해 우선 복원한다
- `getState()`가 없으면 HTML의 `data-webview-state`를 복원한다
- 잘못된 저장 상태와 HTML 상태는 안전하게 기본값으로 처리한다
- 잘못된 `getState()` 대신 유효한 HTML 초기 상태를 사용한다
- 저장 시 Panel과 Graph를 함께 독립적인 snapshot으로 `setState()`에 전달한다
- Graph State subscription과 Panel callback을 전체 Webview snapshot 저장 및 `webview.stateChanged` 메시지로 연결한다

## `panel/panelState.test.ts`

- 기본 Panel Layout 상태를 정의한다
- 유효한 Dock 위치와 크기를 독립적인 객체로 파싱한다
- 잘못된 Panel Layout 상태를 거부한다

## `panel/panelDock.test.ts`

- Side Dock은 좁은 Layout에서 Bottom으로 전환되고 확대하면 preferred Left / Right로 복원된다
- 사용자가 직접 Bottom을 선택하면 Layout 확대 후에도 Bottom을 유지한다
- Left / Right / Top / Bottom 위치로 Drop할 수 있다
- Layout 외부에 Drop하면 기존 Dock을 유지한다
- 활성 Pointer와 다른 `pointerId`의 이동 및 종료 이벤트를 무시한다
- `pointercancel`은 Drag 및 Preview를 정리하고 기존 Dock을 유지한다
- `lostpointercapture`는 Drag 및 Preview를 정리하고 기존 Dock을 유지한다
- 큰 `sideSize`와 무관하게 초기 너비 기준으로 자동 Bottom 전환과 좌우 복귀를 결정한다
- Bottom에서 Left로 Dock하면 `sideSize`를 초기 너비로 복원한다
- 자동 Bottom에서는 좌우 Drop으로 상태와 크기를 변경하지 않는다
- Left에서 Right로 Dock하면 사용자가 조절한 `sideSize`를 유지한다

## `panel/panelResize.test.ts`

- Dock 방향에 따라 Pointer 이동 방향을 크기 증감으로 변환한다
- Side와 Vertical 크기에 최소값을 적용한다
- Layout 기준으로 Side와 Vertical 최대 크기를 제한한다
- `pointerup`은 변경된 size를 유지하고 `onResizeEnd`를 정확히 한 번 호출한다
- `pointercancel`은 move로 변경된 Side size를 시작 크기로 rollback한다
- `lostpointercapture`는 move로 변경된 Vertical size를 시작 크기로 rollback한다

## `graph/graphState.test.ts`

- 기존 Camera 기본값으로 초기화한다
- 외부 객체와 분리된 immutable snapshot을 관리한다
- 변경된 상태를 subscriber에 전달하고 unsubscribe 이후 호출하지 않는다
- Camera scale을 최소 및 최대 범위로 제한한다
- 유효한 Graph 상태를 독립적인 객체로 파싱한다
- 잘못된 Graph 상태를 거부한다

## `graph/graphView.test.ts`

- 초기 Graph Camera 상태를 Store, World transform 및 Overlay Navigator에 복원한다

## `graph/graphNavigator.test.ts`

- 복원된 Camera 좌표와 scale을 최초 표시한다
- Camera Pan과 Wheel Zoom 상태 변경을 즉시 표시한다
- Zoom 버튼이 scale 범위 안에서 Viewport 중앙을 기준으로 동작한다
- Zoom Control의 Pointer 입력으로 Camera Pan을 시작하지 않는다
- 복원 후 Zoom 변경을 기존 Webview State 저장 흐름으로 다시 저장한다
- `dispose()` 시 Button Listener와 State 구독을 정리한다

## `graph/graphCamera.test.ts`

- 초기 상태와 `setState()`를 graph-world transform에 적용한다
- `setState()`의 scale을 최소 및 최대 범위로 제한한다
- viewport 좌표와 world 좌표를 Camera 상태 기준으로 상호 변환한다
- 기본 Pointer Drag로 Pan하고 종료 시 Capture와 Drag 상태를 정리한다
- 활성 Pointer와 다른 Pointer 이벤트 및 기본 버튼이 아닌 입력을 무시한다
- Camera 입력 차단 속성이 지정된 요소에서 Pointer Drag로 Pan하지 않는다
- Camera 입력 차단 요소의 자식에서 발생한 Pointer와 Wheel 입력을 처리하지 않는다
- Camera 입력 차단 속성이 없는 일반 요소에서는 Pan과 Zoom이 동작한다
- Wheel Zoom 전후 Cursor 아래 World 위치를 고정한다
- 외부 Graph State 변경을 World transform과 Grid에 즉시 반영한다
- Wheel Zoom Out과 Zoom In을 scale 범위에서 제한한다
- Camera 입력 차단 속성이 지정된 요소에서 Wheel로 Zoom하지 않는다
- `lostpointercapture`와 `dispose()`가 진행 상태 및 등록한 이벤트를 정리한다
