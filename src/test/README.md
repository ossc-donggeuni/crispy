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
- Camera와 일부 Node 위치를 새 Store와 Graph View 초기화용 상태로 Round Trip한다
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
- 동일한 Node 위치 객체는 reference fast-path로 snapshot 참조를 재사용한다
- 다른 객체라도 Node 위치 값이 같으면 기존 snapshot 참조를 재사용한다
- Camera scale을 최소 및 최대 범위로 제한한다
- 유효한 Graph 상태를 독립적인 객체로 파싱한다
- 기존 Camera-only 상태를 빈 Node 위치로 호환 파싱한다
- 잘못된 Graph 상태를 거부한다

## `graph/graphLayout.test.ts`

- 실제 Graph Mock이 중첩 Folder와 Folder별 여러 File을 포함한다
- 각 Container의 직접 File을 하나의 안정적인 File Group으로 만든다
- Project/Folder에서 직접 Child Folder와 File Group으로만 Edge를 만든다
- 동일 입력은 동일 Layout이며 같은 Depth는 같은 X Column에 놓인다
- Folder와 File Group을 동일한 폭과 조밀한 Depth 간격으로 배치한다
- 30px File Row와 More Bar 높이를 File Group Layout 높이에 반영한다

## `graph/graphRenderer.test.ts`

- Project Root, Folder, File Group과 Edge를 지정된 Layer에 렌더링한다
- Folder, File Group, File Row Click callback을 구분한다
- File Row Click 전파를 차단하고 Row 전용 animation lifecycle을 처리한다
- Threshold를 넘긴 Node Drag 뒤 Click callback을 실행하지 않는다
- File Row Pointer 입력은 File Group Drag와 Camera Pan을 시작하지 않는다
- Folder, File Group, File Row 위 Wheel은 Cursor 기준 Camera Zoom을 수행한다
- Camera-only 변경은 Edge를 다시 계산하지 않고 Node 위치 변경만 반영한다
- Project Root, Folder, File Group을 Pointer Capture와 Camera scale 기준 World 좌표로 이동한다
- Drag 중에는 Node/Edge DOM만 갱신하고 Pointer 종료 시 최종 위치를 한 번 저장한다
- `pointercancel`과 `lostpointercapture`는 임시 위치를 복원하고 저장하지 않는다
- Node 입력 차단 규약으로 Node Drag 중 Camera Pan을 시작하지 않는다
- Node 위치를 기존 Webview State로 저장하고 새 Store/Renderer에서 일부 위치만 복원한다

## `graph/graphView.test.ts`

- 초기 Graph Camera 상태를 Store와 World transform에 복원한다

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
- Pan-only 차단 요소에서는 Pointer Pan을 막고 Wheel Zoom은 허용한다
- Camera 입력 차단 요소의 자식에서 발생한 Pointer와 Wheel 입력을 처리하지 않는다
- Camera 입력 차단 속성이 없는 일반 요소에서는 Pan과 Zoom이 동작한다
- Wheel Zoom 전후 Cursor 아래 World 위치를 고정한다
- 외부 Graph State 변경을 World transform과 Grid에 즉시 반영한다
- Wheel Zoom Out과 Zoom In을 scale 범위에서 제한한다
- Camera 입력 차단 속성이 지정된 요소에서 Wheel로 Zoom하지 않는다
- `lostpointercapture`와 `dispose()`가 진행 상태 및 등록한 이벤트를 정리한다
