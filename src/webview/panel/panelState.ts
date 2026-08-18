export type DockPosition = 'left' | 'right' | 'top' | 'bottom';

export interface PanelLayoutState {
	preferredDock: DockPosition;
	sideSize: number;
	verticalSize: number;
}

export const INITIAL_SIDE_SIZE = 360;
export const INITIAL_VERTICAL_SIZE = 300;

export const DEFAULT_PANEL_LAYOUT_STATE: Readonly<PanelLayoutState> = {
	preferredDock: 'right',
	sideSize: INITIAL_SIDE_SIZE,
	verticalSize: INITIAL_VERTICAL_SIZE,
};

/**
 * 복원 후보에서 유효한 Panel Layout 필드만 복사한다.
 *
 * @param value Panel Layout 상태 후보
 * @returns 검증 및 복사된 Panel Layout 상태이며, 값이 잘못되었으면 undefined
 */
export function parsePanelLayoutState(
	value: unknown,
): PanelLayoutState | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;

	if (
		!isDockPosition(candidate.preferredDock)
		|| !isPanelSize(candidate.sideSize)
		|| !isPanelSize(candidate.verticalSize)
	) {
		return undefined;
	}

	return {
		preferredDock: candidate.preferredDock,
		sideSize: candidate.sideSize,
		verticalSize: candidate.verticalSize,
	};
}

/**
 * 값이 지원하는 Dock 위치인지 확인한다.
 *
 * @param value Dock 위치 후보
 * @returns 지원하는 Dock 위치인지 여부
 */
function isDockPosition(value: unknown): value is DockPosition {
	return value === 'left'
		|| value === 'right'
		|| value === 'top'
		|| value === 'bottom';
}

/**
 * 값이 CSS 크기로 복원 가능한 유한한 양수인지 확인한다.
 *
 * @param value Panel 크기 후보
 * @returns 복원 가능한 크기인지 여부
 */
function isPanelSize(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
