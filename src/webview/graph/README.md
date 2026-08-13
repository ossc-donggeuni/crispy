# `src/webview/graph/`

Graph가 렌더링될 DOM 계층과 Camera의 Pan / Zoom 및 좌표 변환을 관리한다.

Graph World에만 Camera transform을 적용하며, Overlay Layer는 Viewport 좌표계를 유지한다.

## 구조

```text
src/webview/graph/
├── graphView.ts
├── graphCamera.ts
├── graphView.css
└── README.md
```

### `graphView.ts`

- Graph View의 기본 DOM 계층 생성
- `graph-viewport`, `graph-world`, Edge / Node / Overlay Layer 구성
- Graph Camera 초기화 및 외부 인터페이스 제공
- `dispose()`에서 Camera와 Graph View DOM 정리
- 중복 `dispose()`에 안전한 lifecycle 관리

### `graphCamera.ts`

- `x`, `y`, `scale` 기반 Camera 상태 관리
- `graph-world`의 `translate + scale` transform 갱신
- Viewport의 World Grid 위치와 간격을 Camera 상태에 동기화
- Pointer Capture 기반 Pan 처리
- Cursor 아래 World 위치를 유지하는 Wheel Zoom 처리
- 최소 / 최대 `scale` 제한
- Viewport / World 좌표 상호 변환
- Camera 입력 차단 DOM 규약 처리
- `dispose()`에서 Pointer / Wheel Listener와 진행 중인 Pointer 상태 정리

## DOM 계층

```text
graph-viewport
├── graph-world              ← Camera transform 적용
│   ├── graph-edge-layer
│   └── graph-node-layer
└── graph-overlay-layer      ← Camera transform 미적용
```

`graph-world`의 Edge Layer와 Node Layer는 동일한 World 좌표계를 사용한다.

`graph-overlay-layer`는 Inspector, Navigator 등 화면에 고정되는 UI를 위한 Layer이며 Camera transform을 적용하지 않는다.

## Camera 기본 상태

```ts
x = 0;
y = 0;
scale = 1;
```

`scale`은 `MIN_CAMERA_SCALE`과 `MAX_CAMERA_SCALE` 범위로 제한한다.

Camera 상태 변경은 DOM transform을 직접 수정하지 않고 `GraphCamera.setState()`를 통해 수행한다.

## Camera 입력 차단 규약

Camera 입력과 충돌하는 실제 Interactive Element에 `data-graph-camera-ignore` 속성을 지정한다.

```html
<button data-graph-camera-ignore>Graph UI</button>
```

- Camera는 이벤트 Target에서 가장 가까운 `[data-graph-camera-ignore]` 요소를 확인한다.
- 속성이 지정된 요소와 그 하위 요소에서는 Pan / Zoom을 실행하지 않는다.
- Overlay 내부의 클릭 가능한 UI는 `pointer-events: auto`와 해당 속성을 함께 사용해야 한다.

```css
.graph-overlay-control {
	pointer-events: auto;
}
```

`graph-overlay-layer` 자체에는 입력 차단 속성을 지정하지 않으며 기본 `pointer-events: none` 정책을 유지한다.
