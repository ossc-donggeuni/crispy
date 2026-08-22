# `src/webview/`

하나의 VS Code `WebviewPanel` 안에 Graph 영역과 Agent Chat 영역을 표시한다.

Graph와 Agent Chat은 각각 별도의 VS Code Panel이 아니며, 하나의 Webview 내부에 배치된다.

Graph는 항상 Webview 전체 영역을 사용하고, Agent Chat은 그 위에 여백을 두고 떠 있는 Floating Overlay로 표시된다.

## 구조

```text
src/webview/
├── graph/
├── panel/
├── README.md
├── webview.css
├── webview.ts
└── webviewState.ts
```

### `graph/`

> Project Tree Graph의 Model, Layout, Renderer, Runtime State와 Camera 및 View lifecycle을 담당합니다.

- 안정적인 ID 기반 Project / Folder / File 모델과 공통 Multi-Root Graph
- Root별 subtree를 독립 배치하는 deterministic Tree Layout
- Project / Folder / File Root와 Folder별 File Group 및 직접 관계 Edge 렌더링
- File 하나는 `standalone`, 둘 이상은 `grouped` presentation으로 처리
- File Group별 5개 단위 더보기와 최초 page로 접기
- File Group page 변경에 따른 Group 높이, Sibling 위치 및 Edge Reflow
- Folder/File Detach Handle과 immutable Graph Root Promotion
- 원래 Tree 위치의 Folder/File Backlink 및 부모 경로 Context Label
- Backlink → Root와 Context Label → Backlink 양방향 Camera Focus
- Promoted Root를 자신의 Backlink에 Drop하는 Reattach
- Folder, File Group 및 File Row Click interaction 구분
- Camera, Node 위치 및 File Group page State 조회, 변경 및 구독
- Camera Pan / Zoom, Viewport / World 좌표 변환 및 ease-out Focus Animation
- Camera scale을 고려한 Node 자유 이동
- Drag 중 Node / Edge DOM 갱신과 종료 시 최종 World 위치 저장
- Camera, 이동한 Node, File Group page와 열린 Folder를 저장하고 나머지는 기본 Layout 상태 사용
- 세부 구조와 동작은 `graph/README.md` 참고

### `panel/`

> Graph 위에 떠 있는 Agent Chat Panel의 Runtime Layout 상태와 조정 동작을 담당합니다.

- `left`, `right`, `top`, `bottom` Dock 이동 및 Floating 배치 Preview 처리
- 좁은 Webview에서도 선호 Dock을 유지하고 표시 크기만 제한
- Chat Panel 안쪽 경계에서의 가로·세로 Resize 처리
- Chat 접기와 Dock 가장자리 Sticker 열기 처리
- 세부 구조와 동작은 `panel/README.md` 참고

### `webviewState.ts`

> Panel/Camera Session 상태와 Host 초기 Graph snapshot의 복원을 담당합니다.

- Session State의 Panel 및 Camera 검증과 독립 객체 복사
- Panel Dock, 크기, 접힘 여부와 Camera를 Webview `getState()` / `setState()`로 저장 및 복원
- `collapsed`가 없는 이전 저장 상태를 Dock과 크기를 유지한 채 호환 복원
- Extension Host가 HTML로 전달하는 초기 상태 직렬화 및 복원
- 저장 상태가 없거나 잘못된 경우 Panel 및 Graph 기본값 적용
- W-04.3 이전 전체 Webview `setState()` snapshot에서도 Panel/Camera만 호환 복원

### `webview.ts`

> Webview 를 사용하기 위해 관련 요소들을 초기화하는 진입점입니다.

- VS Code Webview API 단일 획득
- 필요한 DOM 요소 조회
- `restoreWebviewState()`로 전체 초기 상태 복원
- `initialState.panel`을 Panel Runtime State로 분리
- `initialState.graph`의 Camera, Node 위치, File Group page 및 opened 상태로 Graph View와 Store 초기화
- Mock Project Layout, Renderer, Camera 및 Navigator 조합
- Camera/Panel 변경 시 Session State만 `setState()` 및 `webview.stateChanged`로 전달
- Node 위치, File Group page, 열린 Folder와 Detached Root 변경 시 `workspace.stateChanged`로 전달
- Dock, Resize와 Collapse 기능 초기화
- Dock 변경 시 표시 크기와 Sticker 위치 재계산
- unload 시 Graph State subscription과 Graph View 정리
- 로드 후 ready 메시지 전송
