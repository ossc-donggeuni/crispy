import * as assert from 'assert';
import type { FitAddon } from '@xterm/addon-fit';
import {
	initializeShellTerminal,
	TERMINAL_INITIALIZATION_ERROR_MESSAGE,
	type ShellTerminalDependencies,
} from '../../agent/webview/shellTerminal';

const TAB_ID = 'tab-webview-terminal';
const SESSION_ID = 'session-current';

suite('Shell Terminal Webview', () => {
	test('Terminal, FitAddon, load, open, fit 순서로 xterm을 mount한다', () => {
		const events: string[] = [];
		const terminal = new FakeTerminal(events);
		const fitAddon = createFitAddon(events);
		const elements = createElements();

		const controller = initializeShellTerminal(
			elements.surface,
			elements.mount,
			elements.overlay,
			() => undefined,
			createDependencies(terminal, fitAddon, events),
		);

		assert.strictEqual(controller.tabId, TAB_ID);
		assert.deepStrictEqual(events, [
			'createTerminal',
			'createFitAddon',
			'loadAddon',
			'open',
			'fit',
			'onData',
		]);
		assert.strictEqual(terminal.openedContainer, elements.mount);
		assert.strictEqual(elements.overlay.hidden, true);
	});

	test('현재 tabId와 sessionId가 모두 일치하는 output만 원문 그대로 write한다', () => {
		const terminal = new FakeTerminal();
		const controller = initializeShellTerminal(
			...createElementArguments(),
			() => undefined,
			createDependencies(terminal),
		);
		const unchangedOutput = '\u001b[31mred\u001b[0m\r\n한글  \n';

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		controller.handleHostMessage({
			type: 'terminal.output',
			tabId: 'tab-other',
			sessionId: SESSION_ID,
			data: 'wrong tab',
		});
		controller.handleHostMessage({
			type: 'terminal.output',
			tabId: TAB_ID,
			sessionId: 'session-stale',
			data: 'stale session',
		});
		controller.handleHostMessage({
			type: 'terminal.output',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			data: unchangedOutput,
		});

		assert.deepStrictEqual(terminal.writes, [unchangedOutput]);
	});

	test('xterm onData 문자열을 분기나 변형 없이 현재 session input으로 보낸다', () => {
		const terminal = new FakeTerminal();
		const messages: unknown[] = [];
		const controller = initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(terminal),
		);
		const unchangedInput = '한글 paste\r\u007f\t\u001b[A\u0003\u0004';

		terminal.emitData('not attached');
		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		terminal.emitData(unchangedInput);

		assert.deepStrictEqual(messages, [{
			type: 'terminal.input',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			data: unchangedInput,
		}]);
	});

	test('종료된 현재 session에는 input과 늦은 output을 연결하지 않는다', () => {
		const terminal = new FakeTerminal();
		const messages: unknown[] = [];
		const controller = initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(terminal),
		);

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		controller.handleHostMessage({
			type: 'terminal.exited',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			exitCode: 0,
		});
		terminal.emitData('late input');
		controller.handleHostMessage({
			type: 'terminal.output',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			data: 'late output',
		});

		assert.deepStrictEqual(messages, []);
		assert.deepStrictEqual(terminal.writes, []);
	});

	test('초기화 예외 원문을 노출하지 않고 Terminal 영역만 error 상태로 바꾼다', () => {
		const terminal = new FakeTerminal();
		const elements = createElements();
		const dependencies = createDependencies(terminal);
		dependencies.createFitAddon = () => {
			throw new Error('secret initialization details');
		};

		const controller = initializeShellTerminal(
			elements.surface,
			elements.mount,
			elements.overlay,
			() => undefined,
			dependencies,
		);

		assert.strictEqual(elements.surfaceElement.dataset.state, 'error');
		assert.strictEqual(
			elements.overlayElement.textContent,
			TERMINAL_INITIALIZATION_ERROR_MESSAGE,
		);
		assert.ok(!elements.overlayElement.textContent.includes('secret'));
		assert.strictEqual(elements.overlayElement.hidden, false);
		assert.strictEqual(elements.overlayElement.role, 'alert');
		assert.strictEqual(elements.mountElement.replaceChildrenCalls, 1);
		assert.strictEqual(terminal.disposeCalls, 1);
		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		assert.doesNotThrow(() => {
			controller.handleHostMessage({
				type: 'terminal.output',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				data: 'ignored',
			});
		});
	});
});

class FakeTerminal {
	readonly writes: string[] = [];
	openedContainer: HTMLElement | undefined;
	disposeCalls = 0;
	private dataListener: ((data: string) => void) | undefined;

	constructor(private readonly events: string[] = []) {}

	loadAddon(_addon: FitAddon): void {
		this.events.push('loadAddon');
	}

	open(container: HTMLElement): void {
		this.events.push('open');
		this.openedContainer = container;
	}

	write(data: string): void {
		this.writes.push(data);
	}

	onData(listener: (data: string) => void): unknown {
		this.events.push('onData');
		this.dataListener = listener;
		return undefined;
	}

	dispose(): void {
		this.disposeCalls += 1;
	}

	emitData(data: string): void {
		this.dataListener?.(data);
	}
}

class FakeElement {
	readonly dataset: DOMStringMap = {};
	hidden = true;
	textContent = '';
	role: string | undefined;
	replaceChildrenCalls = 0;

	setAttribute(name: string, value: string): void {
		if (name === 'role') {
			this.role = value;
		}
	}

	replaceChildren(): void {
		this.replaceChildrenCalls += 1;
	}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}
}

interface FakeElements {
	readonly surfaceElement: FakeElement;
	readonly mountElement: FakeElement;
	readonly overlayElement: FakeElement;
	readonly surface: HTMLElement;
	readonly mount: HTMLElement;
	readonly overlay: HTMLElement;
}

function createElements(): FakeElements {
	const surfaceElement = new FakeElement();
	const mountElement = new FakeElement();
	const overlayElement = new FakeElement();

	return {
		surfaceElement,
		mountElement,
		overlayElement,
		surface: surfaceElement.asHtmlElement(),
		mount: mountElement.asHtmlElement(),
		overlay: overlayElement.asHtmlElement(),
	};
}

function createElementArguments(): [HTMLElement, HTMLElement, HTMLElement] {
	const elements = createElements();
	return [elements.surface, elements.mount, elements.overlay];
}

function createDependencies(
	terminal: FakeTerminal,
	fitAddon = createFitAddon(),
	events: string[] = [],
): ShellTerminalDependencies {
	return {
		createTerminal: () => {
			events.push('createTerminal');
			return terminal;
		},
		createFitAddon: () => {
			events.push('createFitAddon');
			return fitAddon;
		},
		createTabId: () => TAB_ID,
	};
}

function createFitAddon(events: string[] = []): FitAddon {
	return {
		activate: () => undefined,
		dispose: () => undefined,
		fit: () => events.push('fit'),
		proposeDimensions: () => undefined,
	} as FitAddon;
}
