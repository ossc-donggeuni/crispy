import * as assert from 'assert';
import {
	createAgentActivityCanvasTerminalRuntime,
} from '../../extension';
import {
	createTerminalRuntimeCleanup,
	type DetachableTerminalRuntime,
	type TerminalRuntimeSubscription,
} from '../../agent/host/terminal/terminalRuntimeCleanup';

interface RecordingBridge {
	readonly bridge: { disposePanel(): void };
	readonly disposeInvocations: number;
	readonly disposeEffects: number;
	readonly clearPosts: number;
	revokeLease(): void;
}

/** Panel dispose와 cleanup clear의 의미 순서를 기록하는 최소 bridge 대역이다. */
function createRecordingBridge(timeline: string[]): RecordingBridge {
	let disposed = false;
	let disposeInvocations = 0;
	let disposeEffects = 0;
	let clearPosts = 0;

	return {
		bridge: {
			disposePanel(): void {
				disposeInvocations += 1;
				if (disposed) {
					return;
				}
				disposed = true;
				disposeEffects += 1;
				timeline.push('bridge.disposePanel');
			},
		},
		get disposeInvocations(): number {
			return disposeInvocations;
		},
		get disposeEffects(): number {
			return disposeEffects;
		},
		get clearPosts(): number {
			return clearPosts;
		},
		revokeLease(): void {
			timeline.push('lease.revoke');
			if (!disposed) {
				clearPosts += 1;
				timeline.push('clear.post');
			}
		},
	};
}

/** TerminalHost detach의 Activity prefix와 delivery/resource teardown을 재현한다. */
function createRecordingTerminalRuntime(
	timeline: string[],
	bridge: RecordingBridge,
	options: { readonly throwOnDetach?: boolean } = {},
): {
	readonly runtime: DetachableTerminalRuntime;
	readonly detachCalls: number;
	readonly terminateCalls: number;
} {
	let detachCalls = 0;
	let terminateCalls = 0;

	return {
		runtime: {
			detach(): void {
				detachCalls += 1;
				timeline.push('host.detach');
				if (options.throwOnDetach) {
					throw new Error('fake host detach failure');
				}
				bridge.revokeLease();
				timeline.push('delivery.stop');
				timeline.push('supervisor.teardown');
			},
			terminate(): void {
				terminateCalls += 1;
				timeline.push('host.terminate');
			},
		},
		get detachCalls(): number {
			return detachCalls;
		},
		get terminateCalls(): number {
			return terminateCalls;
		},
	};
}

function createInboundSubscription(
	timeline: string[],
): TerminalRuntimeSubscription {
	return {
		dispose(): void {
			timeline.push('inbound.dispose');
		},
	};
}

suite('Agent Activity Canvas runtime cleanup composition', () => {
	test('live detach는 inbound를 닫고 lease clear를 admission한 뒤 bridge를 dispose한다', () => {
		const timeline: string[] = [];
		const bridge = createRecordingBridge(timeline);
		const host = createRecordingTerminalRuntime(timeline, bridge);
		const terminalRuntime = createAgentActivityCanvasTerminalRuntime(
			host.runtime,
			bridge.bridge,
		);
		const cleanup = createTerminalRuntimeCleanup(terminalRuntime, [
			createInboundSubscription(timeline),
		]);

		cleanup.detach();

		assert.deepStrictEqual(timeline, [
			'inbound.dispose',
			'host.detach',
			'lease.revoke',
			'clear.post',
			'delivery.stop',
			'supervisor.teardown',
			'bridge.disposePanel',
		]);
		assert.strictEqual(bridge.clearPosts, 1);
		assert.strictEqual(bridge.disposeEffects, 1);
		assert.strictEqual(host.detachCalls, 1);
	});

	test('already-disposed panel은 bridge를 먼저 dispose해 revoke cleanup post를 막는다', () => {
		const timeline: string[] = [];
		const bridge = createRecordingBridge(timeline);
		const host = createRecordingTerminalRuntime(timeline, bridge);
		const terminalRuntime = createAgentActivityCanvasTerminalRuntime(
			host.runtime,
			bridge.bridge,
		);
		const cleanup = createTerminalRuntimeCleanup(terminalRuntime, [
			createInboundSubscription(timeline),
		]);

		bridge.bridge.disposePanel();
		cleanup.detach();

		assert.deepStrictEqual(timeline, [
			'bridge.disposePanel',
			'inbound.dispose',
			'host.detach',
			'lease.revoke',
			'delivery.stop',
			'supervisor.teardown',
		]);
		assert.strictEqual(bridge.clearPosts, 0);
		assert.strictEqual(bridge.disposeInvocations, 2);
		assert.strictEqual(bridge.disposeEffects, 1);
		assert.strictEqual(host.detachCalls, 1);
	});

	test('반복 detach와 terminate는 멱등이고 host detach throw에도 bridge를 dispose한다', async () => {
		const timeline: string[] = [];
		const bridge = createRecordingBridge(timeline);
		const host = createRecordingTerminalRuntime(timeline, bridge, {
			throwOnDetach: true,
		});
		const terminalRuntime = createAgentActivityCanvasTerminalRuntime(
			host.runtime,
			bridge.bridge,
		);
		const cleanup = createTerminalRuntimeCleanup(terminalRuntime, [
			createInboundSubscription(timeline),
		]);

		cleanup.detach();
		cleanup.detach();
		const firstTermination = cleanup.terminate();
		const duplicateTermination = cleanup.terminate();

		assert.strictEqual(duplicateTermination, firstTermination);
		await firstTermination;
		assert.deepStrictEqual(timeline, [
			'inbound.dispose',
			'host.detach',
			'bridge.disposePanel',
			'host.terminate',
		]);
		assert.strictEqual(host.detachCalls, 1);
		assert.strictEqual(host.terminateCalls, 1);
		assert.strictEqual(bridge.disposeInvocations, 1);
		assert.strictEqual(bridge.disposeEffects, 1);
	});
});
