# `src/webview/graph/`

하나의 VS Code Webview 안에서 Project Tree Graph를 렌더링하고 Camera 상태와 Pan / Zoom 및 Node 이동 동작을 관리한다.

Graph State를 단일 상태 기준으로 사용하며, 저장되지 않은 Node에는 deterministic Layout의 기본 World 좌표를 적용한다. 실제 Workspace나 파일 시스템은 조회하지 않는다.

## 구조

```text
src/webview/graph/
├── graphCamera.ts
├── graphLayout.ts
├── graphMockData.ts
├── graphModel.ts
├── graphNavigator.ts
├── graphNodeDrag.ts
├── graphRenderer.ts
├── graphState.ts
├── graphView.css
├── graphView.ts
└── README.md
```

### `graphModel.ts`

> Project 구조를 표현하는 최소 데이터 모델을 정의합니다.

- 안정적인 고유 ID를 가진 Project / Folder / File 정의
- Folder 안에 중첩 Folder와 File을 함께 구성
- Graph icon이나 Runtime State 정보를 Model에 포함하지 않음

### `graphMockData.ts`

> Graph 렌더링과 테스트가 공통으로 사용하는 고정 Project 구조를 제공합니다.

- Project Root와 `app`, `src` Folder 구성
- 중첩 Folder와 Folder별 여러 File 포함
- 실제 Workspace 및 파일 시스템을 사용하지 않음

### `graphLayout.ts`

> Mock Project를 왼쪽에서 오른쪽으로 배치하는 deterministic Tree Layout을 생성합니다.

- Depth가 증가할수록 X가 증가하고 같은 Depth는 같은 Column 사용
- 각 Parent의 Child Folder와 직접 File을 묶은 File Group 생성
- Parent와 직접 Child 사이의 Edge만 생성
- Subtree 높이를 기준으로 Sibling을 세로 배치
- Folder와 File Group에 동일한 `200px` 폭 적용
- 최대 5개 File Row와 선택적 More Bar를 File Group 높이에 반영
- 동일 입력에 동일한 Node 순서, 위치 및 Edge 반환

### `graphRenderer.ts`

> Layout을 기존 Edge / Node Layer에 렌더링하고 표시 위치 및 interaction을 관리합니다.

- Project Root와 Folder를 같은 Card 계열로 렌더링
- Webview CSP와 무관하게 표시되는 inline Folder SVG 생성
- Folder별 File을 최대 5개까지 하나의 File Group에 렌더링
- 숨겨진 File 수를 `+ N개 더보기` Bar로 표시
- Folder, File Group 및 File Row Click callback 구분
- File Row Click 전파를 차단하고 해당 Row에만 Click animation 적용
- Parent 오른쪽 중앙과 Child 왼쪽 중앙을 Cubic Bezier Edge로 연결
- Camera-only State 변경 시 Node / Edge 위치 갱신 생략
- 저장 위치가 바뀐 Node와 직접 연결된 Edge만 갱신
- `dispose()` 시 DOM, Listener, Drag controller 및 State 구독 정리

### `graphNodeDrag.ts`

> Project Root, Folder 및 File Group Card의 자유 이동을 관리합니다.

- 별도 Handle 없이 Node 자체에서 Pointer Drag 시작
- Pointer Capture와 Click / Drag threshold 처리
- Screen 이동량을 시작 Camera scale로 나눠 World 좌표 계산
- Pointer move 중 Graph State를 변경하지 않고 Node와 Edge DOM만 갱신
- `pointerup` 시 최종 World 위치를 Graph State에 한 번 저장
- `pointercancel`과 `lostpointercapture` 시 임시 위치 복원
- File Row의 `data-graph-node-drag-ignore` 입력 차단 규약 처리

### `graphView.ts`

> Graph를 렌더링할 DOM 계층과 Graph View lifecycle을 관리합니다.

- Viewport, World, Edge / Node / Overlay Layer 생성
- 전달받은 초기 `GraphState`로 새 Store 초기화
- 고정 Mock Project의 Layout과 Renderer 초기화
- 초기 Camera 상태를 World transform과 Grid에 적용
- Overlay Navigator 초기화
- 외부 Graph 기능을 위한 State와 Camera 인터페이스 제공
- `dispose()` 시 Navigator, Renderer, Camera와 Graph View DOM 정리

### `graphState.ts`

> Camera와 사용자가 이동한 Node 위치를 포함한 Graph 전체 상태를 관리합니다.

- 기본 Camera 상태와 빈 Node 위치 적용
- 외부에서 직접 변경할 수 없는 State snapshot 제공
- Graph State 조회 및 변경
- State 변경 구독 및 구독 해제
- 이동한 Node의 World 좌표만 `nodePositions`에 저장
- 복원 후보의 Graph 상태 검증 및 독립 객체 복사
- 기존 Camera-only 상태를 빈 Node 위치로 호환 파싱
- 동일한 `nodePositions` 객체의 reference fast-path 비교
- 다른 객체의 Node 위치 값 비교와 snapshot 참조 재사용
- Camera `scale` 최소값과 최대값 적용

### `graphCamera.ts`

> Graph State의 Camera 값을 기준으로 Pan / Zoom과 좌표 변환을 관리합니다.

- Pointer Capture 기반 Drag Pan 처리
- Cursor 아래 World 좌표를 유지하는 Wheel Zoom 처리
- Camera State 변경을 World transform과 Grid에 반영
- Viewport / World 좌표 상호 변환
- `data-graph-camera-ignore`로 Pan과 Wheel Zoom 모두 차단
- `data-graph-camera-pan-ignore`로 Graph Node의 Pan만 차단
- Graph Node와 File Row 위의 기존 Wheel Zoom 허용
- DOM class가 아닌 범용 attribute 기반 입력 정책 유지
- `dispose()` 시 Pointer / Wheel Listener와 State 구독 정리

### `graphNavigator.ts`

> Overlay에서 현재 Camera 좌표와 중앙 기준 Zoom Control을 표시합니다.

- 복원된 Graph State 기준으로 좌표와 scale 최초 표시
- Camera State 변경 구독 및 표시 갱신
- 기존 Camera Zoom 동작과 완전 입력 차단 규약 재사용
- `dispose()` 시 Button Listener, State 구독 및 DOM 정리

### `graphView.css`

> Graph Node, Edge, Grid와 Navigator의 시각적 표현을 정의합니다.

- Layout 상수와 일치하는 Folder 및 File Group 크기 유지
- `box-sizing: border-box` 기반 Node 높이 계산
- 조밀한 File Row와 More Bar 스타일
- 낮은 강조의 얇은 Bezier Edge 스타일
- File Row 전용 Hover / Active / Click animation
- File Row Click 중 File Group Card의 Active 표현 차단
- reduced-motion 환경에서 Click animation 최소화
