import { createElement } from './componentTypes';

/** type GraphToolbarOptions
 *
 * - Toolbar 버튼이 실행할 Fit View와 Zoom 동작을 정의한다.
 */
export type GraphToolbarOptions = {
	onFitView: () => void;
	onZoomIn: () => void;
	onZoomOut: () => void;
};

/** type GraphToolbar
 *
 * - 렌더링된 Toolbar 요소와 Zoom 표시 갱신 함수를 정의한다.
 */
export type GraphToolbar = {
	element: HTMLElement;
	updateZoom: (zoom: number) => void;
};

/** function createToolbarButton( label, title, onClick )
 *
 * - GraphToolbar에서 공통으로 사용하는 동작 버튼을 만든다.
 *
 * @param label 	버튼에 표시할 문자열
 * @param title 	Hover와 접근성에 사용할 동작 설명
 * @param onClick Click 시 실행할 Canvas 동작
 * @returns 		렌더링된 Toolbar 버튼
 */
function createToolbarButton(
	label: string,
	title: string,
	onClick: () => void,
): HTMLButtonElement {
	const button = createElement('button', 'toolbar-button', label);
	button.type = 'button';
	button.title = title;
	button.addEventListener('click', onClick);
	return button;
}

/** function createGraphToolbar( options )
 *
 * - Zoom Out, 현재 Zoom, Zoom In, Fit View Control을 구성한다.
 * - GraphView가 Zoom 표시를 갱신할 수 있는 함수와 Toolbar 요소를 반환한다.
 *
 * @param options 각 Toolbar 버튼이 호출할 GraphView 동작
 * @returns 		Toolbar 요소와 Zoom 갱신 함수
 */
export function createGraphToolbar(options: GraphToolbarOptions): GraphToolbar {
	const toolbar = createElement('div', 'graph-toolbar');
	toolbar.setAttribute('role', 'toolbar');
	toolbar.setAttribute('aria-label', 'Graph viewport controls');

	const zoomOut = createToolbarButton('−', 'Zoom out', options.onZoomOut);
	const zoomValue = createElement('output', 'zoom-value', '100%');
	zoomValue.setAttribute('aria-label', 'Current zoom');
	const zoomIn = createToolbarButton('+', 'Zoom in', options.onZoomIn);
	const fit = createToolbarButton('Fit View', 'Fit all open boxes', options.onFitView);
	fit.classList.add('fit-button');

	toolbar.append(zoomOut, zoomValue, zoomIn, fit);
	return {
		element: toolbar,
		// GraphView의 소수 Zoom 값을 사용자가 읽을 수 있는 백분율로 변환한다.
		updateZoom: (zoom: number) => {
			zoomValue.textContent = `${Math.round(zoom * 100)}%`;
		},
	};
}
