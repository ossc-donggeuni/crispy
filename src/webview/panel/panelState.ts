export type DockPosition = 'left' | 'right' | 'top' | 'bottom';

export interface PanelLayoutState {
	preferredDock: DockPosition;
	sideSize: number;
	verticalSize: number;
	collapsed: boolean;
}

export const INITIAL_SIDE_SIZE = 460;
export const INITIAL_VERTICAL_SIZE = 400;

/** 좌우 Dock에서 Chat Panel이 가질 수 있는 최소 너비다. */
export const MIN_SIDE_SIZE = 240;

/** 상하 Dock에서 Chat Panel이 가질 수 있는 최소 높이다. */
export const MIN_VERTICAL_SIZE = 180;

/**
 * Floating Chat Panel과 Webview 외곽 사이에 남기는 여백이며
 * 이 여백 사이로 Graph가 보이도록 CSS의 `--chat-floating-margin`과 같은 값을 사용한다.
 */
export const PANEL_FLOATING_MARGIN = 12;

export const DEFAULT_PANEL_LAYOUT_STATE: Readonly<PanelLayoutState> = {
	preferredDock: 'right',
	sideSize: INITIAL_SIDE_SIZE,
	verticalSize: INITIAL_VERTICAL_SIZE,
	collapsed: false,
};

/**
 * Floating Panel의 양쪽 외곽 여백을 제외한 최대 표시 크기를 구한다.
 *
 * @param availableSize Webview에서 사용할 수 있는 가로 또는 세로 크기
 * @returns 외곽 여백을 제외하고 Panel이 차지할 수 있는 최대 크기
 */
export function getMaxPanelSize(availableSize: number): number {
	return Math.max(0, availableSize - PANEL_FLOATING_MARGIN * 2);
}

/**
 * 저장된 Panel 크기를 현재 Webview에서 표시 가능한 크기로 제한한다.
 * 저장된 크기 자체는 바꾸지 않으므로 Webview가 다시 넓어지면 원래 크기로 돌아간다.
 * 가용 영역이 최소 크기보다 작으면 최소 크기 대신 최대 크기를 사용한다.
 *
 * @param size 사용자가 저장했거나 Resize 중 계산한 Panel 크기
 * @param availableSize Webview에서 사용할 수 있는 가로 또는 세로 크기
 * @param minimumSize Dock 방향에 해당하는 최소 Panel 크기
 * @returns 최소 크기와 외곽 여백을 고려한 최대 크기 사이로 제한된 크기
 */
export function clampPanelSize(
	size: number,
	availableSize: number,
	minimumSize: number,
): number {
	const maximumSize = getMaxPanelSize(availableSize);
	const effectiveMinimum = Math.min(minimumSize, maximumSize);

	return Math.min(Math.max(size, effectiveMinimum), maximumSize);
}

/**
 * 복원 후보에서 유효한 Panel Layout 필드만 복사한다.
 * `collapsed`가 없는 이전 저장 상태는 펼침 상태로 호환 복원한다.
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
		|| !isOptionalCollapsed(candidate.collapsed)
	) {
		return undefined;
	}

	return {
		preferredDock: candidate.preferredDock,
		sideSize: candidate.sideSize,
		verticalSize: candidate.verticalSize,
		collapsed: candidate.collapsed ?? false,
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

/**
 * 접힘 여부가 없거나 boolean인지 확인한다.
 * 값이 없는 이전 저장 상태를 전체 무효 처리하지 않기 위해 undefined를 허용한다.
 *
 * @param value 접힘 여부 후보
 * @returns 복원 가능한 접힘 여부인지 여부
 */
function isOptionalCollapsed(value: unknown): value is boolean | undefined {
	return value === undefined || typeof value === 'boolean';
}
