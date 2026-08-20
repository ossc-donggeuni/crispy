# 테스트 범위

`pnpm test`는 TypeScript와 ESLint 검사, 번들 빌드 후 아래 VS Code Extension Test Suite를 실행한다.

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
- 이전 저장 상태에 부가 Graph 필드가 없어도 빈 상태로 호환 복원한다
- 잘못된 저장 상태와 HTML 상태는 안전하게 기본값으로 처리한다
- 잘못된 `getState()` 대신 유효한 HTML 초기 상태를 사용한다
- 저장 시 Panel과 Graph를 함께 독립적인 snapshot으로 `setState()`에 전달한다
- Graph snapshot을 저장하고 새 Store로 Round Trip한다
- serialize 후 restore해도 File Group page와 열린 Folder 상태를 유지한다
- Graph, Panel, Agent와 Terminal wiring을 전체 Webview lifecycle에 연결한다

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

- 기본 Camera와 빈 opened Folder 상태로 초기화한다
- 외부 객체와 분리된 immutable snapshot을 관리한다
- Folder를 열면 sparse 상태에 ID를 추가하고 닫으면 제거한다
- 여러 Folder의 열린 상태를 독립적으로 관리한다
- 저장되지 않은 File Group의 기본 page는 1이다
- `showMoreFiles()`는 해당 File Group의 page만 증가시키고 그룹별 상태를 독립 관리한다
- `collapseFileGroup()`은 현재 page와 관계없이 해당 File Group을 page 1로 복원한다
- 17개 File의 page별 표시 개수와 남은 개수를 계산한다
- File이 없거나 한 page 이하이고 page가 필요 범위보다 큰 경우를 제한한다
- 변경된 상태를 subscriber에 전달하고 unsubscribe 이후 호출하지 않는다
- 동일한 Node 위치 객체는 reference fast-path로 snapshot 참조를 재사용한다
- 다른 객체라도 Node 위치 값이 같으면 기존 snapshot 참조를 재사용한다
- opened Folder 값이 같으면 기존 snapshot 참조를 재사용한다
- Camera scale을 최소 및 최대 범위로 제한한다
- 유효한 Graph 상태를 독립적인 객체로 파싱한다
- 필드가 없는 기존 상태를 빈 Node 위치, page와 opened 상태로 파싱한다
- 잘못된 Graph 상태를 거부한다

## `graph/graphLayout.test.ts`

- Graph Root 모델이 Project / Folder / File Node를 모두 표현한다
- Context가 있는 Root만 Layout `rootContexts`로 전달한다
- File Root를 edge 없는 `standalone` File Group으로 배치한다
- Folder의 File 수에 따라 `standalone` / `grouped` presentation을 선택한다
- 승격된 Folder는 원래 Parent 아래 Backlink로, 자신의 Root에서는 실제 subtree로 배치한다
- 승격된 grouped File은 기존 순서와 item 수를 유지한 Backlink Row와 standalone Root로 배치한다
- singleton File Backlink Group은 실제 File Root와 충돌하지 않는 ID를 사용한다
- 기존 Project 하나를 Root 하나인 Graph Layout으로 호환 처리한다
- 여러 Root와 각 subtree를 하나의 World에 독립 배치한다
- 실제 Graph Mock이 중첩 Folder와 Folder별 여러 File을 포함한다
- Project Root도 `openedFolders`에 없으면 children을 제외한다
- 열린 Folder의 직계 children만 포함하고 닫힌 descendant subtree는 제외한다
- Folder를 닫으면 sibling을 남은 구조 기준으로 재배치한다
- opened 상태를 제거하면 닫히고 다시 추가하면 전체 Layout을 복원한다
- 여러 Folder의 opened 상태를 독립적으로 제거한다
- 각 Container의 직접 File을 하나의 안정적인 File Group으로 만든다
- Pagination 확인용 하위 Folder에 17개와 21개 File Group을 만든다
- 17개 File Group 높이를 page별 visible File 수에 맞게 계산한다
- File 수와 page 상태에 맞는 단일 pagination control 높이를 적용한다
- File Group 높이 증가를 기존 subtree 계산으로 다음 sibling 위치에 반영한다
- 여러 File Group의 page별 높이를 독립적으로 계산한다
- Project/Folder에서 직접 Child Folder와 File Group으로만 Edge를 만든다
- 동일 입력은 동일 Layout이며 같은 Depth는 같은 X Column에 놓인다
- Folder와 File Group을 동일한 폭과 조밀한 Depth 간격으로 배치한다
- 30px File Row와 pagination control 높이를 File Group Layout 높이에 반영한다

## `graph/graphRootPromotion.test.ts`

- Source Root 종류와 관계없이 Context, Root 이름과 Parent segment를 조합한다
- Node ID 문자열 대신 실제 Tree 관계로 Folder/File과 소속 Root를 찾는다
- Folder/File을 같은 immutable `addGraphRoot()` 경로로 추가한다
- Target 이름을 제외한 최초 Graph 기준 부모 경로를 Context로 저장한다
- Promoted Root 내부의 재차 Promotion에서 기존 Context와 Source Root 이름을 한 번만 연결한다
- 깊은 중첩과 Source Root 바로 아래 Target의 trailing slash 규칙을 유지한다
- Project, 기존 Root와 잘못된 Node ID의 Promotion을 안전하게 거부한다
- `removeGraphRoot()`가 Root 목록과 직접 Root 참조만 immutable하게 제거한다

## `graph/graphRootContext.test.ts`

- 허용 최대 폭 안의 Context 경로는 원문을 유지한다
- 최대 폭을 넘으면 상위 segment부터 제거하고 `…/`를 적용한다
- trailing slash 부모 경로도 같은 축약 규칙을 유지한다
- 마지막 segment도 넘치면 문자 단위 trailing ellipsis를 적용한다
- 문자 수가 아닌 제공된 실제 글리프 폭을 사용한다
- separator 정규화, 극단적으로 작은 폭과 결정적 결과를 검증한다

## `graph/graphRenderer.test.ts`

- Context가 있는 Folder/File Root에만 좌측 정렬 Label을 렌더링한다
- Context Label이 Root 이동을 따르며 Node Move, Detach, Camera Pan과 일반 Click을 시작하지 않는다
- `applyLayout()`에서 Context Label을 추가·갱신·제거한다
- File Root와 singleton File을 기존 standalone File Group 경로로 렌더링한다
- Root가 아닌 Folder와 standalone/grouped File에만 Detach Handle을 표시한다
- Folder와 grouped File Detach Drag가 올바른 Node와 client Drop 좌표를 전달한다
- Detach Handle이 Folder/File Click, Node Move와 Camera Pan을 시작하지 않는다
- 승격된 grouped File을 순서·pagination을 유지하는 Backlink Row로 렌더링한다
- Folder 및 singleton File Backlink가 정확한 `targetRootId`를 전달한다
- Folder/grouped/singleton Backlink DOM을 registry에 등록하고 실제 client 중심을 조회한다
- Layout 변경으로 Backlink가 제거되면 registry에서도 제거한다
- Root Context Label이 현재 Root ID를 전달한다
- Root Drag가 자기 Backlink에 진입·이탈할 때 Reattach Target 상태를 갱신한다
- cancel, capture 상실, Layout 변경과 dispose에서 Reattach Target을 정리한다
- Project Root, Folder, File Group과 Edge를 지정된 Layer에 렌더링한다
- File Row에 파일명 규칙과 확장자별 공통 SVG icon 식별값을 렌더링한다
- File이 5개 이하이면 pagination control을 렌더링하지 않는다
- 17개 File을 더보기로 모두 표시하고 Ghost 접기로 최초 상태에 복원한다
- File Group page를 독립 관리하고 변경된 Group contents만 갱신한다
- Folder, File Group, File Row Click callback을 구분한다
- File Row Click 전파를 차단하고 Row 전용 animation lifecycle을 처리한다
- Threshold를 넘긴 Node Drag 뒤 Click callback을 실행하지 않는다
- File Row Pointer 입력은 File Group Drag와 Camera Pan을 시작하지 않는다
- Folder, File Group, File Row 위 Wheel은 Cursor 기준 Camera Zoom을 수행한다
- Camera-only 변경은 Edge를 다시 계산하지 않고 Node 위치 변경만 반영한다
- `applyLayout()`은 Node와 Edge를 제거·추가하고 유지 DOM을 재사용한다
- 재추가된 File Group은 저장된 page만큼 File Row를 복원한다
- 반복 reconciliation과 `dispose()`가 listener를 중복 생성·정리하지 않는다
- `applyLayout()`은 동일 Node DOM의 size와 기본 위치 및 Edge geometry를 갱신한다
- `applyLayout()`은 저장된 위치를 유지하면서 File Group height와 Edge를 갱신한다
- `applyLayout()`은 Node 위치가 같아도 height가 바뀐 Edge endpoint를 갱신한다
- Reflow 뒤 최초 Drag는 갱신된 Layout 기본 위치를 기준으로 시작한다
- dispose 이후 `applyLayout()`은 기존 DOM geometry를 변경하지 않는다
- Project Root, Folder, File Group을 Pointer Capture와 Camera scale 기준 World 좌표로 이동한다
- Drag 중에는 Node/Edge DOM만 갱신하고 Pointer 종료 시 최종 위치를 한 번 저장한다
- `pointercancel`과 `lostpointercapture`는 임시 위치를 복원하고 저장하지 않는다
- Node 입력 차단 규약으로 Node Drag 중 Camera Pan을 시작하지 않는다
- Node 위치를 기존 Webview State로 저장하고 새 Store/Renderer에서 일부 위치만 복원한다

## `graph/fileIconResolver.test.ts`

- 지원 확장자를 지정된 File icon 식별값으로 변환한다
- TypeScript declaration과 특수 파일명 규칙을 일반 확장자보다 우선한다
- 확장자와 특수 파일명 대소문자를 구분하지 않는다
- 미지원 확장자와 확장자가 없는 파일에 공통 fallback을 적용한다

## `graph/graphView.test.ts`

- 한 번 생성한 같은 Layout reference를 Renderer와 Navigator에 함께 적용한다
- Layout Reflow 중 Minimap을 포함한 Navigator DOM을 재생성하지 않는다
- 여러 Root의 저장 위치를 같은 Graph World에서 독립적으로 적용한다
- 저장 위치를 우선하고 Layout 크기를 fallback으로 Folder/File Root 중심을 계산한다
- Folder/File Backlink가 전달한 Root ID를 공통 Root Focus 경로로 처리한다
- Folder/grouped/singleton Root Context 클릭을 실제 Backlink client 중심의 World 좌표 Focus로 변환한다
- Backlink DOM이 없으면 Context Focus를 안전하게 무시한다
- Folder/File Detach Drop을 공통 Root Promotion과 Drop World 위치 저장으로 연결한다
- Promotion 직후 실제 Root, Folder/File Backlink와 자동 Context Label을 같은 갱신에 반영한다
- Promoted Folder/grouped/singleton Root를 자신의 Backlink Drop으로 Reattach한다
- 다른 Root Backlink, 일반 Drop, 숨겨진 Backlink와 기본 Project Root는 Reattach하지 않는다
- Reattach 시 대상의 독립 위치만 제거하고 Camera, Open, Pagination 및 다른 Node 위치를 유지한다
- Reattach 후 Folder/File을 원래 Tree presentation으로 복원한다
- 초기 Graph Camera 상태를 Store와 World transform에 복원한다
- Project Root와 Folder를 같은 Open/Close interaction으로 처리한다
- 복원된 File Group page를 최초 Layout 높이와 Renderer contents에 반영한다
- 더보기와 접기가 File Group size, sibling 위치와 Edge를 함께 Reflow한다
- Layout 입력 변경만 Reflow하고 Camera와 Node 위치 변경은 건너뛰며 Renderer/Navigator에 같은 Layout을 전달한다

## `graph/graphNavigator.test.ts`

- 빈 Minimap과 Zoom Controls를 같은 하단 Row에 왼쪽부터 배치한다
- 초기 Layout과 갱신 Layout을 받으면서 Navigator와 Minimap DOM을 유지한다
- Minimap에 기존 Camera 완전 입력 차단 규약을 적용한다
- Minimap의 Pointer와 Wheel 입력으로 Camera Pan/Zoom을 시작하지 않는다
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
- `focusOn()`이 scale을 유지하며 ease-out으로 목표 World 지점을 Viewport 중앙에 배치한다
- 새 Focus 요청이 기존 Frame을 취소하고 현재 Camera 상태에서 다시 시작한다
- Focus Animation 중 사용자 Pan / Zoom이 Animation을 취소한다
- `dispose()`가 Focus Animation을 취소하고 이후 갱신을 막는다
- Wheel Zoom Out과 Zoom In을 scale 범위에서 제한한다
- Camera 입력 차단 속성이 지정된 요소에서 Wheel로 Zoom하지 않는다
- `lostpointercapture`와 `dispose()`가 진행 상태 및 등록한 이벤트를 정리한다
