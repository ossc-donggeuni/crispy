# `src/webview/graph/`

하나의 VS Code Webview 안에서 Project / Folder / File을 Root로 사용할 수 있는 Multi-Root Tree Graph를 렌더링하고 Camera 상태와 Pan / Zoom 및 Node 이동 동작을 관리한다.

Graph는 `GraphRoot[]`와 Project/Folder/File을 허용하는 Root Node Map을 입력으로 사용한다. 기존 단일 Workspace도 Root가 하나인 같은 구조로 처리한다. `Graph.roots`만 Root 여부를 결정하고, children 포함 여부는 `openedFolders`가 별도로 결정한다. Camera, Node 위치, Open 및 Pagination은 Graph State로 관리하며 저장되지 않은 Node에는 deterministic Layout의 기본 World 좌표를 적용한다. File Group page가 바뀌면 표시 Row 수에 맞춰 Layout을 다시 계산한다. 실제 Workspace나 파일 시스템은 조회하지 않는다.

## 구조

```text
src/webview/graph/
├── assets/
├── fileIconResolver.ts
├── graphCamera.ts
├── graphDetachDrag.ts
├── graphLayout.ts
├── graphMockData.ts
├── graphModel.ts
├── graphNavigator.ts
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

> Overlay에서 Camera 표시와 Zoom Control, 확장 가능한 Navigator Action을 관리합니다.

- 복원된 Graph State 기준으로 좌표와 scale 최초 표시
- Camera State 변경 구독 및 표시 갱신
- 세로형 Action Rail과 활성화된 Root 목록 Action Button 표시
- Navigator 로컬 상태로 제목만 있는 Root List Panel Shell 열기/닫기
- 기존 Camera Zoom 동작과 완전 입력 차단 규약 재사용
- `dispose()` 시 Action/Zoom Button Listener, State 구독 및 DOM 정리

### `graphNavigatorRoots.ts`

> Graph Root를 Navigator Root Item이 사용할 표시 데이터로 변환합니다.

- `Graph.roots` 순서를 유지해 `rootId`, `nodeId`, `name`, `kind`로 projection
- Root 이름과 Project/Folder/File kind를 `graph.rootNodes` 직접 참조로 조회
- 선택적 `context.relativePath`를 경로 재계산 없이 그대로 전달
- Root Node가 없는 잘못된 Root 참조만 건너뛰고 입력 Graph는 변경하지 않음
- Root Item DOM 렌더링과 Detach/Reattach 실시간 동기화는 포함하지 않음

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
- `nodePositions`, `fileGroupPages` 또는 `openedFolders`가 없는 상태를 빈 값으로 파싱
- 동일한 `nodePositions` 객체의 reference fast-path 비교
- Node 위치, File Group page 및 opened Folder 값 비교와 snapshot 참조 재사용
- Camera `scale` 최소값과 최대값 적용

### `graphView.ts`

> Graph를 렌더링할 DOM 계층과 Graph View lifecycle을 관리합니다.

- Viewport, World, Edge / Node / Overlay Layer 생성
- 전달된 Multi-Root Graph를 하나의 Layout / Renderer 경로로 처리
- 실행 중 `currentGraph` immutable snapshot과 최신 Layout 유지
- 별도 detached 상태 없이 `currentGraph.roots`를 실행 중 Root의 단일 기준으로 사용
- Root도 일반 Container와 같은 Open/Close interaction 및 Reflow 경로 사용
- 전달받은 초기 `GraphState`로 새 Store 초기화
- 복원된 File Group page와 opened Folder를 반영해 Layout과 Renderer 초기화
- `fileGroupPages` 또는 `openedFolders` reference 변경 시 Layout Reflow 적용
- Camera 및 Node 위치만 바뀌면 Layout Reflow 생략
- Detach Drop client 좌표를 viewport-local과 World 좌표로 변환해 새 Root 위치로 저장
- Folder/File 공통 Root Promotion 후 최신 Root/Backlink/Context를 한 번의 Layout 갱신으로 반영
- Backlink 클릭 시 저장 위치 또는 Layout 위치의 실제 Root 중심으로 Focus
- Context Label 클릭 시 Backlink DOM client 중심을 World 좌표로 변환해 Focus
- Promoted Root를 자신의 Backlink에 Drop하면 `removeGraphRoot()`로 Reattach
- Reattach 시 해당 Root의 독립 위치만 제거하고 Camera, Open, Pagination과 다른 위치 유지
- 초기 Camera 상태를 World transform과 Grid에 적용
- Overlay Navigator 초기화
- 외부 Graph 기능을 위한 State와 Camera 인터페이스 제공
- `dispose()` 시 Layout 구독, Navigator, Renderer, Camera와 Graph View DOM 정리
