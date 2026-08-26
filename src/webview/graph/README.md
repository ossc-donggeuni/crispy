# `src/webview/graph/`

하나의 VS Code Webview 안에서 Project / Folder / File을 Root로 사용할 수 있는 Multi-Root Tree Graph를 렌더링하고 Camera 상태와 Pan / Zoom 및 Node 이동 동작을 관리한다.

Graph는 `GraphRoot[]`와 Project/Folder/File을 허용하는 Root Node Map을 입력으로 사용한다. 기존 단일 Workspace도 Root가 하나인 같은 구조로 처리한다. 실행 중에는 `Graph.roots`가 Root 여부를 결정하고, persisted `detachedRootNodeIds`는 초기 Workspace Graph에 Detached Root를 다시 적용하는 최소 상태로 사용한다. children 포함 여부는 `openedFolders`가 별도로 결정한다. Camera, Node 위치, Open, Pagination 및 Detached Root ID는 Graph State로 관리하며 저장되지 않은 Node에는 deterministic Layout의 기본 World 좌표를 적용한다. File Group page가 바뀌면 표시 Row 수에 맞춰 Layout을 다시 계산한다. 실제 Workspace나 파일 시스템은 조회하지 않는다.

## 구조

```text
src/webview/graph/
├── assets/
├── agentActivityFocus.ts
├── agentActivityNotificationCenter.ts
├── agentActivityNotifications.ts
├── fileIconResolver.ts
├── graphCamera.ts
├── graphDetachDrag.ts
├── graphLayout.ts
├── graphMockData.ts
├── graphModel.ts
├── graphNodeUri.ts
├── graphNavigator.ts
├── graphNavigatorMinimap.ts
├── graphNavigatorRoots.ts
├── graphNodeDrag.ts
├── graphRenderer.ts
├── graphRootContext.ts
├── graphRootPromotion.ts
├── graphState.ts
├── graphView.css
├── graphView.ts
└── README.md
```

### `agentActivityNotifications.ts`

> 현재 Agent Activity Store를 알림 Center용 표시 행으로 투영합니다.

- 모든 Target의 현재 Activity를 Graph binding 우선순위와 분리된 전역 수신 sequence 최신순으로 정렬
- 실행 중인 Session만 포함하고 Session 제목, 현재 메시지와 canonical Target 이름/경로를 결합
- `sessionId + nodeId + rootId`의 안정적인 key로 상태 전환 시 같은 DOM 행 재사용
- Graph가 바뀔 때만 Target 표시 index를 재생성해 고빈도 PTY 메시지 갱신에서 Tree 재순회 방지
- Graph snapshot에 아직 없는 Target도 URI가 현재 Workspace Root 안이면 이름/경로를 복원해 pending으로 표시
- URI scheme/authority/path segment 경계상 모든 현재 Root 밖인 Target만 내부 ID 없는 unavailable 문구로 표시

### `agentActivityFocus.ts`

> 알림 Target을 Graph에 드러내고 현재 occurrence의 World Focus 지점을 계산합니다.

- Target과 조상의 Filter 숨김 상타만 제거하고 Target이 표시될 때까지 Project/Folder ancestor만 최소 범위로 Open
- Grouped File이 현재 page 밖이면 해당 File을 포함하는 page까지만 확장
- 명시적인 `rootId`와 detached occurrence를 source occurrence보다 우선
- 최신 Layout과 저장 위치, 앞선 File Row의 Agent Binding footprint를 반영해 Card/Row 중심 계산
- Graph에 없는 Target은 State나 Camera를 변경하지 않고 안전하게 생략

### `graphNodeUri.ts`

> URI 기반 production Graph Node ID의 종류, Root 포함 관계와 상대 경로를 해석합니다.

- `workspace-root:`, `folder:`, `file:` prefix 뒤 absolute URI만 구조적으로 복원
- URI scheme, credentials, host와 path segment 경계를 보존한 Root containment 판정
- encoded URI segment를 사용자 표시 경로에서만 안전하게 decode
- 가장 구체적인 nested Workspace Root 선택을 위한 정규화 path 길이 제공

### `agentActivityNotificationCenter.ts`

> Graph Overlay 우측 상단의 알림 Button, Panel과 알림 행 DOM lifecycle을 관리합니다.

- 현재 Activity 수 Badge, 빈 상태와 최신순 Scroll 목록 표시
- 각 알림에 Graph의 동일한 Activity Effect recipe와 연속 Animation timeline 적용
- 알림 본문 Click은 Focus callback, 별도 삭제 Button은 exact Target×Session dismiss callback으로 분리
- Escape, 외부 Pointer와 Focus 복원 및 Camera 입력 차단 attribute 처리
- Agent Panel dock을 제외한 실제 Graph 가시 영역의 우측 상단에 위치
- Store/Session 구독, 행별 Effect host와 Listener를 `dispose()`에서 정리

### `fileIconResolver.ts`

> File 이름을 렌더링 전용 로컬 SVG 아이콘 식별자로 변환합니다.

- 대소문자를 구분하지 않는 특수 파일명, TypeScript declaration 및 확장자 매핑
- 특수 파일명, declaration suffix, 일반 확장자 순서의 우선순위 적용
- 미지원 확장자와 확장자 없는 File의 공통 `file-unknown` fallback
- Graph Model / State / Layout에 icon 상태를 저장하지 않음

### `graphCamera.ts`

> Graph State의 Camera 값을 기준으로 Pan / Zoom과 좌표 변환을 관리합니다.

- Pointer Capture 기반 Drag Pan 처리
- Cursor 아래 World 좌표를 유지하는 Wheel Zoom 처리
- Camera State 변경을 World transform과 Grid에 반영
- Viewport / World 좌표 상호 변환
- `focusOn()`으로 현재 scale을 유지한 채 World 지점을 Viewport 중앙으로 이동
- `focusOn()`과 연속 `setState()`가 공유하는 World Target 중앙 배치 Camera State 계산
- `requestAnimationFrame` 기반 약 300ms cubic ease-out Focus Animation
- 새 Focus 요청, 사용자 Pan / Zoom 및 `dispose()`에서 진행 중 Animation 취소
- `data-graph-camera-ignore`로 Pan과 Wheel Zoom 모두 차단
- `data-graph-camera-pan-ignore`로 Graph Node의 Pan만 차단
- Graph Node와 File Row 위의 기존 Wheel Zoom 허용
- DOM class가 아닌 범용 attribute 기반 입력 정책 유지
- `dispose()` 시 Pointer / Wheel Listener와 State 구독 정리

### `graphDetachDrag.ts`

> Folder/File Detach Handle의 Pointer lifecycle을 Graph 변경과 분리해 관리합니다.

- Primary left Pointer Capture와 Click / Drag threshold 처리
- 실제 Drag의 Pointer up만 `nodeId`, `clientX`, `clientY`로 전달
- Folder Open / Close, File Click, Node Move와 Camera Pan 전파 차단
- `pointercancel`, `lostpointercapture`, `dispose()` 시 요청 없이 session 정리

### `graphLayout.ts`

> 여러 Graph Root의 Project Tree를 하나의 World에 배치하는 deterministic Layout을 생성합니다.

- Root별 기존 Tree Layout 로직을 독립적으로 재사용
- 첫 Root는 기존 단일 Project 시작 위치를 유지하고 후속 Root는 subtree 높이와 고정 간격으로 배치
- 저장 위치가 없는 여러 Root도 완전히 겹치지 않는 결정적 기본 위치 적용
- Depth가 증가할수록 X가 증가하고 같은 Depth는 같은 Column 사용
- 모든 File을 `GraphFileGroupNode.children`에 포함하고 별도 Standalone File Layout 타입을 만들지 않음
- 직접 File 하나는 File ID를 Group ID로 사용하는 `standalone`, 둘 이상은 기존 Group ID의 `grouped` presentation 적용
- File Root를 edge 없는 depth 0 `standalone` File Group으로 배치
- 다른 Graph Root로 승격된 Folder를 원래 Parent 아래 leaf Backlink로 치환
- 승격된 grouped File은 기존 순서와 item 수를 유지한 Backlink Row로 표현
- 승격된 singleton File은 실제 File Root와 충돌하지 않는 Backlink Group ID 사용
- 현재 Layout Root에서는 실제 Node와 subtree를 그대로 렌더링
- Root Context를 `rootContexts`, 최신 Root Node 목록을 `rootNodeIds`로 Renderer에 전달
- Parent와 직접 Child 사이의 Edge만 생성
- Subtree 높이를 기준으로 Sibling을 세로 배치
- Folder와 모든 File Group presentation에 동일한 `200px` 폭 적용
- File Group page에 따라 5개 단위로 표시 Row 수 계산
- 표시 Row와 선택적 단일 pagination control을 File Group 높이에 반영
- `openedFolders`에 포함된 Project/Folder의 children만 Layout에 포함
- Project/Folder Root 여부와 무관하게 `openedFolders` 상태로 children 포함 여부 결정
- 동일 입력에 동일한 Node 순서, 위치 및 Edge 반환

### `graphMockData.ts`

> Graph 렌더링과 테스트가 공통으로 사용하는 고정 Project 구조를 제공합니다.

- Project, Folder, File Root를 함께 포함하는 Multi-Root 시각 검증 Graph 제공
- Project Root와 `app`, `src` Folder 구성
- Folder/File Root에 긴 부모 경로 Context를 포함해 Label과 축약 동작 확인
- 중첩 Folder와 Folder별 여러 File 포함
- `pagination-samples` 아래에 17개 및 21개 File을 가진 Folder 포함
- 실제 Workspace 및 파일 시스템을 사용하지 않음

### `graphModel.ts`

> Multi-Root Graph와 Project 구조를 표현하는 최소 데이터 모델을 정의합니다.

- `id`, `nodeId`, 선택적 `context.relativePath`를 가진 source-agnostic `GraphRoot` 정의
- `GraphRoot[]`와 Project/Folder/File 공통 Root Node Map 관리
- 기존 Project를 Root 하나인 Graph로 변환하는 호환 factory 제공
- 안정적인 고유 ID를 가진 Project / Folder / File 정의
- Folder 안에 중첩 Folder와 File을 함께 구성
- Graph icon이나 Runtime State 정보를 Model에 포함하지 않음

### `graphNavigator.ts`

> Overlay에서 Minimap 영역, Camera 표시와 Zoom Control, 확장 가능한 Navigator Action을 관리합니다.

- Zoom Controls 왼쪽에 하단 정렬된 Minimap Container와 고정 SVG Layer를 항상 표시
- Minimap에 기존 `data-graph-camera-ignore` 규약을 적용해 Pan과 Wheel Zoom 입력 차단
- Renderer와 공유하는 초기 `GraphLayout`을 즉시 렌더링하고 `setLayout()`으로 Graphic 교체
- Node는 이름/Icon 없는 최소 2px Rounded Rect, Edge는 약한 단순 Line으로 표시
- Edge/Node 위 고정 Viewport Layer의 단일 Rect로 현재 Camera 가시 World 영역 표시
- Graph State의 `nodePositions` reference 변경 시에만 저장 위치를 반영해 Minimap 재투영
- Camera-only State 변경은 기존 Projection과 Graphic을 유지하고 Indicator attribute만 갱신
- Graph Viewport `ResizeObserver`는 Indicator만 갱신하며 Navigator `dispose()`에서 해제
- Minimap Background Click을 현재 Projection으로 World에 역투영해 기존 `camera.focusOn()` 정책으로 이동
- Viewport Indicator를 Primary Pointer Capture로 Drag하고 Projection 역투영 이동량을 현재 scale의 `camera.setState()`에 실시간 적용
- Drag 입력은 Camera State만 변경해 기존 Camera-only Indicator fast path를 그대로 재사용
- `pointerup`, `pointercancel`, `lostpointercapture`에서 session을 정리하고 Drag 후 Background Click을 억제
- Node Drag 중 transient DOM 위치는 구독하지 않고 pointerup 저장 뒤 Graph와 Indicator 재투영
- 복원된 Graph State 기준으로 좌표와 scale 최초 표시
- Camera State 변경 구독 및 표시 갱신
- 세로형 Action Rail과 활성화된 Root 목록 Action Button 표시
- Navigator 로컬 상태로 Root List Panel 열기/닫기
- `setRoots()`로 기존 Item을 교체하며 `GraphNavigatorRoot` 순서대로 Project/Folder/File 표시
- 기존 Folder/File Icon asset과 File Icon Resolver를 재사용하고 Detach Context 경로를 보조 Text로 표시
- 빈 Root 안내와 제목이 고정된 Scroll 목록 제공
- Root Item Button 선택을 `rootId` callback으로 상위 계층에 전달하고 재렌더·dispose 시 Listener 정리
- 기존 Camera Zoom 동작과 완전 입력 차단 규약 재사용
- `dispose()` 시 Minimap Layout/Projection reference, 활성 Pointer Capture, Viewport ResizeObserver, Minimap/Action/Zoom Listener, 공통 State 구독 및 DOM 정리
- Root 선택 상태는 포함하지 않음

### `graphNavigatorMinimap.ts`

> 현재 Layout과 저장 Node 위치를 DOM 없이 Minimap Bounds 및 좌표로 변환합니다.

- Renderer와 공통 `resolveGraphLayoutNodePosition()`을 사용해 저장 위치를 Layout 기본 위치보다 우선
- 현재 Layout에 포함된 유효 Node의 실제 위치와 width/height로 Multi-Root World Bounds 계산
- Empty 또는 유효 Node가 없는 Layout은 가상 Bounds 없이 `undefined`로 처리
- 고정 Padding 안에서 `min(scaleX, scaleY)` 단일 scale과 남는 축 중앙 정렬 적용
- World origin과 Minimap origin 기반 World ↔ Minimap 양방향 Projection 제공
- Node Rect와 source 오른쪽 중앙 → target 왼쪽 중앙 Edge Line geometry 생성
- 존재하지 않는 Node를 참조하는 Edge는 전체 계산을 중단하지 않고 제외
- 기존 `camera.viewportToWorld()`로 실제 Graph Viewport 좌상단/우하단의 World Bounds 계산
- Camera World Bounds를 기존 Graph Projection으로 변환하고 SVG 영역에 안전하게 Clamp
- Indicator geometry는 계산 결과만 제공하며 Camera 또는 Navigation 상태를 소유하지 않음
- Client Point를 실제 SVG 크기와 논리 Minimap 크기 차이를 반영해 변환
- Drag 시작/현재 Minimap Point를 같은 Projection으로 역투영해 World 이동량 제공
- Pointer session, Camera 상태와 DOM Listener는 소유하지 않음

### `graphNavigatorRoots.ts`

> Graph Root를 Navigator Root Item이 사용할 표시 데이터로 변환합니다.

- `Graph.roots` 순서를 유지해 `rootId`, `nodeId`, `name`, `kind`로 projection
- Root 이름과 Project/Folder/File kind를 `graph.rootNodes` 직접 참조로 조회
- 선택적 `context.relativePath`를 경로 재계산 없이 그대로 전달
- Root Node가 없는 잘못된 Root 참조만 건너뛰고 입력 Graph는 변경하지 않음
- 이 변환 모듈은 Root Item DOM 렌더링과 Detach/Reattach 실시간 동기화를 담당하지 않음

### `graphNodeDrag.ts`

> Project Root, Folder 및 File Group Card의 자유 이동을 관리합니다.

- 별도 Handle 없이 Node 자체에서 Pointer Drag 시작
- Pointer Capture와 Click / Drag threshold 처리
- Screen 이동량을 시작 Camera scale로 나눠 World 좌표 계산
- Pointer move 중 Graph State를 변경하지 않고 Node와 Edge DOM만 갱신
- `pointerup` 시 최종 World 위치를 Graph State에 한 번 저장
- Drag move / end / cancel 관찰 hook으로 기존 lifecycle 안에서 Reattach 판정 지원
- Reattach가 Drag 종료를 소비한 경우에만 일반 `nodePositions` 저장 생략
- `pointercancel`과 `lostpointercapture` 시 임시 위치 복원
- Layout Reflow 뒤 저장 위치가 없는 Node의 Drag 기준점을 새 기본 위치로 갱신
- File Row의 `data-graph-node-drag-ignore` 입력 차단 규약 처리
- `standalone` File Group은 File ID로 일반 Graph Node Drag와 위치 저장 경로 사용

### `graphRootPromotion.ts`

> Folder/File의 Root 추가·제거와 실제 Tree 기반 Context 경로 계산을 담당합니다.

- 현재 Graph Root 경계를 존중하며 원본 Tree 관계로 Folder/File 탐색
- Node ID 문자열을 경로나 Parent 추론에 사용하지 않음
- Folder/File 공통 `addGraphRoot()`로 immutable Graph snapshot 생성
- Project, 기존 Root와 존재하지 않는 Node의 Promotion 거부
- 결정적인 Promoted Root, Folder Backlink 및 singleton File Backlink ID 생성
- 새 Context를 `Source Root Context + Source Root 이름 + Target 중간 Parent 경로`로 계산
- Context에서 Target 자신의 이름을 제외하고 `/` separator와 trailing slash 유지
- 중첩 Promoted Root 내부 Promotion도 최초 Graph 기준 부모 경로 연결
- `applyDetachedGraphRoots()`로 저장된 Node ID를 현재 Graph에 순차 적용하고 누락 Node는 무시
- `removeGraphRoot()`로 Root 목록과 직접 Root Node 참조를 immutable하게 제거

### `graphRootContext.ts`

> Root Context Label의 전체 부모 경로를 실제 표시 폭에 맞게 축약합니다.

- `relativePath` separator를 `/`로 정규화
- 허용 폭을 넘을 때 상위 segment부터 `…/` 형태로 제거
- 가장 짧은 경로도 넘치면 Unicode 문자 단위 trailing ellipsis 적용
- Renderer가 전달한 실제 텍스트 폭 측정 함수 사용

### `graphRenderer.ts`

> Layout을 기존 Edge / Node Layer에 렌더링하고 표시 위치 및 interaction을 관리합니다.

- Project Root, Folder와 File Group을 공통 Graph Node 경로로 렌더링
- 열린 상태에 따라 `folder-open.svg`와 `folder-closed.svg`를 기존 DOM에 적용
- Project/Folder icon과 `aria-expanded`를 `openedFolders`에 맞춰 갱신
- File 이름을 렌더링 시점에 icon 식별값으로 변환하여 로컬 SVG 표시
- File Group의 `presentation`에 따라 singleton은 독립 Node 형태로, 둘 이상의 File child는 현재 page 범위까지 Group Row로 렌더링
- File을 5개 단위로 추가하는 `+ N개 더보기` Button과 최초 page로 복원하는 접기 Button 표시
- Page가 바뀐 File Group의 contents와 Listener만 교체
- Folder, `standalone`/`grouped` File Group 및 File Row Click callback 구분
- File Row Click 전파를 차단하고 해당 Row에만 Click animation 적용
- Root가 아닌 Folder와 standalone/grouped File에만 Detach Handle 표시
- Folder Backlink와 grouped/singleton File Backlink를 기존 Node/Row 표현으로 렌더링
- Backlink 클릭 시 공통 `targetRootId`, Context Label 클릭 시 현재 `rootId` 전달
- `targetRootId → HTMLElement` registry로 세 Backlink 유형의 최신 DOM 관리
- Backlink DOM의 client rect/중심 조회와 Layout 변경·dispose 시 registry 정리
- Root Drag Pointer와 자신의 Backlink rect만 비교해 Reattach Target 판정
- Backlink DOM이 닫힌 Folder나 Pagination 밖에 있어 registry에 없으면 Reattach Target에서 제외
- Reattach 가능 영역에 `is-reattach-target` 상태를 적용하고 이탈·종료·취소 시 제거
- Root Context Label을 Root 폭의 1.5배 안에서 측정·축약하고 Graph 입력 충돌 차단
- Parent 오른쪽 중앙과 Child 왼쪽 중앙을 Cubic Bezier Edge로 연결
- Camera-only State 변경 시 Node / Edge 위치 갱신 생략
- 저장 위치가 바뀐 Node와 직접 연결된 Edge만 갱신
- Layout Reflow 시 기존 Node DOM의 크기, 기본 위치와 Edge geometry 갱신
- 저장된 Node 위치는 유지하고 저장되지 않은 Node에는 새 Layout 기본 위치 적용
- `dispose()` 시 DOM, Listener, Drag controller 및 State 구독 정리

### `graphView.css`

> Graph Node, Context Label, Backlink와 interaction 상태의 시각 표현을 정의합니다.

- Project / Folder / File Group과 Edge, Detach Handle 스타일
- Folder/File Backlink의 반투명 상태와 공통 화살표 표시
- Root Context Label의 클릭 가능한 회색 부모 경로 표현
- Detach Drag 및 Reattach Target 최소 활성 상태
- Floating Root List Panel의 Button Hover/Focus/Active, Ellipsis와 목록 Scroll 스타일
- Minimap Background 탐색 Cursor와 Viewport Indicator Grab/Grabbing 상태
- 알림 Button/Badge, Scroll Panel, Activity 행 Animation 및 삭제 interaction 스타일
- VS Code Theme 변수와 High Contrast outline을 사용하는 알림 Center 상태 표현

### `graphState.ts`

> Camera, 사용자가 이동한 Node 위치, File Group page와 열린 Folder를 포함한 Graph 전체 상태를 관리합니다.

- 기본 Camera 상태와 빈 Node 위치, File Group page 및 `openedFolders` 적용
- 빈 `openedFolders`를 모든 Folder가 닫힌 초기 상태로 해석
- 외부에서 직접 변경할 수 없는 State snapshot 제공
- Graph State 조회 및 변경
- `isFolderOpened()` 조회와 `toggleFolder()` 기반 sparse opened 상태 관리
- File Group별 page 조회, 5개 단위 더보기 및 최초 page로 접기
- Page별 표시 File 수와 남은 File 수 계산
- State 변경 구독 및 구독 해제
- 이동한 Node의 World 좌표만 `nodePositions`에 저장
- 복원 후보의 Graph 상태 검증 및 독립 객체 복사
- `nodePositions`, `fileGroupPages`, `openedFolders` 또는 `detachedRootNodeIds`가 없는 상태를 빈 값으로 파싱
- 동일한 `nodePositions` 객체의 reference fast-path 비교
- Node 위치, File Group page 및 opened Folder 값 비교와 snapshot 참조 재사용
- Detached Root Node ID sparse record의 parse, snapshot, equality 및 기존 저장 상태 호환 복원
- Camera `scale` 최소값과 최대값 적용

### `graphView.ts`

> Graph를 렌더링할 DOM 계층과 Graph View lifecycle을 관리합니다.

- Viewport, World, Edge / Node / Overlay Layer 생성
- 전달된 Multi-Root Graph를 하나의 Layout / Renderer 경로로 처리
- 실행 중 `currentGraph` immutable snapshot과 최신 Layout 유지
- persisted `detachedRootNodeIds`를 초기 Workspace Graph에 `applyDetachedGraphRoots()`로 재적용
- 현재 Graph에 없는 저장 Node ID는 상태에서 삭제하지 않고 복원 적용만 건너뜀
- Root도 일반 Container와 같은 Open/Close interaction 및 Reflow 경로 사용
- 전달받은 초기 `GraphState`로 새 Store 초기화
- 복원된 File Group page와 opened Folder를 반영한 같은 초기 Layout을 Renderer와 Navigator에 전달
- `fileGroupPages` 또는 `openedFolders` reference 변경 시 한 번 생성한 Layout을 Renderer와 Navigator에 함께 적용
- Camera 및 Node 위치만 바뀌면 Layout Reflow 생략
- Detach Drop client 좌표를 viewport-local과 World 좌표로 변환해 새 Root 위치와 Detached Root Node ID를 함께 저장
- Folder/File 공통 Root Promotion 후 최신 Root/Backlink/Context를 Renderer와 Navigator의 한 번의 공통 Layout 갱신으로 반영
- Backlink 클릭 시 저장 위치 또는 Layout 위치의 실제 Root 중심으로 Focus
- Context Label 클릭 시 Backlink DOM client 중심을 World 좌표로 변환해 Focus
- Promoted Root를 자신의 Backlink에 Drop하면 `removeGraphRoot()`로 Reattach
- Reattach 시 해당 Root의 독립 위치와 Detached Root Node ID를 제거하고 Camera, Open, Pagination과 다른 위치 유지
- Reflow, Detach와 Reattach가 `applyGraphLayout()`을 통해 동일 Layout reference를 Renderer와 Navigator에 전달
- 초기 Camera 상태를 World transform과 Grid에 적용
- Overlay Navigator 초기화 후 최초 Graph를 `createGraphNavigatorRoots()`로 변환해 Root 목록에 전달
- Navigator Root 선택 시 저장된 `nodePositions`를 우선하고 현재 Layout 위치로 fallback해 기존 Camera Focus 요청
- Root Focus는 현재 Camera scale과 기존 ease-out Animation 정책을 유지
- Activity/Session runtime Store가 함께 주입되면 Overlay 우측 상단 알림 Center 초기화
- 알림 Focus에서 Target 자신은 열지 않고 표시에 필요한 ancestor, Filter와 File pagination만 복원한 최신 Layout 중심으로 Camera 이동
- Workspace 범위 안이지만 snapshot에 아직 없는 알림 Focus는 보류하고 Graph 갱신에서 Target이 나타나는 즉시 reveal/Focus 재시도
- 현재 Workspace URI 경계 밖의 unavailable 알림은 Focus를 비활성화하고 삭제만 허용
- 알림 삭제를 기존 `AgentActivityStore.clearAgentActivity()`에 연결해 알림, Graph Binding과 Effect를 같은 경로로 정리
- Graph 교체와 가시 영역 변경을 알림 Target 표시 index와 Overlay 위치에 동기화
- 초기화와 성공한 Detach/Reattach에서 공통 projection으로 최신 `currentGraph.roots`를 Navigator에 동기화
- 실패한 Promotion/Reattach에서는 Root 목록을 유지하고 Panel Open 상태와 독립적으로 Content만 교체
- 외부 Graph 기능을 위한 State와 Camera 인터페이스 제공
- `dispose()` 시 알림 Center를 포함한 Layout 구독, Navigator, Renderer, Camera와 Graph View DOM 정리
