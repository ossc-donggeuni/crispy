import {
	clampPanelSize,
	MIN_SIDE_SIZE,
	MIN_VERTICAL_SIZE,
	type DockPosition,
	type PanelLayoutState,
} from './panelState';

interface ResizeSession {
	pointerId: number;
	dock: DockPosition;
	startX: number;
	startY: number;

	/** Pointer 이동량의 기준이 되는 Resize 시작 시점의 표시 크기다. */
	startSize: number;

	/** 취소 시 되돌릴 사용자가 저장해 둔 크기다. */
	restoreSize: number;
}

/**
 * 저장된 Panel 크기를 현재 Webview에서 표시 가능한 크기로 제한해 Layout에 반영한다.
 * Graph는 Chat Panel과 독립적으로 전체 영역을 사용하므로 이 크기는 Floating Panel에만 적용된다.
 *
 * @param layout Graph 위에 Agent Chat을 띄우는 전체 Layout 요소
 * @param state 사용자가 저장한 가로·세로 크기를 담는 Layout 상태
 */
export function applyPanelSize(
	layout: HTMLElement,
	state: PanelLayoutState,
): void {
	layout.style.setProperty(
		'--chat-side-size',
		`${clampPanelSize(state.sideSize, layout.clientWidth, MIN_SIDE_SIZE)}px`,
	);
	layout.style.setProperty(
		'--chat-vertical-size',
		`${clampPanelSize(state.verticalSize, layout.clientHeight, MIN_VERTICAL_SIZE)}px`,
	);
}

/**
 * Floating Chat Panel 안쪽 경계의 Pointer 이벤트를 등록하고 Dock 방향에 맞는 크기 조절을 초기화한다.
 * Webview 크기가 변하면 저장된 크기는 유지한 채 표시 크기만 다시 제한한다.
 *
 * @param layout Graph 위에 Agent Chat을 띄우는 전체 Layout 요소
 * @param resizeHandle Chat Panel의 Graph를 향하는 경계에 있는 Resize Handle 요소
 * @param state 사용자가 선택한 Dock 위치와 가로·세로 크기를 담는 Layout 상태
 * @param onSizeChange 크기 변경 후 Layout 표시를 다시 계산하는 콜백
 * @param onResizeEnd Resize가 완료된 뒤 최종 크기를 저장하는 콜백
 * @param onLayoutResize Resize 완료 뒤 layout 의존 기능을 갱신하는 콜백
 */
export function initializePanelResize(
	layout: HTMLElement,
	resizeHandle: HTMLElement,
	state: PanelLayoutState,
	onSizeChange: () => void,
	onResizeEnd: () => void,
	onLayoutResize: () => void = () => undefined,
): void {
	let session: ResizeSession | undefined;

	applyPanelSize(layout, state);

	/**
	 * 진행 중인 Resize 세션을 종료하고 Resize Handle의 Pointer Capture를 해제한다.
	 *
	 * @param pointerId 종료할 Pointer의 식별자
	 */
	const stopResizing = (pointerId: number) => {
		session = undefined;
		layout.classList.remove('is-resizing');

		if (resizeHandle.hasPointerCapture(pointerId)) {
			resizeHandle.releasePointerCapture(pointerId);
		}
	};

	/**
	 * 취소된 Resize를 시작 크기로 되돌리고 진행 중인 세션과 Pointer Capture를 정리한다.
	 *
	 * @param pointerId 취소할 Pointer의 식별자
	 */
	const rollbackResize = (pointerId: number) => {
		if (!session) {
			return;
		}

		const isSideDock = session.dock === 'left' || session.dock === 'right';

		if (isSideDock) {
			state.sideSize = session.restoreSize;
		} else {
			state.verticalSize = session.restoreSize;
		}

		applyPanelSize(layout, state);
		onSizeChange();
		stopResizing(pointerId);
	};

	/**
	 * 기본 Pointer로 Resize Handle을 누르면 현재 Dock 방향과 시작 크기를 저장한다.
	 *
	 * @param event Resize Handle에서 발생한 Pointer Down 이벤트
	 */
	const handleResizeStart = (event: PointerEvent) => {
		if (!event.isPrimary || event.button !== 0) {
			return;
		}

		const dock = layout.dataset.dock;

		if (
			dock !== 'left'
			&& dock !== 'right'
			&& dock !== 'top'
			&& dock !== 'bottom'
		) {
			return;
		}

		event.preventDefault();
		const isSideDock = dock === 'left' || dock === 'right';
		const restoreSize = isSideDock ? state.sideSize : state.verticalSize;

		session = {
			pointerId: event.pointerId,
			dock,
			startX: event.clientX,
			startY: event.clientY,
			/** 좁은 Webview에서 표시 중인 크기를 기준으로 이동량을 적용한다. */
			startSize: isSideDock
				? clampPanelSize(restoreSize, layout.clientWidth, MIN_SIDE_SIZE)
				: clampPanelSize(restoreSize, layout.clientHeight, MIN_VERTICAL_SIZE),
			restoreSize,
		};

		layout.classList.add('is-resizing');
		resizeHandle.setPointerCapture(event.pointerId);
	};

	/**
	 * Pointer 이동량을 Dock 방향에 맞는 너비 또는 높이로 변환해 Agent Chat 크기를 갱신한다.
	 *
	 * @param event 캡처된 Pointer의 이동 이벤트
	 */
	const handleResizeMove = (event: PointerEvent) => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		event.preventDefault();
		const nextSize = getNextSize(layout, session, event.clientX, event.clientY);
		const isSideDock = session.dock === 'left' || session.dock === 'right';

		if (isSideDock) {
			state.sideSize = nextSize;
		} else {
			state.verticalSize = nextSize;
		}

		applyPanelSize(layout, state);
		onSizeChange();
	};

	/**
	 * Pointer를 놓으면 현재 크기를 유지한 채 Resize 세션을 정상 종료한다.
	 *
	 * @param event 캡처된 Pointer의 Up 이벤트
	 */
	const handleResizeEnd = (event: PointerEvent) => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		stopResizing(event.pointerId);
		onResizeEnd();
		onLayoutResize();
	};

	/**
	 * 브라우저가 Pointer 동작을 취소하면 시작 크기로 복원하고 세션과 Capture를 정리한다.
	 *
	 * @param event 취소된 Pointer 이벤트
	 */
	const handleResizeCancel = (event: PointerEvent) => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		rollbackResize(event.pointerId);
	};

	/**
	 * 예기치 않게 Pointer Capture를 잃으면 시작 크기로 복원하고 Resize 상태를 초기화한다.
	 *
	 * @param event Capture를 잃은 Pointer 이벤트
	 */
	const handleLostPointerCapture = (event: PointerEvent) => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		rollbackResize(event.pointerId);
	};

	resizeHandle.addEventListener('pointerdown', handleResizeStart);
	resizeHandle.addEventListener('pointermove', handleResizeMove);
	resizeHandle.addEventListener('pointerup', handleResizeEnd);
	resizeHandle.addEventListener('pointercancel', handleResizeCancel);
	resizeHandle.addEventListener('lostpointercapture', handleLostPointerCapture);

	/** Webview가 좁아져도 Floating Panel이 화면 밖으로 나가지 않도록 표시 크기만 다시 제한한다. */
	const resizeObserver = new ResizeObserver(() => applyPanelSize(layout, state));
	resizeObserver.observe(layout);
}

/**
 * Resize 시작점부터 현재 Pointer까지의 이동량을 Dock 방향에 맞게 적용하고 허용 범위로 제한한다.
 * 좌우 Dock은 너비를, 상하 Dock은 높이를 계산하며 최대 크기는 Floating Panel의 외곽 여백을 제외한다.
 *
 * @param layout 최대 크기를 결정할 전체 Layout 요소
 * @param session Resize 시작 시점의 Pointer, Dock 방향 및 크기 정보
 * @param clientX Webview viewport 기준 현재 Pointer의 가로 좌표
 * @param clientY Webview viewport 기준 현재 Pointer의 세로 좌표
 * @returns 최소 크기와 여백을 제외한 최대 크기 사이로 제한된 다음 Agent Chat 크기
 */
function getNextSize(
	layout: HTMLElement,
	session: ResizeSession,
	clientX: number,
	clientY: number,
): number {
	const horizontalDelta = clientX - session.startX;
	const verticalDelta = clientY - session.startY;

	switch (session.dock) {
		case 'left':
			return clampPanelSize(
				session.startSize + horizontalDelta,
				layout.clientWidth,
				MIN_SIDE_SIZE,
			);
		case 'right':
			return clampPanelSize(
				session.startSize - horizontalDelta,
				layout.clientWidth,
				MIN_SIDE_SIZE,
			);
		case 'top':
			return clampPanelSize(
				session.startSize + verticalDelta,
				layout.clientHeight,
				MIN_VERTICAL_SIZE,
			);
		case 'bottom':
			return clampPanelSize(
				session.startSize - verticalDelta,
				layout.clientHeight,
				MIN_VERTICAL_SIZE,
			);
	}
}
