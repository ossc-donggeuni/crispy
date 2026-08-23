import type {
	GraphNodeEffect,
	GraphNodeEffectKind,
	GraphNodeEffectTarget,
} from '../../messages';
import type {
	GraphLayout,
	GraphLayoutPosition,
} from './graphLayout';
import {
	getGraphNodeEffectRegionBounds,
	type GraphNodeEffectRegionBounds,
} from './graphNodeEffectGeometry';

interface GraphNodeEffectRegion {
	readonly element: HTMLElement;
	readonly layer: HTMLElement;
	bounds?: GraphNodeEffectRegionBounds;
}

interface GraphNodeEffectElementHost {
	readonly element: HTMLElement;
	readonly effectElements: Map<string, Element>;
	layer?: HTMLElement;
	region?: GraphNodeEffectRegion;
}

interface GraphNodeEffectRegistration extends GraphNodeEffectElementHost {
	readonly target: GraphNodeEffectTarget;
	readonly layoutNodeId?: string;
}

export interface GraphNodeEffectRegistrationOptions {
	/** Project/Folder occurrence의 visible subtree를 하나의 World Region으로 표시한다. */
	readonly layoutNodeId?: string;
}

export interface GraphNodeEffectRecipeOptions {
	/** occurrence recipe가 이 owner의 Source recipe 전체를 대체한다. */
	readonly sourceInheritance?: 'merge' | 'replace';
}

/** 한 기능이 소유한 Effect만 변경하고 정리하는 격리된 수명주기 경계다. */
export interface GraphNodeEffectOwner {
	setNodeEffect(target: GraphNodeEffectTarget, effect: GraphNodeEffect): void;
	/** 이 owner의 Target recipe를 한 번에 교체한다. */
	replaceNodeEffects(
		target: GraphNodeEffectTarget,
		effects: readonly GraphNodeEffect[],
		options?: GraphNodeEffectRecipeOptions,
	): void;
	clearNodeEffect(target: GraphNodeEffectTarget, kind?: GraphNodeEffectKind): void;
	dispose(): void;
}

/** Graph Target 저장소와 분리된 단일 Element 전용 Effect Host다. */
export interface GraphNodeLocalEffectHost {
	/** 기존 kind DOM은 재사용하면서 이 Element가 표시할 Effect만 동기화한다. */
	setEffects(effects: readonly GraphNodeEffect[]): void;
	/** 이 local host가 만든 Effect DOM과 animation state를 정리한다. */
	dispose(): void;
}

/** 모든 G-11 animation primitive가 같은 절대 경과 시간을 사용하는 phase source다. */
export interface GraphNodeEffectAnimationTimeline {
	getAnimationDelay(): string;
}

/** Transient 효과 상태와 현재 Renderer DOM registration을 연결한다. */
export interface GraphNodeEffects {
	setNodeEffect(target: GraphNodeEffectTarget, effect: GraphNodeEffect): void;
	clearNodeEffect(target: GraphNodeEffectTarget, kind?: GraphNodeEffectKind): void;
	/** 다른 Effect owner와 독립적으로 변경 및 dispose할 수 있는 범위를 만든다. */
	createOwner(): GraphNodeEffectOwner;
	/** Target Effect와 동일한 animation timeline을 쓰는 local host를 만든다. */
	createLocalEffectHost(element: HTMLElement): GraphNodeLocalEffectHost;
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
const EFFECT_REGION_TRANSITION_CLASS = 'is-layout-transitioning';
const EFFECT_PULSE_SOURCE_CLASS = 'graph-node-effect-pulse-source';
const ICON_PATHS = {
	check: 'M5 10.5 8.25 13.5 15 6.75',
	cancel: 'M6.25 6.25 13.75 13.75 M13.75 6.25 6.25 13.75',
	alert: 'M10 5.5V11.25 M10 14.25V14.35',
} as const;

/**
 * Target registration 없이 한 Binding 같은 독립 Element에 G-11 primitive를 렌더링한다.
 */
export function createGraphNodeLocalEffectHost(
	element: HTMLElement,
	animationTimeline: GraphNodeEffectAnimationTimeline = (
		createGraphNodeEffectAnimationTimeline(() => (
			element.ownerDocument.defaultView?.performance.now() ?? Date.now()
		))
	),
): GraphNodeLocalEffectHost {
	const ownerDocument = element.ownerDocument;
	const registration: GraphNodeEffectElementHost = {
		element,
		effectElements: new Map(),
	};
	let disposed = false;

	return {
		setEffects(effects): void {
			if (disposed) {
				return;
			}
			const supportedEffects = new Map<string, GraphNodeEffect>();

			for (const effect of effects) {
				if (isSupportedColor(ownerDocument, effect.color)) {
					supportedEffects.set(effect.kind, { ...effect });
				}
			}
			syncEffectElements(
				registration,
				supportedEffects,
				ownerDocument,
				animationTimeline.getAnimationDelay(),
				() => registration.layer
					?? createEffectLayer(registration, ownerDocument),
			);
		},
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			removeRegistrationEffects(registration);
		},
	};
}

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
		Map<number, Map<GraphNodeEffectKind, GraphNodeEffect>>
	>();
	const sourceReplacementOwnersByTarget = new Map<string, Set<number>>();
	const registrationsByNodeId = new Map<
		string,
		Set<GraphNodeEffectRegistration>
	>();
	const animationTimeline = createGraphNodeEffectAnimationTimeline(
		getAnimationTime,
	);
	let currentLayout: GraphLayout | undefined;
	let currentPositions: ReadonlyMap<string, GraphLayoutPosition> = new Map();
	let nextOwnerId = 1;
	let disposed = false;
	const defaultOwnerId = 0;

	const syncNodeRegistrations = (nodeId: string): void => {
		const animationDelay = animationTimeline.getAnimationDelay();

		for (const registration of registrationsByNodeId.get(nodeId) ?? []) {
			syncRegistration(
				registration,
				effectsByTarget,
				sourceReplacementOwnersByTarget,
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
	const setOwnedNodeEffect = (
		ownerId: number,
		target: GraphNodeEffectTarget,
		effect: GraphNodeEffect,
	): boolean => {
		if (disposed || !isSupportedColor(ownerDocument, effect.color)) {
			return false;
		}

		const key = createTargetKey(target);
		const effectsByOwner = effectsByTarget.get(key)
			?? new Map<number, Map<GraphNodeEffectKind, GraphNodeEffect>>();
		const effects = effectsByOwner.get(ownerId)
			?? new Map<GraphNodeEffectKind, GraphNodeEffect>();

		effects.set(effect.kind, { ...effect });
		effectsByOwner.set(ownerId, effects);
		effectsByTarget.set(key, effectsByOwner);
		syncNodeRegistrations(target.nodeId);
		return true;
	};
	const replaceOwnedNodeEffects = (
		ownerId: number,
		target: GraphNodeEffectTarget,
		effects: readonly GraphNodeEffect[],
		options: GraphNodeEffectRecipeOptions,
	): boolean => {
		if (disposed) {
			return false;
		}

		const supportedEffects = new Map<GraphNodeEffectKind, GraphNodeEffect>();

		for (const effect of effects) {
			if (isSupportedColor(ownerDocument, effect.color)) {
				supportedEffects.set(effect.kind, { ...effect });
			}
		}

		if (supportedEffects.size === 0) {
			return clearOwnedNodeEffect(ownerId, target);
		}

		const key = createTargetKey(target);
		const effectsByOwner = effectsByTarget.get(key)
			?? new Map<number, Map<GraphNodeEffectKind, GraphNodeEffect>>();

		effectsByOwner.set(ownerId, supportedEffects);
		effectsByTarget.set(key, effectsByOwner);
		setSourceReplacement(
			sourceReplacementOwnersByTarget,
			key,
			ownerId,
			target.rootId !== undefined
				&& options.sourceInheritance === 'replace',
		);
		syncNodeRegistrations(target.nodeId);
		return true;
	};
	const clearOwnedNodeEffect = (
		ownerId: number,
		target: GraphNodeEffectTarget,
		kind?: GraphNodeEffectKind,
	): boolean => {
		if (disposed) {
			return false;
		}

		const key = createTargetKey(target);
		const effectsByOwner = effectsByTarget.get(key);
		const effects = effectsByOwner?.get(ownerId);

		if (!effects) {
			return false;
		}

		if (kind && !effects.delete(kind)) {
			return false;
		}
		if (!kind || effects.size === 0) {
			effectsByOwner?.delete(ownerId);
			setSourceReplacement(
				sourceReplacementOwnersByTarget,
				key,
				ownerId,
				false,
			);
		}
		if (effectsByOwner?.size === 0) {
			effectsByTarget.delete(key);
		}
		syncNodeRegistrations(target.nodeId);
		return true;
	};
	const hasOwnedTargetEffects = (
		ownerId: number,
		target: GraphNodeEffectTarget,
	): boolean => effectsByTarget
		.get(createTargetKey(target))
		?.has(ownerId) === true;
	const createOwner = (): GraphNodeEffectOwner => {
		const ownerId = nextOwnerId;
		nextOwnerId += 1;
		const ownedTargets = new Map<string, GraphNodeEffectTarget>();
		let ownerDisposed = false;

		return {
			setNodeEffect(target, effect): void {
				if (
					!ownerDisposed
					&& setOwnedNodeEffect(ownerId, target, effect)
				) {
					ownedTargets.set(createTargetKey(target), { ...target });
				}
			},
			replaceNodeEffects(target, effects, options = {}): void {
				if (ownerDisposed) {
					return;
				}

				replaceOwnedNodeEffects(ownerId, target, effects, options);
				if (hasOwnedTargetEffects(ownerId, target)) {
					ownedTargets.set(createTargetKey(target), { ...target });
				} else {
					ownedTargets.delete(createTargetKey(target));
				}
			},
			clearNodeEffect(target, kind): void {
				if (
					ownerDisposed
					|| !clearOwnedNodeEffect(ownerId, target, kind)
				) {
					return;
				}
				if (!hasOwnedTargetEffects(ownerId, target)) {
					ownedTargets.delete(createTargetKey(target));
				}
			},
			dispose(): void {
				if (ownerDisposed) {
					return;
				}

				ownerDisposed = true;
				for (const target of ownedTargets.values()) {
					clearOwnedNodeEffect(ownerId, target);
				}
				ownedTargets.clear();
			},
		};
	};

	return {
		setNodeEffect(target, effect): void {
			setOwnedNodeEffect(defaultOwnerId, target, effect);
		},
		clearNodeEffect(target, kind): void {
			clearOwnedNodeEffect(defaultOwnerId, target, kind);
		},
		createOwner,
		createLocalEffectHost(element): GraphNodeLocalEffectHost {
			return createGraphNodeLocalEffectHost(element, animationTimeline);
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
				sourceReplacementOwnersByTarget,
				ownerDocument,
				animationTimeline.getAnimationDelay(),
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
			sourceReplacementOwnersByTarget.clear();
			currentLayout = undefined;
			currentPositions = new Map();
		},
	};
}

/** 기본은 kind별 merge하고 opt-in occurrence recipe만 같은 owner Source를 대체한다. */
function getRegistrationEffects(
	registration: GraphNodeEffectRegistration,
	effectsByTarget: ReadonlyMap<
		string,
		ReadonlyMap<number, ReadonlyMap<GraphNodeEffectKind, GraphNodeEffect>>
	>,
	sourceReplacementOwnersByTarget: ReadonlyMap<string, ReadonlySet<number>>,
): Map<string, GraphNodeEffect> {
	const effects = flattenOwnedEffects(
		effectsByTarget.get(createTargetKey({
			nodeId: registration.target.nodeId,
		})),
	);

	if (registration.target.rootId) {
		const occurrenceKey = createTargetKey(registration.target);

		for (const ownerId of sourceReplacementOwnersByTarget.get(
			occurrenceKey,
		) ?? []) {
			removeOwnerEffects(effects, ownerId);
		}
		for (const [key, effect] of flattenOwnedEffects(
			effectsByTarget.get(occurrenceKey),
		)) {
			effects.set(key, effect);
		}
	}

	return effects;
}

function removeOwnerEffects(
	effects: Map<string, GraphNodeEffect>,
	ownerId: number,
): void {
	const ownerPrefix = `${ownerId}:`;

	for (const key of effects.keys()) {
		if (key.startsWith(ownerPrefix)) {
			effects.delete(key);
		}
	}
}

function setSourceReplacement(
	replacementsByTarget: Map<string, Set<number>>,
	targetKey: string,
	ownerId: number,
	replaceSource: boolean,
): void {
	if (replaceSource) {
		const owners = replacementsByTarget.get(targetKey) ?? new Set<number>();

		owners.add(ownerId);
		replacementsByTarget.set(targetKey, owners);
		return;
	}

	const owners = replacementsByTarget.get(targetKey);

	owners?.delete(ownerId);
	if (owners?.size === 0) {
		replacementsByTarget.delete(targetKey);
	}
}

/** Owner와 kind 조합마다 독립적인 Effect instance key로 펼친다. */
function flattenOwnedEffects(
	effectsByOwner: ReadonlyMap<
		number,
		ReadonlyMap<GraphNodeEffectKind, GraphNodeEffect>
	> | undefined,
): Map<string, GraphNodeEffect> {
	const effects = new Map<string, GraphNodeEffect>();

	for (const [ownerId, ownerEffects] of effectsByOwner ?? []) {
		for (const [kind, effect] of ownerEffects) {
			effects.set(createEffectInstanceKey(ownerId, kind), effect);
		}
	}

	return effects;
}

function syncRegistration(
	registration: GraphNodeEffectRegistration,
	effectsByTarget: ReadonlyMap<
		string,
		ReadonlyMap<number, ReadonlyMap<GraphNodeEffectKind, GraphNodeEffect>>
	>,
	sourceReplacementOwnersByTarget: ReadonlyMap<string, ReadonlySet<number>>,
	ownerDocument: Document,
	animationDelay: string,
	regionLayer: HTMLElement | undefined,
): void {
	const effects = getRegistrationEffects(
		registration,
		effectsByTarget,
		sourceReplacementOwnersByTarget,
	);

	syncEffectElements(
		registration,
		effects,
		ownerDocument,
		animationDelay,
		(kind) => shouldUseEffectRegion(registration, kind, regionLayer)
			? registration.region?.layer
				?? createEffectRegion(registration, ownerDocument, regionLayer).layer
			: registration.layer
				?? createEffectLayer(registration, ownerDocument),
	);

	if (registration.effectElements.size === 0) {
		return;
	}

	const usesRegion = regionLayer && registration.layoutNodeId
		? [...effects.values()].some(({ kind }) => kind !== 'icon')
		: false;
	const usesLocalLayer = [...effects.values()].some(({ kind }) => (
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

/** Effect kind별 Element를 유지하며 지정된 host/layer에만 DOM primitive를 동기화한다. */
function syncEffectElements(
	registration: GraphNodeEffectElementHost,
	effects: ReadonlyMap<string, GraphNodeEffect>,
	ownerDocument: Document,
	animationDelay: string,
	resolveLayer: (kind: GraphNodeEffectKind) => HTMLElement,
): void {

	for (const [key, current] of registration.effectElements) {
		if (!effects.has(key)) {
			current.remove();
			registration.effectElements.delete(key);
		}
	}

	for (const [key, effect] of effects) {
		const current = registration.effectElements.get(key);
		const effectElement = current ?? createEffectElement(effect, ownerDocument);

		updateEffectElement(effectElement, effect);
		if (!current) {
			applyAnimationPhase(
				registration,
				effectElement,
				effect.kind,
				animationDelay,
			);
			const layer = resolveLayer(effect.kind);

			layer.append(effectElement);
			registration.effectElements.set(key, effectElement);
		}
	}

	const hasPulse = [...effects.values()].some(({ kind }) => kind === 'pulse');
	if (hasPulse) {
		registration.element.classList.add(EFFECT_PULSE_SOURCE_CLASS);
	} else {
		registration.element.classList.remove(EFFECT_PULSE_SOURCE_CLASS);
		registration.element.style.removeProperty(EFFECT_ANIMATION_DELAY_PROPERTY);
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
	registration: GraphNodeEffectElementHost,
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
	registration: GraphNodeEffectElementHost,
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

	const bounds = getGraphNodeEffectRegionBounds(layout, positions, layoutNodeId);

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
	registration: GraphNodeEffectElementHost,
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

function createEffectInstanceKey(
	ownerId: number,
	kind: GraphNodeEffectKind,
): string {
	return `${ownerId}:${kind}`;
}

function isSupportedColor(ownerDocument: Document, color: string): boolean {
	const css = ownerDocument.defaultView?.CSS;

	return typeof css?.supports !== 'function' || css.supports('color', color);
}

function createGraphNodeEffectAnimationTimeline(
	getAnimationTime: () => number,
): GraphNodeEffectAnimationTimeline {
	const initialAnimationTime = getAnimationTime();
	const animationEpoch = Number.isFinite(initialAnimationTime)
		? initialAnimationTime
		: 0;

	return {
		getAnimationDelay: () => getAnimationDelay(
			getAnimationTime,
			animationEpoch,
		),
	};
}

function getAnimationDelay(
	getAnimationTime: () => number,
	animationEpoch: number,
): string {
	const currentTime = getAnimationTime();
	const elapsed = Number.isFinite(currentTime)
		? Math.max(0, currentTime - animationEpoch)
		: 0;
	const roundedElapsed = Math.round(elapsed * 1_000) / 1_000;

	return `-${roundedElapsed}ms`;
}
