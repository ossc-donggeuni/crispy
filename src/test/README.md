# 대응하는 테스트 목록

## `extension.test.ts`

- Extension을 활성화하고 manifest의 Canvas command를 등록한다
- Canvas command가 실제 설정으로 WebviewPanel을 최초 생성한다
- 열린 Canvas command를 다시 실행하면 같은 Panel을 재사용한다
- Panel을 dispose한 뒤 Canvas command가 새 Panel을 생성한다
- deactivate가 열린 Panel과 참조를 정리해 다음 생성에 영향을 주지 않는다
- deactivate가 저장된 Layout state를 초기화한다
- handleWebviewMessage responds to webview.ready with extension.ready

## `panel/panelDock.test.ts`

- Side Dock은 좁은 Layout에서 Bottom으로 전환되고 확대하면 preferred Left/Right로 복원된다
- 사용자가 직접 Bottom을 선택하면 Layout 확대 후에도 Bottom을 유지한다
- Left / Right / Top / Bottom 위치로 Drop할 수 있다
- Layout 외부에 Drop하면 기존 Dock을 유지한다
- 활성 Pointer와 다른 pointerId의 이동 및 종료 이벤트를 무시한다
- pointercancel은 Drag 및 Preview를 정리하고 기존 Dock을 유지한다
- lostpointercapture는 Drag 및 Preview를 정리하고 기존 Dock을 유지한다
- 큰 sideSize와 무관하게 초기 너비 기준으로 자동 Bottom 전환과 좌우 복귀를 결정한다
- Bottom에서 Left로 Dock하면 sideSize를 초기 너비로 복원한다
- 자동 Bottom에서는 좌우 Drop으로 상태와 크기를 변경하지 않는다
- Left에서 Right로 Dock하면 사용자가 조절한 sideSize를 유지한다

## `panel/panelResize.test.ts`

- Dock 방향에 따라 Pointer 이동 방향을 크기 증감으로 변환한다
- Side와 Vertical 크기에 최소값을 적용한다
- Layout 기준으로 Side와 Vertical 최대 크기를 제한한다
- pointerup은 변경된 size를 유지하고 onResizeEnd를 정확히 한 번 호출한다
- pointercancel은 move로 변경된 Side size를 시작 크기로 rollback한다
- lostpointercapture는 move로 변경된 Vertical size를 시작 크기로 rollback한다

## `panel/panelState.test.ts`

- 저장된 상태가 없으면 기본 상태를 복원한다
- 유효한 Dock 위치와 크기를 복원한다
- 저장된 상태가 유효하지 않으면 기본 상태를 복원한다
- 저장 대상 Layout 필드만 새 객체로 저장한다
- Panel을 닫고 새로 생성해도 Extension Host 상태를 복원한다
