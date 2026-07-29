import { createElement } from './componentTypes';

export type GraphToolbarOptions = {
	onFitView: () => void;
	onZoomIn: () => void;
	onZoomOut: () => void;
};

export type GraphToolbar = {
	element: HTMLElement;
	updateZoom: (zoom: number) => void;
};

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
		updateZoom: (zoom: number) => {
			zoomValue.textContent = `${Math.round(zoom * 100)}%`;
		},
	};
}
