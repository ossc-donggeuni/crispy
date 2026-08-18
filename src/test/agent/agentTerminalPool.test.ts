import * as assert from 'assert';
import {
	createAgentTerminalPool,
	type AgentTerminalPoolDependencies,
} from '../../agent/webview/agentTerminalPool';
import type { ShellTerminalController } from '../../agent/webview/shellTerminal';
import type { HostToWebviewMessage, TabId } from '../../agent/protocol/messages';
import { FakeAgentElement } from './support/fakeAgentUiDom';

/** 탭 하나의 Terminal 제어 객체를 대신하며 전달받은 메시지를 기록한다. */
class FakeShellTerminal implements ShellTerminalController {
	readonly received: HostToWebviewMessage[] = [];
	fitCallCount = 0;
	disposeCallCount = 0;

	constructor(readonly tabId: TabId) {}

	handleHostMessage(message: HostToWebviewMessage): void {
		this.received.push(message);
	}

	scheduleTerminalFit(): void {
		this.fitCallCount += 1;
	}

	dispose(): void {
		this.disposeCallCount += 1;
	}
}

/**
 * 대역 DOM과 대역 Terminal만 사용하는 pool 의존성을 만든다.
 *
 * @returns 의존성과 생성된 대역 Terminal 기록
 */
function createFakeDependencies(): {
	readonly dependencies: AgentTerminalPoolDependencies;
	readonly terminals: Map<TabId, FakeShellTerminal>;
} {
	const terminals = new Map<TabId, FakeShellTerminal>();

	return {
		terminals,
		dependencies: {
			createElement: ((tagName: string) =>
				new FakeAgentElement(tagName).asHtmlElement()
			) as AgentTerminalPoolDependencies['createElement'],
			createShellTerminal: (tabId) => {
				const terminal = new FakeShellTerminal(tabId);
				terminals.set(tabId, terminal);
				return terminal;
			},
		},
	};
}

/**
 * 컨테이너 대역과 pool을 함께 만든다.
 *
 * @returns 컨테이너, pool과 대역 Terminal 기록
 */
function createPool() {
	const container = new FakeAgentElement('div');
	const { dependencies, terminals } = createFakeDependencies();
	const pool = createAgentTerminalPool(container.asHtmlElement(), dependencies);
	return { container, pool, terminals };
}

/** 대역 컨테이너의 탭 표면 목록을 반환한다. */
function surfaces(container: FakeAgentElement): FakeAgentElement[] {
	return container.children;
}

suite('Agent 탭별 Terminal 표면 pool', () => {
	test('탭마다 표면, mount와 덮개를 갖춘 Terminal을 하나만 만든다', () => {
		const { container, pool, terminals } = createPool();

		pool.ensureTab('tab-one');
		pool.ensureTab('tab-one');

		assert.strictEqual(surfaces(container).length, 1);
		assert.strictEqual(terminals.size, 1);
		const surface = surfaces(container)[0];
		assert.strictEqual(surface.className, 'terminal-surface');
		assert.strictEqual(surface.dataset.state, 'ready');
		assert.strictEqual(surface.children.length, 2);
		assert.strictEqual(surface.children[0].className, 'terminal-mount');
		assert.strictEqual(surface.children[1].className, 'terminal-overlay');
		assert.strictEqual(surface.children[1].hidden, true);
	});

	test('활성 탭 표면만 표시하고 나머지 탭 세션은 그대로 둔다', () => {
		const { container, pool, terminals } = createPool();

		pool.ensureTab('tab-one');
		pool.setActiveTab('tab-one');
		pool.ensureTab('tab-two');
		pool.setActiveTab('tab-two');

		assert.strictEqual(surfaces(container).length, 2);
		assert.strictEqual(surfaces(container)[0].hidden, true);
		assert.strictEqual(surfaces(container)[1].hidden, false);
		assert.strictEqual(terminals.get('tab-one')?.disposeCallCount, 0);

		/* 표시 직후와 layout 변경에서 활성 탭만 다시 맞춘다. */
		const fitBefore = terminals.get('tab-two')?.fitCallCount ?? 0;
		pool.scheduleActiveTerminalFit();
		assert.strictEqual(terminals.get('tab-two')?.fitCallCount, fitBefore + 1);
		assert.strictEqual(terminals.get('tab-one')?.fitCallCount, 1);
	});

	test('Host 메시지를 같은 tabId의 Terminal에만 전달한다', () => {
		const { pool, terminals } = createPool();

		pool.ensureTab('tab-one');
		pool.ensureTab('tab-two');

		pool.handleHostMessage({
			type: 'terminal.output',
			tabId: 'tab-two',
			sessionId: 'session-two',
			data: 'x',
		});
		pool.handleHostMessage({
			type: 'terminal.starting',
			tabId: 'tab-unknown',
		});

		assert.strictEqual(terminals.get('tab-one')?.received.length, 0);
		assert.strictEqual(terminals.get('tab-two')?.received.length, 1);
		assert.strictEqual(
			terminals.get('tab-two')?.received[0].type,
			'terminal.output',
		);
	});

	test('탭을 닫으면 해당 Terminal과 표면만 정리한다', () => {
		const { container, pool, terminals } = createPool();

		pool.ensureTab('tab-one');
		pool.ensureTab('tab-two');
		pool.setActiveTab('tab-one');
		pool.closeTab('tab-two');

		assert.strictEqual(terminals.get('tab-two')?.disposeCallCount, 1);
		assert.strictEqual(terminals.get('tab-one')?.disposeCallCount, 0);
		assert.strictEqual(surfaces(container).length, 1);
		/* 남은 활성 탭 표면은 그대로 표시된다. */
		assert.strictEqual(surfaces(container)[0].hidden, false);

		/* 닫힌 탭으로 향하는 메시지는 더 이상 전달되지 않는다. */
		pool.handleHostMessage({
			type: 'terminal.starting',
			tabId: 'tab-two',
		});
		assert.strictEqual(terminals.get('tab-two')?.received.length, 0);
	});

	test('탭 reset은 기존 xterm을 정리하고 같은 tabId의 빈 표면으로 교체한다', () => {
		const { container, pool, terminals } = createPool();

		pool.ensureTab('tab-reset');
		pool.setActiveTab('tab-reset');
		const previous = terminals.get('tab-reset');
		const previousSurface = surfaces(container)[0];

		pool.resetTab('tab-reset');

		const replacement = terminals.get('tab-reset');
		assert.strictEqual(previous?.disposeCallCount, 1);
		assert.notStrictEqual(replacement, previous);
		assert.strictEqual(surfaces(container).length, 1);
		assert.notStrictEqual(surfaces(container)[0], previousSurface);
		assert.strictEqual(surfaces(container)[0].hidden, false);
		assert.strictEqual(replacement?.fitCallCount, 1);
	});

	test('pool dispose는 모든 탭 Terminal과 표면을 정리한다', () => {
		const { container, pool, terminals } = createPool();

		pool.ensureTab('tab-one');
		pool.ensureTab('tab-two');
		pool.dispose();

		assert.strictEqual(surfaces(container).length, 0);
		for (const terminal of terminals.values()) {
			assert.strictEqual(terminal.disposeCallCount, 1);
		}

		/* dispose 뒤의 요청은 새 표면을 만들지 않는다. */
		pool.ensureTab('tab-three');
		assert.strictEqual(surfaces(container).length, 0);
	});

	test('한 탭 Terminal의 실패가 다른 탭 정리를 막지 않는다', () => {
		const container = new FakeAgentElement('div');
		const { dependencies, terminals } = createFakeDependencies();
		const failing: AgentTerminalPoolDependencies = {
			...dependencies,
			createShellTerminal: (tabId, surface, mount, overlay) => {
				const terminal = dependencies.createShellTerminal(
					tabId,
					surface,
					mount,
					overlay,
				);
				if (tabId === 'tab-failing') {
					return {
						...terminal,
						dispose: () => {
							throw new Error('dispose failed');
						},
					};
				}

				return terminal;
			},
		};
		const pool = createAgentTerminalPool(container.asHtmlElement(), failing);

		pool.ensureTab('tab-failing');
		pool.ensureTab('tab-healthy');
		pool.dispose();

		assert.strictEqual(surfaces(container).length, 0);
		assert.strictEqual(terminals.get('tab-healthy')?.disposeCallCount, 1);
	});
});
