import type { DockPosition } from '../panel/panelState';

/** Graph Camera와 Overlay가 함께 사용하는 Viewport local 표시 영역이다. */
export interface GraphVisibleArea {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly width: number;
	readonly height: number;
	readonly center: Readonly<{ x: number; y: number }>;
}

/** Graph Viewport의 Camera 좌표계 크기다. */
export interface GraphViewportSize {
	readonly width: number;
	readonly height: number;
}

/** Camera와 Navigator가 호출 시점의 동일한 표시 영역을 조회하는 함수다. */
export type GraphVisibleAreaProvider = () => GraphVisibleArea;

/** 전체 Viewport를 가리지 않은 Graph 표시 영역으로 만든다. */
export function createFullGraphVisibleArea(
	viewportSize: GraphViewportSize,
): GraphVisibleArea {
	return createGraphVisibleArea(0, 0, viewportSize.width, viewportSize.height);
}

/**
 * Floating Chat의 실제 client bounds와 Dock 방향으로 가리지 않은 연속 Graph 영역을 계산한다.
 * 좌우 Dock은 Panel의 안쪽 세로 경계, 상하 Dock은 안쪽 가로 경계를 사용한다.
 */
export function calculateGraphVisibleArea(
	viewportSize: GraphViewportSize,
	viewportBounds: Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>,
	panelBounds: Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>,
	dock: DockPosition,
	collapsed: boolean,
): GraphVisibleArea {
	const fullArea = createFullGraphVisibleArea(viewportSize);

	if (
		collapsed
		|| panelBounds.width <= 0
		|| panelBounds.height <= 0
		|| viewportSize.width <= 0
		|| viewportSize.height <= 0
	) {
		return fullArea;
	}

	const horizontalScale = viewportBounds.width > 0
		? viewportSize.width / viewportBounds.width
		: 1;
	const verticalScale = viewportBounds.height > 0
		? viewportSize.height / viewportBounds.height
		: 1;
	const toViewportX = (clientX: number): number => clamp(
		(clientX - viewportBounds.left) * horizontalScale,
		0,
		viewportSize.width,
	);
	const toViewportY = (clientY: number): number => clamp(
		(clientY - viewportBounds.top) * verticalScale,
		0,
		viewportSize.height,
	);

	switch (dock) {
		case 'left':
			return createGraphVisibleArea(
				toViewportX(panelBounds.right),
				0,
				viewportSize.width,
				viewportSize.height,
			);
		case 'right':
			return createGraphVisibleArea(
				0,
				0,
				toViewportX(panelBounds.left),
				viewportSize.height,
			);
		case 'top':
			return createGraphVisibleArea(
				0,
				toViewportY(panelBounds.bottom),
				viewportSize.width,
				viewportSize.height,
			);
		case 'bottom':
			return createGraphVisibleArea(
				0,
				0,
				viewportSize.width,
				toViewportY(panelBounds.top),
			);
	}
}

/** 현재 DOM 표시 상태를 읽어 Camera와 Navigator가 공유할 Graph 영역을 반환한다. */
export function resolveGraphVisibleArea(
	viewport: HTMLElement,
	panel: HTMLElement,
	dock: DockPosition,
	collapsed: boolean,
): GraphVisibleArea {
	const viewportSize = {
		width: viewport.clientWidth,
		height: viewport.clientHeight,
	};

	if (collapsed || panel.hidden) {
		return createFullGraphVisibleArea(viewportSize);
	}

	return calculateGraphVisibleArea(
		viewportSize,
		viewport.getBoundingClientRect(),
		panel.getBoundingClientRect(),
		dock,
		false,
	);
}

/** 네 경계와 파생 크기/중심을 하나의 불변 값으로 묶는다. */
function createGraphVisibleArea(
	left: number,
	top: number,
	right: number,
	bottom: number,
): GraphVisibleArea {
	const width = Math.max(0, right - left);
	const height = Math.max(0, bottom - top);

	return {
		left,
		top,
		right,
		bottom,
		width,
		height,
		center: {
			x: left + width / 2,
			y: top + height / 2,
		},
	};
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
