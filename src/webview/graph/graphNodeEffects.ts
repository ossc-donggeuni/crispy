import type {
	GraphNodeEffect,
	GraphNodeEffectKind,
	GraphNodeEffectTarget,
} from '../../messages';

interface GraphNodeEffectRegistration {
	readonly target: GraphNodeEffectTarget;
	readonly element: HTMLElement;
	readonly effectElements: Map<GraphNodeEffectKind, Element>;
	layer?: HTMLElement;
}

/** Transient 효과 상태와 현재 Renderer DOM registration을 연결한다. */
export interface GraphNodeEffects {
	setNodeEffect(target: GraphNodeEffectTarget, effect: GraphNodeEffect): void;
	clearNodeEffect(target: GraphNodeEffectTarget, kind?: GraphNodeEffectKind): void;
	registerNode(target: GraphNodeEffectTarget, element: HTMLElement): () => void;
	dispose(): void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const EFFECT_COLOR_PROPERTY = '--graph-node-effect-color';
const ICON_PATHS = {
	check: 'M5 10.5 8.25 13.5 15 6.75',
	cancel: 'M6.25 6.25 13.75 13.75 M13.75 6.25 6.25 13.75',
	alert: 'M10 5.5V11.25 M10 14.25V14.35',
} as const;

/** GraphState와 분리된 in-memory 효과 저장소를 생성한다. */
export function createGraphNodeEffects(ownerDocument: Document): GraphNodeEffects {
	const effectsByTarget = new Map<
		string,
		Map<GraphNodeEffectKind, GraphNodeEffect>
	>();
	const registrationsByNodeId = new Map<
		string,
		Set<GraphNodeEffectRegistration>
	>();
	let disposed = false;

	const syncNodeRegistrations = (nodeId: string): void => {
		for (const registration of registrationsByNodeId.get(nodeId) ?? []) {
			syncRegistration(registration, effectsByTarget, ownerDocument);
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
		registerNode(target, element): () => void {
			if (disposed) {
				return () => undefined;
			}

			const registration: GraphNodeEffectRegistration = {
				target: { ...target },
				element,
				effectElements: new Map(),
			};
			const registrations = registrationsByNodeId.get(target.nodeId)
				?? new Set<GraphNodeEffectRegistration>();

			registrations.add(registration);
			registrationsByNodeId.set(target.nodeId, registrations);
			syncRegistration(registration, effectsByTarget, ownerDocument);
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
): void {
	const effects = getRegistrationEffects(registration, effectsByTarget);

	for (const [kind, element] of registration.effectElements) {
		if (!effects.has(kind)) {
			element.remove();
			registration.effectElements.delete(kind);
		}
	}

	for (const effect of effects.values()) {
		const current = registration.effectElements.get(effect.kind);
		const effectElement = current ?? createEffectElement(effect, ownerDocument);

		updateEffectElement(effectElement, effect);
		if (!current) {
			const layer = registration.layer
				?? createEffectLayer(registration, ownerDocument);

			layer.append(effectElement);
			registration.effectElements.set(effect.kind, effectElement);
		}
	}

	if (registration.effectElements.size === 0) {
		registration.layer?.remove();
		registration.layer = undefined;
		registration.element.classList.remove('graph-node-effect-host');
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
	registration.effectElements.clear();
	registration.element.classList.remove('graph-node-effect-host');
}

function createTargetKey(target: GraphNodeEffectTarget): string {
	return JSON.stringify([target.nodeId, target.rootId ?? null]);
}

function isSupportedColor(ownerDocument: Document, color: string): boolean {
	const css = ownerDocument.defaultView?.CSS;

	return typeof css?.supports !== 'function' || css.supports('color', color);
}
