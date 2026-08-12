import type { DockPosition, PanelLayoutState } from './panelState';

/**
 * Agent Chat의 Dock 이동, Preview 표시, 반응형 bottom 전환을 초기화한다.
 *
 * @param layout Graph와 Agent Chat을 포함하는 전체 Layout 요소
 * @param dragHandle Agent Chat 이동을 시작하는 전용 Drag Handle 요소
 * @param dockPreview 드래그 중 배치 후보 영역을 표시하는 단일 Preview 요소
 * @param state 사용자가 선택한 위치와 Panel 크기를 담는 Layout 상태
 * @param onPreferredDockChange 사용자가 선호 Dock 위치를 변경한 뒤 실행할 콜백
 * @returns Panel 크기나 Webview 너비가 변경됐을 때 실제 Dock 위치를 다시 계산하는 함수
 */
export function initializePanelDock(
	layout: HTMLElement,
	dragHandle: HTMLElement,
	dockPreview: HTMLElement,
	state: PanelLayoutState,
	onPreferredDockChange: () => void,
): () => void {
	let activePointerId: number | undefined;
	let candidateDock: DockPosition | undefined;

	/**
	 * 선호 위치와 현재 가용 너비를 비교하여 실제 Dock 위치를 계산하고 Layout에 반영한다.
	 * 좌우 공간이 부족한 경우 선호 위치는 보존한 채 실제 위치만 bottom으로 전환한다.
	 */
	const refreshDock = () => {
		const prefersSide = state.preferredDock === 'left' || state.preferredDock === 'right';
		const lacksSideSpace = layout.clientWidth - state.sideSize < state.sideSize;

		const effectiveDock: DockPosition = prefersSide && lacksSideSpace
			? 'bottom'
			: state.preferredDock;
		layout.dataset.dock = effectiveDock;
	};

	/**
	 * 현재 Dock 후보를 초기화하고 Preview 요소를 화면에서 숨긴다.
	 */
	const hidePreview = () => {
		candidateDock = undefined;
		dockPreview.hidden = true;
		delete dockPreview.dataset.dock;
	};

	/**
	 * 진행 중인 Dock 드래그 상태를 종료하고 Drag Handle의 Pointer Capture를 해제한다.
	 *
	 * @param pointerId 종료할 Pointer의 식별자
	 */
	const stopDragging = (pointerId: number) => {
		activePointerId = undefined;
		layout.classList.remove('is-dock-dragging');

		if (dragHandle.hasPointerCapture(pointerId)) {
			dragHandle.releasePointerCapture(pointerId);
		}
	};

	/**
	 * 기본 Pointer로 Drag Handle을 누르면 Dock 이동을 시작하고 Pointer를 캡처한다.
	 *
	 * @param event Drag Handle에서 발생한 Pointer Down 이벤트
	 */
	const handleDragStart = (event: PointerEvent) => {
		if (!event.isPrimary || event.button !== 0) {
			return;
		}

		event.preventDefault();
		activePointerId = event.pointerId;
		hidePreview();
		layout.classList.add('is-dock-dragging');
		dragHandle.setPointerCapture(event.pointerId);
	};

	/**
	 * 드래그 중인 Pointer 위치에서 가장 가까운 Dock 방향을 계산하고 Preview를 표시한다.
	 *
	 * @param event 캡처된 Pointer의 이동 이벤트
	 */
	const handleDragMove = (event: PointerEvent) => {
		if (event.pointerId !== activePointerId) {
			return;
		}

		event.preventDefault();
		candidateDock = getDockCandidate(layout, event.clientX, event.clientY);

		if (!candidateDock) {
			hidePreview();
			return;
		}

		dockPreview.dataset.dock = candidateDock;
		dockPreview.hidden = false;
	};

	/**
	 * 유효한 Preview 위치에서 Pointer를 놓으면 선호 Dock 위치를 저장하고 Layout을 갱신한다.
	 * Webview 영역 밖에서 놓은 경우 기존 위치를 유지한다.
	 *
	 * @param event 캡처된 Pointer의 Up 이벤트
	 */
	const handleDragEnd = (event: PointerEvent) => {
		if (event.pointerId !== activePointerId) {
			return;
		}

		const isInsideLayout = getDockCandidate(layout, event.clientX, event.clientY) !== undefined;

		if (candidateDock && isInsideLayout && candidateDock !== state.preferredDock) {
			state.preferredDock = candidateDock;
			refreshDock();
			onPreferredDockChange();
		}

		hidePreview();
		stopDragging(event.pointerId);
	};

	/**
	 * 브라우저가 Pointer 동작을 취소하면 Dock 위치를 변경하지 않고 드래그 상태를 정리한다.
	 *
	 * @param event 취소된 Pointer 이벤트
	 */
	const handleDragCancel = (event: PointerEvent) => {
		if (event.pointerId !== activePointerId) {
			return;
		}

		hidePreview();
		stopDragging(event.pointerId);
	};

	/**
	 * 예기치 않게 Pointer Capture를 잃으면 Preview와 드래그 상태를 안전하게 초기화한다.
	 *
	 * @param event Capture를 잃은 Pointer 이벤트
	 */
	const handleLostPointerCapture = (event: PointerEvent) => {
		if (event.pointerId !== activePointerId) {
			return;
		}

		hidePreview();
		activePointerId = undefined;
		layout.classList.remove('is-dock-dragging');
	};

	dragHandle.addEventListener('pointerdown', handleDragStart);
	dragHandle.addEventListener('pointermove', handleDragMove);
	dragHandle.addEventListener('pointerup', handleDragEnd);
	dragHandle.addEventListener('pointercancel', handleDragCancel);
	dragHandle.addEventListener('lostpointercapture', handleLostPointerCapture);

	const resizeObserver = new ResizeObserver(refreshDock);
	resizeObserver.observe(layout);
	refreshDock();

	return refreshDock;
}

/**
 * Layout 내부의 Pointer 위치와 네 모서리 방향까지의 거리를 비교해 가장 가까운 Dock 후보를 구한다.
 *
 * @param layout Dock 후보를 계산할 전체 Layout 요소
 * @param clientX Webview viewport 기준 Pointer의 가로 좌표
 * @param clientY Webview viewport 기준 Pointer의 세로 좌표
 * @returns 가장 가까운 Dock 방향이며, Pointer가 Layout 밖에 있으면 undefined
 */
function getDockCandidate(
	layout: HTMLElement,
	clientX: number,
	clientY: number,
): DockPosition | undefined {
	const bounds = layout.getBoundingClientRect();

	if (
		clientX < bounds.left
		|| clientX > bounds.right
		|| clientY < bounds.top
		|| clientY > bounds.bottom
	) {
		return undefined;
	}

	const distances: Array<[DockPosition, number]> = [
		['top', clientY - bounds.top],
		['left', clientX - bounds.left],
		['right', bounds.right - clientX],
		['bottom', bounds.bottom - clientY],
	];

	let nearest = distances[0];

	for (const distance of distances.slice(1)) {
		if (distance[1] < nearest[1]) {
			nearest = distance;
		}
	}

	return nearest[0];
}
