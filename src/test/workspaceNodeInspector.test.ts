import * as assert from 'assert';
import { initializeWorkspaceNodeInspectorDismissal } from '../webview/workspaceNodeInspector';

suite('Workspace Node Inspector', () => {
	test('Escape를 capture 단계에서 소비하고 열린 Inspector를 닫는다', () => {
		const ownerDocument = new FakeDismissDocument();
		let inspector: HTMLElement | undefined = {} as HTMLElement;
		let closeCount = 0;
		const dispose = initializeWorkspaceNodeInspectorDismissal(
			ownerDocument.asDocument(),
			() => inspector,
			() => {
				closeCount += 1;
				inspector = undefined;
			},
		);

		assert.strictEqual(ownerDocument.getCapture('keydown'), true);
		ownerDocument.dispatch('keydown', createKeyboardEvent('Enter').event);
		assert.strictEqual(closeCount, 0);

		const escape = createKeyboardEvent('Escape');

		ownerDocument.dispatch('keydown', escape.event);
		assert.strictEqual(closeCount, 1);
		assert.strictEqual(escape.wasPrevented(), true);
		assert.strictEqual(escape.wasPropagationStopped(), true);

		ownerDocument.dispatch('keydown', createKeyboardEvent('Escape').event);
		assert.strictEqual(closeCount, 1);
		dispose();
	});

	test('Inspector 내부 클릭은 유지하고 바깥 기본 클릭만 닫는다', () => {
		const ownerDocument = new FakeDismissDocument();
		const inspector = {} as HTMLElement;
		const insideControl = {} as EventTarget;
		const outside = {} as EventTarget;
		let closeCount = 0;
		const dispose = initializeWorkspaceNodeInspectorDismissal(
			ownerDocument.asDocument(),
			() => inspector,
			() => closeCount += 1,
		);

		assert.strictEqual(ownerDocument.getCapture('pointerdown'), true);
		ownerDocument.dispatch(
			'pointerdown',
			createPointerEvent(0, [insideControl, inspector]),
		);
		assert.strictEqual(closeCount, 0);

		ownerDocument.dispatch('pointerdown', createPointerEvent(2, [outside]));
		assert.strictEqual(closeCount, 0);

		ownerDocument.dispatch('pointerdown', createPointerEvent(0, [outside]));
		assert.strictEqual(closeCount, 1);
		dispose();
	});

	test('dispose는 document capture listener를 모두 제거한다', () => {
		const ownerDocument = new FakeDismissDocument();
		const inspector = {} as HTMLElement;
		let closeCount = 0;
		const dispose = initializeWorkspaceNodeInspectorDismissal(
			ownerDocument.asDocument(),
			() => inspector,
			() => closeCount += 1,
		);

		dispose();
		assert.strictEqual(ownerDocument.getListenerCount('keydown'), 0);
		assert.strictEqual(ownerDocument.getListenerCount('pointerdown'), 0);

		ownerDocument.dispatch('keydown', createKeyboardEvent('Escape').event);
		ownerDocument.dispatch('pointerdown', createPointerEvent(0, [{} as EventTarget]));
		assert.strictEqual(closeCount, 0);
	});
});

interface FakeDismissListener {
	readonly listener: EventListenerOrEventListenerObject;
	readonly capture: boolean;
}

class FakeDismissDocument {
	private readonly listeners = new Map<string, FakeDismissListener[]>();

	asDocument(): Document {
		return this as unknown as Document;
	}

	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): void {
		const listeners = this.listeners.get(type) ?? [];

		listeners.push({ listener, capture: resolveCapture(options) });
		this.listeners.set(type, listeners);
	}

	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | EventListenerOptions,
	): void {
		const capture = resolveCapture(options);
		const listeners = this.listeners.get(type) ?? [];

		this.listeners.set(type, listeners.filter((registered) => (
			registered.listener !== listener || registered.capture !== capture
		)));
	}

	dispatch(type: string, event: Event): void {
		for (const { listener } of [...(this.listeners.get(type) ?? [])]) {
			if (typeof listener === 'function') {
				listener(event);
			} else {
				listener.handleEvent(event);
			}
		}
	}

	getCapture(type: string): boolean | undefined {
		return this.listeners.get(type)?.[0]?.capture;
	}

	getListenerCount(type: string): number {
		return this.listeners.get(type)?.length ?? 0;
	}
}

function resolveCapture(
	options: boolean | AddEventListenerOptions | EventListenerOptions | undefined,
): boolean {
	return typeof options === 'boolean' ? options : options?.capture ?? false;
}

function createKeyboardEvent(key: string): {
	readonly event: KeyboardEvent;
	wasPrevented(): boolean;
	wasPropagationStopped(): boolean;
} {
	let prevented = false;
	let propagationStopped = false;
	const event = {
		key,
		preventDefault: () => prevented = true,
		stopPropagation: () => propagationStopped = true,
	} as unknown as KeyboardEvent;

	return {
		event,
		wasPrevented: () => prevented,
		wasPropagationStopped: () => propagationStopped,
	};
}

function createPointerEvent(button: number, path: EventTarget[]): PointerEvent {
	return {
		button,
		composedPath: () => path,
	} as unknown as PointerEvent;
}
