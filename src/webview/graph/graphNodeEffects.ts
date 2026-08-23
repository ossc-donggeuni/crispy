import type {
	GraphNodeEffect,
	GraphNodeEffectKind,
	GraphNodeEffectTarget,
} from '../../messages';
import type {
	GraphLayout,
	GraphLayoutNode,
	GraphLayoutPosition,
} from './graphLayout';

interface GraphNodeEffectRegion {
	readonly element: HTMLElement;
	readonly layer: HTMLElement;
	bounds?: GraphNodeEffectRegionBounds;
}

interface GraphNodeEffectRegistration {
	readonly target: GraphNodeEffectTarget;
	readonly element: HTMLElement;
	readonly effectElements: Map<GraphNodeEffectKind, Element>;
	readonly layoutNodeId?: string;
	layer?: HTMLElement;
	region?: GraphNodeEffectRegion;
}

interface GraphNodeEffectRegionBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface GraphNodeEffectRegistrationOptions {
	/** Project/Folder occurrence의 visible subtree를 하나의 World Region으로 표시한다. */
	readonly layoutNodeId?: string;
}

/** Transient 효과 상태와 현재 Renderer DOM registration을 연결한다. */
export interface GraphNodeEffects {
	setNodeEffect(target: GraphNodeEffectTarget, effect: GraphNodeEffect): void;
	clearNodeEffect(target: GraphNodeEffectTarget, kind?: GraphNodeEffectKind): void;
	registerNode(
		target: GraphNodeEffectTarget,
		element: HTMLElement,
		options?: GraphNodeEffectRegistrationOptions,
	): () => void;
	/** 최신 World Layout으로 Parent effect region geometry를 동기화한다. */
	syncLayout(
		layout: GraphLayout,
		positions: ReadonlyMap<string, GraphLayoutPosition>,
		transitionDuration?: number,
	): boolean;
	dispose(): void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EFFECT_COLOR_PROPERTY = '--graph-node-effect-color';
const EFFECT_ANIMATION_DELAY_PROPERTY = '--graph-node-effect-animation-delay';
const EFFECT_REGION_TRANSITION_DURATION_PROPERTY =
	'--graph-node-effect-region-transition-duration';
const EFFECT_REGION_PADDING = 6;
const EFFECT_REGION_TRANSITION_CLASS = 'is-layout-transitioning';
const EFFECT_PULSE_SOURCE_CLASS = 'graph-node-effect-pulse-source';
const ICON_PATHS = {
	check: 'M5 10.5 8.25 13.5 15 6.75',
	cancel: 'M6.25 6.25 13.75 13.75 M13.75 6.25 6.25 13.75',
	alert: 'M10 5.5V11.25 M10 14.25V14.35',
} as const;

/** GraphState와 분리된 in-memory 효과 저장소를 생성한다. */
export function createGraphNodeEffects(
	ownerDocument: Document,
	getAnimationTime: () => number = () => (
		ownerDocument.defaultView?.performance.now() ?? Date.now()
	),
	regionLayer?: HTMLElement,
): GraphNodeEffects {
	const effectsByTarget = new Map<
		string,
		Map<GraphNodeEffectKind, GraphNodeEffect>
	>();
	const registrationsByNodeId = new Map<
		string,
		Set<GraphNodeEffectRegistration>
	>();
	const initialAnimationTime = getAnimationTime();
	const animationEpoch = Number.isFinite(initialAnimationTime)
		? initialAnimationTime
		: 0;
	let currentLayout: GraphLayout | undefined;
	let currentPositions: ReadonlyMap<string, GraphLayoutPosition> = new Map();
	let disposed = false;
	const getAnimationDelay = (): string => {
		const currentTime = getAnimationTime();
		const elapsed = Number.isFinite(currentTime)
			? Math.max(0, currentTime - animationEpoch)
			: 0;
		const roundedElapsed = Math.round(elapsed * 1_000) / 1_000;

		return `-${roundedElapsed}ms`;
	};

	const syncNodeRegistrations = (nodeId: string): void => {
		const animationDelay = getAnimationDelay();

		for (const registration of registrationsByNodeId.get(nodeId) ?? []) {
			syncRegistration(
				registration,
				effectsByTarget,
				ownerDocument,
				animationDelay,
				regionLayer,
			);
			if (currentLayout) {
				syncRegionGeometry(
					registration,
					currentLayout,
					currentPositions,
					0,
				);
			}
		}
	};

	return {
		setNodeEffect(target, effect): void {
			if (disposed || !isSupportedColor(ownerDocument, effect.color)) {
				return;
			}

			const key = createTargetKey(target);
			const effects = effectsByTarget.get(key)
				?? new Map<GraphNodeEffectKind, GraphNodeEffect>();

			effects.set(effect.kind, { ...effect });
			effectsByTarget.set(key, effects);
			syncNodeRegistrations(target.nodeId);
		},
		clearNodeEffect(target, kind): void {
			if (disposed) {
				return;
			}

			const key = createTargetKey(target);
			const effects = effectsByTarget.get(key);

			if (!effects) {
				return;
			}

			if (kind) {
				effects.delete(kind);
				if (effects.size === 0) {
					effectsByTarget.delete(key);
				}
			} else {
				effectsByTarget.delete(key);
			}
			syncNodeRegistrations(target.nodeId);
		},
		registerNode(target, element, options = {}): () => void {
			if (disposed) {
				return () => undefined;
			}

			const registration: GraphNodeEffectRegistration = {
				target: { ...target },
				element,
				effectElements: new Map(),
				...(options.layoutNodeId
					? { layoutNodeId: options.layoutNodeId }
					: {}),
			};
			const registrations = registrationsByNodeId.get(target.nodeId)
				?? new Set<GraphNodeEffectRegistration>();

			registrations.add(registration);
			registrationsByNodeId.set(target.nodeId, registrations);
			syncRegistration(
				registration,
				effectsByTarget,
				ownerDocument,
				getAnimationDelay(),
				regionLayer,
			);
			if (currentLayout) {
				syncRegionGeometry(
					registration,
					currentLayout,
					currentPositions,
					0,
				);
			}
			let registered = true;

			return () => {
				if (!registered) {
					return;
				}

				registered = false;
				removeRegistrationEffects(registration);
				registrations.delete(registration);
				if (registrations.size === 0) {
					registrationsByNodeId.delete(target.nodeId);
				}
			};
		},
		syncLayout(layout, positions, transitionDuration = 0): boolean {
			if (disposed) {
				return false;
			}

			currentLayout = layout;
			currentPositions = positions;
			let changed = false;

			for (const registrations of registrationsByNodeId.values()) {
				for (const registration of registrations) {
					changed = syncRegionGeometry(
						registration,
						layout,
						positions,
						transitionDuration,
					) || changed;
				}
			}

			return changed;
		},
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			for (const registrations of registrationsByNodeId.values()) {
				for (const registration of registrations) {
					removeRegistrationEffects(registration);
				}
			}
			registrationsByNodeId.clear();
			effectsByTarget.clear();
			currentLayout = undefined;
			currentPositions = new Map();
		},
	};
}

/** Global Source 효과 위에 특정 Detached occurrence 효과를 kind별로 덮어쓴다. */
function getRegistrationEffects(
	registration: GraphNodeEffectRegistration,
	effectsByTarget: ReadonlyMap<
		string,
		ReadonlyMap<GraphNodeEffectKind, GraphNodeEffect>
	>,
): Map<GraphNodeEffectKind, GraphNodeEffect> {
	const effects = new Map(
		effectsByTarget.get(createTargetKey({
			nodeId: registration.target.nodeId,
		})) ?? [],
	);

	if (registration.target.rootId) {
		for (const [kind, effect] of effectsByTarget.get(createTargetKey(
			registration.target,
		)) ?? []) {
			effects.set(kind, effect);
		}
	}

	return effects;
}

function syncRegistration(
	registration: GraphNodeEffectRegistration,
	effectsByTarget: ReadonlyMap<
		string,
		ReadonlyMap<GraphNodeEffectKind, GraphNodeEffect>
	>,
	ownerDocument: Document,
	animationDelay: string,
	regionLayer: HTMLElement | undefined,
): void {
	const effects = getRegistrationEffects(registration, effectsByTarget);

	for (const [kind, element] of registration.effectElements) {
		if (!effects.has(kind)) {
			element.remove();
			registration.effectElements.delete(kind);
			if (kind === 'pulse') {
				registration.element.style.removeProperty(
					EFFECT_ANIMATION_DELAY_PROPERTY,
				);
				registration.element.classList.remove(EFFECT_PULSE_SOURCE_CLASS);
			}
		}
	}

	for (const effect of effects.values()) {
		const current = registration.effectElements.get(effect.kind);
		const effectElement = current ?? createEffectElement(effect, ownerDocument);

		updateEffectElement(effectElement, effect);
		if (!current) {
			applyAnimationPhase(
				registration,
				effectElement,
				effect.kind,
				animationDelay,
			);
			const layer = shouldUseEffectRegion(registration, effect.kind, regionLayer)
				? registration.region?.layer
					?? createEffectRegion(registration, ownerDocument, regionLayer).layer
				: registration.layer
					?? createEffectLayer(registration, ownerDocument);

			layer.append(effectElement);
			registration.effectElements.set(effect.kind, effectElement);
		}
		if (effect.kind === 'pulse') {
			registration.element.classList.add(EFFECT_PULSE_SOURCE_CLASS);
		}
	}

	if (registration.effectElements.size === 0) {
		registration.layer?.remove();
		registration.layer = undefined;
		registration.region?.element.remove();
		registration.region = undefined;
		registration.element.classList.remove('graph-node-effect-host');
		registration.element.classList.remove(EFFECT_PULSE_SOURCE_CLASS);
		return;
	}

	const usesRegion = regionLayer && registration.layoutNodeId
		? [...effects.keys()].some((kind) => kind !== 'icon')
		: false;
	const usesLocalLayer = [...effects.keys()].some((kind) => (
		!shouldUseEffectRegion(registration, kind, regionLayer)
	));

	if (!usesRegion) {
		registration.region?.element.remove();
		registration.region = undefined;
	}
	if (!usesLocalLayer) {
		registration.layer?.remove();
		registration.layer = undefined;
	}
}

function shouldUseEffectRegion(
	registration: GraphNodeEffectRegistration,
	kind: GraphNodeEffectKind,
	regionLayer: HTMLElement | undefined,
): regionLayer is HTMLElement {
	return kind !== 'icon'
		&& registration.layoutNodeId !== undefined
		&& regionLayer !== undefined;
}

/** 나중에 생성된 occurrence도 기존 Effect와 같은 Document 시간 위상에 합류시킨다. */
function applyAnimationPhase(
	registration: GraphNodeEffectRegistration,
	effectElement: Element,
	kind: GraphNodeEffectKind,
	animationDelay: string,
): void {
	if (kind !== 'marching-dash' && kind !== 'pulse' && kind !== 'shimmer') {
		return;
	}

	(effectElement as HTMLElement | SVGElement).style.setProperty(
		EFFECT_ANIMATION_DELAY_PROPERTY,
		animationDelay,
	);
	if (kind === 'pulse') {
		registration.element.style.setProperty(
			EFFECT_ANIMATION_DELAY_PROPERTY,
			animationDelay,
		);
	}
}

function createEffectLayer(
	registration: GraphNodeEffectRegistration,
	ownerDocument: Document,
): HTMLElement {
	const layer = ownerDocument.createElement('span');

	layer.className = 'graph-node-effect-layer';
	layer.setAttribute('data-graph-node-effects', '');
	layer.setAttribute('aria-hidden', 'true');
	registration.element.classList.add('graph-node-effect-host');
	registration.element.append(layer);
	registration.layer = layer;
	return layer;
}

function createEffectRegion(
	registration: GraphNodeEffectRegistration,
	ownerDocument: Document,
	regionLayer: HTMLElement,
): GraphNodeEffectRegion {
	const element = ownerDocument.createElement('span');
	const layer = ownerDocument.createElement('span');

	element.className = 'graph-node-effect-region graph-node-effect-host';
	element.setAttribute(
		'data-graph-node-effect-region',
		registration.layoutNodeId ?? '',
	);
	element.setAttribute('aria-hidden', 'true');
	layer.className = 'graph-node-effect-layer';
	layer.setAttribute('data-graph-node-effects', '');
	element.append(layer);
	regionLayer.append(element);
	registration.element.classList.add('graph-node-effect-host');
	registration.region = { element, layer };
	return registration.region;
}

function syncRegionGeometry(
	registration: GraphNodeEffectRegistration,
	layout: GraphLayout,
	positions: ReadonlyMap<string, GraphLayoutPosition>,
	transitionDuration: number,
): boolean {
	const region = registration.region;
	const layoutNodeId = registration.layoutNodeId;

	if (!region || !layoutNodeId) {
		return false;
	}

	const bounds = calculateVisibleSubtreeBounds(layout, positions, layoutNodeId);

	if (!bounds) {
		const changed = region.element.hidden === false;

		region.element.hidden = true;
		region.bounds = undefined;
		return changed;
	}

	const changed = !hasSameRegionBounds(region.bounds, bounds);

	region.element.hidden = false;
	if (!changed) {
		return false;
	}

	if (transitionDuration > 0 && region.bounds) {
		region.element.classList.add(EFFECT_REGION_TRANSITION_CLASS);
		region.element.style.setProperty(
			EFFECT_REGION_TRANSITION_DURATION_PROPERTY,
			`${transitionDuration}ms`,
		);
	} else {
		region.element.classList.remove(EFFECT_REGION_TRANSITION_CLASS);
		region.element.style.removeProperty(EFFECT_REGION_TRANSITION_DURATION_PROPERTY);
	}
	region.element.style.transform = `translate(${bounds.x}px, ${bounds.y}px)`;
	region.element.style.width = `${bounds.width}px`;
	region.element.style.height = `${bounds.height}px`;
	region.bounds = bounds;
	return true;
}

function calculateVisibleSubtreeBounds(
	layout: GraphLayout,
	positions: ReadonlyMap<string, GraphLayoutPosition>,
	rootNodeId: string,
): GraphNodeEffectRegionBounds | undefined {
	const nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
	const childrenByParent = new Map<string, string[]>();

	for (const edge of layout.edges) {
		if (edge.hidden) {
			continue;
		}
		const childIds = childrenByParent.get(edge.sourceId) ?? [];

		childIds.push(edge.targetId);
		childrenByParent.set(edge.sourceId, childIds);
	}

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const visited = new Set<string>();
	const pending = [rootNodeId];

	while (pending.length > 0) {
		const nodeId = pending.pop();

		if (!nodeId || visited.has(nodeId)) {
			continue;
		}
		visited.add(nodeId);
		const node = nodesById.get(nodeId);

		if (!node || node.hidden || isBacklinkOnlyNode(node)) {
			continue;
		}
		const position = positions.get(nodeId) ?? node.position;

		minX = Math.min(minX, position.x);
		minY = Math.min(minY, position.y);
		maxX = Math.max(maxX, position.x + node.width);
		maxY = Math.max(maxY, position.y + node.height);
		pending.push(...(childrenByParent.get(nodeId) ?? []));
	}

	if (!Number.isFinite(minX)) {
		return undefined;
	}

	return {
		x: minX - EFFECT_REGION_PADDING,
		y: minY - EFFECT_REGION_PADDING,
		width: maxX - minX + EFFECT_REGION_PADDING * 2,
		height: maxY - minY + EFFECT_REGION_PADDING * 2,
	};
}

function isBacklinkOnlyNode(node: GraphLayoutNode): boolean {
	return node.kind === 'folder-backlink'
		|| (
			node.kind === 'file-group'
			&& node.children.every((file) => file.presentation === 'backlink')
		);
}

function hasSameRegionBounds(
	left: GraphNodeEffectRegionBounds | undefined,
	right: GraphNodeEffectRegionBounds,
): boolean {
	return left?.x === right.x
		&& left.y === right.y
		&& left.width === right.width
		&& left.height === right.height;
}

function createEffectElement(
	effect: GraphNodeEffect,
	ownerDocument: Document,
): Element {
	if (effect.kind === 'marching-dash') {
		const svg = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
		const rect = ownerDocument.createElementNS(SVG_NAMESPACE, 'rect');

		svg.classList.add('graph-node-effect', 'graph-node-effect-marching-dash');
		rect.classList.add('graph-node-effect-marching-dash-rect');
		svg.append(rect);
		return svg;
	}

	const element = ownerDocument.createElement('span');

	element.className = `graph-node-effect graph-node-effect-${effect.kind}`;
	if (effect.kind === 'icon') {
		const svg = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
		const path = ownerDocument.createElementNS(SVG_NAMESPACE, 'path');

		svg.setAttribute('viewBox', '0 0 20 20');
		svg.classList.add('graph-node-effect-icon-svg');
		path.classList.add('graph-node-effect-icon-path');
		svg.append(path);
		element.append(svg);
	}

	return element;
}

function updateEffectElement(element: Element, effect: GraphNodeEffect): void {
	element.setAttribute('data-graph-node-effect', effect.kind);
	(element as HTMLElement | SVGElement).style.setProperty(
		EFFECT_COLOR_PROPERTY,
		effect.color,
	);

	if (effect.kind !== 'icon') {
		return;
	}

	element.setAttribute('data-graph-node-effect-icon', effect.icon);
	const path = element.children[0]?.children[0];

	path?.setAttribute('d', ICON_PATHS[effect.icon]);
}

function removeRegistrationEffects(
	registration: GraphNodeEffectRegistration,
): void {
	registration.layer?.remove();
	registration.layer = undefined;
	registration.region?.element.remove();
	registration.region = undefined;
	registration.effectElements.clear();
	registration.element.classList.remove('graph-node-effect-host');
	registration.element.classList.remove(EFFECT_PULSE_SOURCE_CLASS);
	registration.element.style.removeProperty(EFFECT_ANIMATION_DELAY_PROPERTY);
}

function createTargetKey(target: GraphNodeEffectTarget): string {
	return JSON.stringify([target.nodeId, target.rootId ?? null]);
}

function isSupportedColor(ownerDocument: Document, color: string): boolean {
	const css = ownerDocument.defaultView?.CSS;

	return typeof css?.supports !== 'function' || css.supports('color', color);
}
