import * as assert from 'node:assert/strict';
import {
	ACTIVITY_RATE_BURST,
	ACTIVITY_RATE_PER_SECOND,
	CHILD_IPC_PENDING_BYTES,
	CHILD_IPC_PENDING_EVENTS,
	RegistrationActivityAdmission,
	type ActivityChildReservation,
} from '../../mcp/activityAdmission';

suite('MCP registration activity admission', () => {
	test('state는 frozen clock 시점의 exact five fields로 시작한다', () => {
		const clock = frozenClock(12_345);
		const admission = new RegistrationActivityAdmission(clock.read);

		assert.deepStrictEqual(Object.keys(admission.state), [
			'closed',
			'tokens',
			'lastRefillMonotonicMs',
			'childPendingEvents',
			'childPendingBytes',
		]);
		assert.deepStrictEqual(admission.state, {
			closed: false,
			tokens: ACTIVITY_RATE_BURST,
			lastRefillMonotonicMs: 12_345,
			childPendingEvents: 0,
			childPendingBytes: 0,
		});
	});

	test('initial 128회 뒤 busy이고 64/s로 refill하되 burst를 넘지 않는다', () => {
		const clock = frozenClock(1_000);
		const admission = new RegistrationActivityAdmission(clock.read);

		assertTokenAcquisitions(admission, ACTIVITY_RATE_BURST);
		assert.strictEqual(admission.acquireToken(), false, '129th must be busy');
		assert.strictEqual(admission.state.tokens, 0);
		assert.strictEqual(admission.state.lastRefillMonotonicMs, 1_000);

		clock.advance(1_000);
		assertTokenAcquisitions(admission, ACTIVITY_RATE_PER_SECOND);
		assert.strictEqual(admission.acquireToken(), false, '65th in one second must be busy');
		assert.strictEqual(admission.state.tokens, 0);
		assert.strictEqual(admission.state.lastRefillMonotonicMs, 2_000);

		clock.advance(10_000);
		assertTokenAcquisitions(admission, ACTIVITY_RATE_BURST);
		assert.strictEqual(admission.acquireToken(), false, 'refill must remain burst-capped');
		assert.strictEqual(admission.state.tokens, 0);
		assert.strictEqual(admission.state.lastRefillMonotonicMs, 12_000);
	});

	test('clock 호출 중 lifecycle close가 재진입하면 token을 소비하지 않는다', () => {
		let clockReads = 0;
		let admission: RegistrationActivityAdmission;
		admission = new RegistrationActivityAdmission(() => {
			clockReads += 1;
			if (clockReads > 1) {
				admission.close();
			}
			return 1_000;
		});

		assert.strictEqual(admission.acquireToken(), false);
		assert.strictEqual(admission.state.closed, true);
		assert.strictEqual(admission.state.tokens, ACTIVITY_RATE_BURST);
	});

	test('event와 byte composite exact cap을 허용하고 N+1 실패는 counters를 보존한다', () => {
		const admission = new RegistrationActivityAdmission(() => 0);
		const bytesPerEvent = CHILD_IPC_PENDING_BYTES / CHILD_IPC_PENDING_EVENTS;
		const reservations: ActivityChildReservation[] = [];

		for (let index = 0; index < CHILD_IPC_PENDING_EVENTS; index += 1) {
			const reservation = admission.reserveChildEvent(bytesPerEvent);
			assert.ok(reservation, `reservation ${index + 1} must fit`);
			reservations.push(reservation);
		}
		assert.deepStrictEqual(pendingCounters(admission), {
			events: CHILD_IPC_PENDING_EVENTS,
			bytes: CHILD_IPC_PENDING_BYTES,
		});

		const beforeOverflow = { ...admission.state };
		assert.strictEqual(admission.reserveChildEvent(0), undefined);
		assert.deepStrictEqual(admission.state, beforeOverflow);

		for (const reservation of reservations.reverse()) {
			reservation.release();
		}
		assert.deepStrictEqual(pendingCounters(admission), { events: 0, bytes: 0 });
	});

	test('byte와 invalid argument 실패는 partial increment 없이 counters를 보존한다', () => {
		const admission = new RegistrationActivityAdmission(() => 0);
		for (const invalidBytes of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const before = { ...admission.state };
			assert.strictEqual(admission.reserveChildEvent(invalidBytes), undefined);
			assert.deepStrictEqual(admission.state, before);
		}

		const almostFull = admission.reserveChildEvent(CHILD_IPC_PENDING_BYTES - 1);
		const lastByte = admission.reserveChildEvent(1);
		assert.ok(almostFull);
		assert.ok(lastByte);
		assert.deepStrictEqual(pendingCounters(admission), {
			events: 2,
			bytes: CHILD_IPC_PENDING_BYTES,
		});

		const beforeOverflow = { ...admission.state };
		assert.strictEqual(admission.reserveChildEvent(1), undefined);
		assert.deepStrictEqual(admission.state, beforeOverflow);

		lastByte.release();
		almostFull.release();
		assert.deepStrictEqual(pendingCounters(admission), { events: 0, bytes: 0 });
	});

	test('child capacity 실패는 먼저 소비한 rate token을 rollback하지 않는다', () => {
		const eventLimited = new RegistrationActivityAdmission(() => 0);
		const reservations: ActivityChildReservation[] = [];
		for (let index = 0; index < CHILD_IPC_PENDING_EVENTS; index += 1) {
			const reservation = eventLimited.reserveChildEvent(1);
			assert.ok(reservation);
			reservations.push(reservation);
		}
		assert.strictEqual(eventLimited.acquireToken(), true);
		assert.strictEqual(eventLimited.reserveChildEvent(1), undefined);
		assert.strictEqual(eventLimited.state.tokens, ACTIVITY_RATE_BURST - 1);
		assert.deepStrictEqual(pendingCounters(eventLimited), {
			events: CHILD_IPC_PENDING_EVENTS,
			bytes: CHILD_IPC_PENDING_EVENTS,
		});

		const byteLimited = new RegistrationActivityAdmission(() => 0);
		const byteReservation = byteLimited.reserveChildEvent(CHILD_IPC_PENDING_BYTES);
		assert.ok(byteReservation);
		assert.strictEqual(byteLimited.acquireToken(), true);
		assert.strictEqual(byteLimited.reserveChildEvent(1), undefined);
		assert.strictEqual(byteLimited.state.tokens, ACTIVITY_RATE_BURST - 1);
		assert.deepStrictEqual(pendingCounters(byteLimited), {
			events: 1,
			bytes: CHILD_IPC_PENDING_BYTES,
		});

		for (const reservation of reservations) {
			reservation.release();
		}
		byteReservation.release();
	});

	test('callback/lifecycle release와 late release는 exactly once이며 counters는 nonnegative다', () => {
		const admission = new RegistrationActivityAdmission(() => 0);
		const callbackFirst = admission.reserveChildEvent(11);
		const lifecycleFirst = admission.reserveChildEvent(13);
		const anotherLifecycleReservation = admission.reserveChildEvent(17);
		assert.ok(callbackFirst);
		assert.ok(lifecycleFirst);
		assert.ok(anotherLifecycleReservation);
		assert.strictEqual(Object.isFrozen(callbackFirst), true);
		assert.strictEqual(callbackFirst.bytes, 11);

		const callback = (): void => callbackFirst.release();
		callback();
		callback();
		assert.deepStrictEqual(pendingCounters(admission), { events: 2, bytes: 30 });
		assertNonnegativeCounters(admission);

		admission.close();
		assert.strictEqual(admission.state.closed, true);
		assert.deepStrictEqual(pendingCounters(admission), { events: 0, bytes: 0 });
		assertNonnegativeCounters(admission);

		lifecycleFirst.release();
		lifecycleFirst.release();
		anotherLifecycleReservation.release();
		callback();
		admission.close();
		assert.deepStrictEqual(pendingCounters(admission), { events: 0, bytes: 0 });
		assertNonnegativeCounters(admission);
		assert.strictEqual(admission.reserveChildEvent(1), undefined);
		assert.strictEqual(admission.acquireToken(), false);
		assert.deepStrictEqual(pendingCounters(admission), { events: 0, bytes: 0 });
	});
});

interface FrozenClock {
	readonly read: () => number;
	readonly advance: (elapsedMs: number) => void;
}

function frozenClock(initialMs: number): FrozenClock {
	let now = initialMs;
	return {
		read: () => now,
		advance: (elapsedMs): void => {
			now += elapsedMs;
		},
	};
}

function assertTokenAcquisitions(
	admission: RegistrationActivityAdmission,
	count: number,
): void {
	for (let index = 0; index < count; index += 1) {
		assert.strictEqual(
			admission.acquireToken(),
			true,
			`token acquisition ${index + 1} must succeed`,
		);
	}
}

function pendingCounters(
	admission: RegistrationActivityAdmission,
): { readonly events: number; readonly bytes: number } {
	return {
		events: admission.state.childPendingEvents,
		bytes: admission.state.childPendingBytes,
	};
}

function assertNonnegativeCounters(admission: RegistrationActivityAdmission): void {
	assert.ok(admission.state.childPendingEvents >= 0);
	assert.ok(admission.state.childPendingBytes >= 0);
}
