export const ACTIVITY_RATE_PER_SECOND = 64;
export const ACTIVITY_RATE_BURST = 128;
export const CHILD_IPC_PENDING_EVENTS = 64;
export const CHILD_IPC_PENDING_BYTES = 512 * 1_024;

export interface ActivityAdmissionState {
	closed: boolean;
	tokens: number;
	lastRefillMonotonicMs: number;
	childPendingEvents: number;
	childPendingBytes: number;
}

export interface ActivityChildReservation {
	readonly bytes: number;
	release(): void;
}

export type MonotonicClock = () => number;

/** One exact registration/generation owns one instance for its full lifetime. */
export class RegistrationActivityAdmission {
	readonly state: ActivityAdmissionState;
	private readonly clock: MonotonicClock;
	private readonly reservations = new Set<ActivityChildReservation>();

	constructor(clock: MonotonicClock) {
		this.clock = clock;
		this.state = {
			closed: false,
			tokens: ACTIVITY_RATE_BURST,
			lastRefillMonotonicMs: safeClockValue(clock),
			childPendingEvents: 0,
			childPendingBytes: 0,
		};
	}

	acquireToken(): boolean {
		if (this.state.closed) {
			return false;
		}
		const now = safeClockValue(this.clock);
		if (this.state.closed) {
			return false;
		}
		if (now > this.state.lastRefillMonotonicMs) {
			const elapsedMs = now - this.state.lastRefillMonotonicMs;
			this.state.tokens = Math.min(
				ACTIVITY_RATE_BURST,
				this.state.tokens + (elapsedMs * ACTIVITY_RATE_PER_SECOND / 1_000),
			);
			this.state.lastRefillMonotonicMs = now;
		}
		if (this.state.tokens < 1) {
			return false;
		}
		this.state.tokens -= 1;
		return true;
	}

	reserveChildEvent(bytes: number): ActivityChildReservation | undefined {
		if (
			this.state.closed
			|| !Number.isSafeInteger(bytes)
			|| bytes < 0
			|| this.state.childPendingEvents + 1 > CHILD_IPC_PENDING_EVENTS
			|| this.state.childPendingBytes + bytes > CHILD_IPC_PENDING_BYTES
		) {
			return undefined;
		}

		this.state.childPendingEvents += 1;
		this.state.childPendingBytes += bytes;
		let active = true;
		const reservation: ActivityChildReservation = Object.freeze({
			bytes,
			release: (): void => {
				if (!active) {
					return;
				}
				active = false;
				this.reservations.delete(reservation);
				this.state.childPendingEvents -= 1;
				this.state.childPendingBytes -= bytes;
			},
		});
		this.reservations.add(reservation);
		return reservation;
	}

	close(): void {
		if (this.state.closed) {
			return;
		}
		this.state.closed = true;
		for (const reservation of [...this.reservations].reverse()) {
			reservation.release();
		}
	}
}

function safeClockValue(clock: MonotonicClock): number {
	try {
		const value = clock();
		return Number.isFinite(value) && value >= 0 ? value : 0;
	} catch {
		return 0;
	}
}
