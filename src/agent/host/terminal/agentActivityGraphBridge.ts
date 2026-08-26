import type { AgentActivityRequested } from '../../../mcp/agentActivityProtocol';
import { normalizeAgentActivityPath } from '../../../mcp/agentActivityProtocol';
import {
	clearAgentActivitiesBySession,
	clearAgentActivity,
	parseAgentActivityClearAppliedReceipt,
	setAgentActivity,
	type AgentActivityTrackedClearMessage,
	type ExtensionToWebviewMessage,
	type GraphNodeEffectTarget,
} from '../../../messages';
import type { WorkspaceResolver } from '../workspace/workspaceResolver';
import type {
	ValidatedWorkspaceRoot,
	WorkspaceValidationFailure,
} from '../workspace/types';
import {
	createAgentActivityGraphTarget,
	createClearAgentActivityTarget,
	matchesAgentActivityLeaseWorkspaceRoot,
	validateSetAgentActivityTarget,
	type AgentActivityTargetRequest,
	type ValidatedAgentActivityTarget,
} from './agentActivityTargetValidator';
import type {
	ActivityLease,
	HostAgentActivityRequest,
} from './terminalHost';

export const HOST_PENDING_PER_SESSION_EVENTS = 128;
export const HOST_PENDING_PER_SESSION_BYTES = 1 * 1_024 * 1_024;
export const HOST_PENDING_PER_PANEL_EVENTS = 512;
export const HOST_PENDING_PER_PANEL_BYTES = 4 * 1_024 * 1_024;
export const HOST_PENDING_PER_EXTENSION_EVENTS = 512;
export const HOST_PENDING_PER_EXTENSION_BYTES = 4 * 1_024 * 1_024;
export const VALIDATIONS_IN_FLIGHT_PER_PANEL = 16;
export const VALIDATIONS_IN_FLIGHT_PER_EXTENSION = 16;

export const POST_PENDING_PER_SESSION_EVENTS = 64;
export const POST_PENDING_PER_SESSION_BYTES = 512 * 1_024;
export const POST_PENDING_PER_PANEL_EVENTS = 256;
export const POST_PENDING_PER_PANEL_BYTES = 2 * 1_024 * 1_024;
export const CLEANUP_POST_PENDING_PER_PANEL_EVENTS = 128;
export const CLEANUP_POST_PENDING_PER_PANEL_BYTES = 1 * 1_024 * 1_024;
export const POST_WORK_PENDING_PER_EXTENSION_EVENTS = 384;
export const POST_WORK_PENDING_PER_EXTENSION_BYTES = 3 * 1_024 * 1_024;

export const ACTIVE_TARGETS_PER_SESSION = 256;
export const ACTIVE_TARGETS_PER_PANEL = 1_024;

const ROOT_UNAVAILABLE: WorkspaceValidationFailure = Object.freeze({
	ok: false,
	code: 'workspace_root_unavailable',
});

/** JSON wire 크기는 UTF-16 string length가 아니라 실제 UTF-8 byte로 센다. */
export function wireUtf8Bytes(value: unknown): number {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new TypeError('Wire value is not serializable.');
	}
	return Buffer.byteLength(serialized, 'utf8');
}

export interface RetiredSessionQuota {
	readonly sessionId: string;
	readonly count: number;
	released: boolean;
}

export type AgentActivityBridgePostMessage = (
	message: ExtensionToWebviewMessage,
) => Thenable<boolean>;

export type AgentActivitySetTargetValidator = (
	lease: ActivityLease,
	root: ValidatedWorkspaceRoot,
	request: AgentActivityTargetRequest,
) =>
	| boolean
	| ValidatedAgentActivityTarget
	| undefined
	| PromiseLike<boolean | ValidatedAgentActivityTarget | undefined>;

export interface AgentActivityGraphBridgeOptions {
	readonly postMessage: AgentActivityBridgePostMessage;
	readonly resolveWorkspace: WorkspaceResolver;
	readonly invalidateLease: (
		lease: ActivityLease,
		failure: WorkspaceValidationFailure,
	) => void;
	readonly validateSetTarget?: AgentActivitySetTargetValidator;
	readonly enabled?: boolean;
	/** Overflow tests only. This is the next sequence issued for a new lease. */
	readonly initialSequence?: number;
	/** Overflow tests only. This is the next panel-local receipt ID. */
	readonly initialReceiptId?: number;
}

export interface AgentActivityGraphRegistrySnapshot {
	readonly hostPendingEvents: number;
	readonly hostPendingBytes: number;
	readonly validationsInFlight: number;
	readonly postWorkPendingEvents: number;
	readonly postWorkPendingBytes: number;
	readonly detachedValidations: number;
	readonly detachedValidationBytes: number;
	readonly detachedPosts: number;
	readonly detachedPostBytes: number;
}

export interface AgentActivityGraphBridgePanelSnapshot {
	readonly hostPendingEvents: number;
	readonly hostPendingBytes: number;
	readonly validationsInFlight: number;
	readonly validationQueueLength: number;
	readonly postPendingEvents: number;
	readonly postPendingBytes: number;
	readonly cleanupPostPendingEvents: number;
	readonly cleanupPostPendingBytes: number;
	readonly activeTargets: number;
	readonly receiptCount: number;
	readonly deferredReceiptLineageCount: number;
	readonly retiredQuotaCount: number;
}

interface ExtensionRegistry {
	hostPendingEvents: number;
	hostPendingBytes: number;
	validationsInFlight: number;
	postWorkPendingEvents: number;
	postWorkPendingBytes: number;
	detachedValidations: number;
	detachedValidationBytes: number;
	detachedPosts: number;
	detachedPostBytes: number;
	readonly validationWaiters: Set<() => void>;
}

/** Module/process lifetime registry: panel deactivate/reactivate does not reset it. */
const extensionRegistry: ExtensionRegistry = {
	hostPendingEvents: 0,
	hostPendingBytes: 0,
	validationsInFlight: 0,
	postWorkPendingEvents: 0,
	postWorkPendingBytes: 0,
	detachedValidations: 0,
	detachedValidationBytes: 0,
	detachedPosts: 0,
	detachedPostBytes: 0,
	validationWaiters: new Set(),
};

export function getAgentActivityGraphRegistrySnapshotForTest(
): AgentActivityGraphRegistrySnapshot {
	return Object.freeze({
		hostPendingEvents: extensionRegistry.hostPendingEvents,
		hostPendingBytes: extensionRegistry.hostPendingBytes,
		validationsInFlight: extensionRegistry.validationsInFlight,
		postWorkPendingEvents: extensionRegistry.postWorkPendingEvents,
		postWorkPendingBytes: extensionRegistry.postWorkPendingBytes,
		detachedValidations: extensionRegistry.detachedValidations,
		detachedValidationBytes: extensionRegistry.detachedValidationBytes,
		detachedPosts: extensionRegistry.detachedPosts,
		detachedPostBytes: extensionRegistry.detachedPostBytes,
	});
}

interface TargetState {
	readonly key: string;
	readonly target: Readonly<GraphNodeEffectTarget>;
	sequence: number;
	operation: 'set' | 'clear';
	occupancy?: TargetOccupancy;
	pendingValidations: number;
	clearReceiptId?: number;
	deferredClearReceipts?: DeferredTargetClearReceipt[];
}

interface TargetOccupancy {
	pendingSetPosts: number;
	/** postMessage true를 보수적으로 기억할 뿐 Webview Store 적용 ACK가 아니다. */
	hasPostedSet: boolean;
	counted: boolean;
}

interface LeaseState {
	readonly lease: ActivityLease;
	readonly sessionId: string;
	readonly targets: Map<string, TargetState>;
	nextSequence: number | undefined;
	hostEvents: number;
	hostBytes: number;
	postEvents: number;
	postBytes: number;
	activeTargets: number;
	closed: boolean;
	invalidating: boolean;
}

interface HostReservation {
	readonly bytes: number;
	readonly leaseState: LeaseState;
	localHeld: boolean;
	globalHeld: boolean;
}

interface DeferredHostRelease {
	readonly reservation: HostReservation;
	readonly releaseGlobal: boolean;
}

interface ValidationRecord {
	readonly key: object;
	readonly leaseState: LeaseState;
	readonly targetKey: string;
	readonly sequence: number;
	readonly activity: Parameters<typeof setAgentActivity>[2];
	readonly targetRequest: AgentActivityTargetRequest;
	readonly target: Readonly<GraphNodeEffectTarget>;
	readonly reservation: HostReservation;
	status: 'queued' | 'running';
	handle?: ValidationHandle;
}

interface ValidationHandle {
	readonly key: object;
	readonly hostBytes: number;
	owner?: AgentActivityGraphBridge;
	settled: boolean;
	detached: boolean;
}

interface LocalPostReservation {
	readonly kind: 'regular' | 'cleanup';
	readonly bytes: number;
	readonly leaseState?: LeaseState;
	held: boolean;
}

interface PostHandle {
	readonly key: object;
	readonly bytes: number;
	owner?: AgentActivityGraphBridge;
	settled: boolean;
	detached: boolean;
}

interface SetPostRecord {
	readonly kind: 'set';
	readonly key: object;
	readonly leaseState: LeaseState;
	readonly targetKey: string;
	readonly sequence: number;
	readonly occupancy: TargetOccupancy;
	readonly local: LocalPostReservation;
	readonly handle: PostHandle;
	settled: boolean;
}

interface TargetClearPostRecord {
	readonly kind: 'targetClear';
	readonly key: object;
	readonly leaseState: LeaseState;
	readonly targetKey: string;
	readonly sequence: number;
	readonly receiptId: number;
	readonly local: LocalPostReservation;
	readonly handle: PostHandle;
	settled: boolean;
}

interface CleanupPostRecord {
	readonly kind: 'cleanup';
	readonly key: object;
	readonly quota: RetiredSessionQuota;
	readonly receiptId?: number;
	readonly local: LocalPostReservation;
	readonly handle: PostHandle;
	settled: boolean;
}

type PostRecord = SetPostRecord | TargetClearPostRecord | CleanupPostRecord;

interface TargetReceiptRecord {
	readonly kind: 'target';
	readonly postKey: object;
	readonly leaseState: LeaseState;
	readonly targetKey: string;
	readonly sequence: number;
	readonly occupancy: TargetOccupancy;
}

/**
 * A clear receipt stays recoverable while newer set posts have not yet proved
 * that any replacement was actually posted. Receipt arrival is remembered so
 * an all-failed replacement can still settle the original occupancy.
 */
interface DeferredTargetClearReceipt {
	readonly receiptId: number;
	readonly record: TargetReceiptRecord;
	readonly pendingSetPostKeys: Set<object>;
	receiptApplied: boolean;
}

interface CleanupReceiptRecord {
	readonly kind: 'cleanup';
	readonly postKey: object;
	readonly quota: RetiredSessionQuota;
}

type ReceiptRecord = TargetReceiptRecord | CleanupReceiptRecord;

type FreshWorkspaceResult =
	| { readonly ok: true; readonly root: ValidatedWorkspaceRoot }
	| { readonly ok: false; readonly failure: WorkspaceValidationFailure };

function targetKey(target: Readonly<GraphNodeEffectTarget>): string {
	return JSON.stringify([target.nodeId, target.rootId ?? null]);
}

function sameTarget(
	left: Readonly<GraphNodeEffectTarget>,
	right: Readonly<GraphNodeEffectTarget>,
): boolean {
	return left.nodeId === right.nodeId && left.rootId === right.rootId;
}

function fixedActivityEvent(event: AgentActivityRequested): AgentActivityRequested {
	return event.operation === 'set'
		? Object.freeze({
			type: 'session.agentActivityRequested',
			sessionId: event.sessionId,
			generation: event.generation,
			operation: 'set',
			path: event.path,
			targetKind: event.targetKind,
			activity: event.activity,
		})
		: Object.freeze({
			type: 'session.agentActivityRequested',
			sessionId: event.sessionId,
			generation: event.generation,
			operation: 'clear',
			path: event.path,
			targetKind: event.targetKind,
		});
}

function releaseGlobalHost(bytes: number): void {
	extensionRegistry.hostPendingEvents -= 1;
	extensionRegistry.hostPendingBytes -= bytes;
}

function releaseGlobalValidation(bytes: number, detached: boolean): void {
	extensionRegistry.validationsInFlight -= 1;
	releaseGlobalHost(bytes);
	if (detached) {
		extensionRegistry.detachedValidations -= 1;
		extensionRegistry.detachedValidationBytes -= bytes;
	}
	for (const waiter of [...extensionRegistry.validationWaiters]) {
		waiter();
	}
}

function settleValidationHandle(
	handle: ValidationHandle,
	result: boolean | ValidatedAgentActivityTarget | undefined,
): void {
	if (handle.settled) {
		return;
	}
	handle.settled = true;
	const owner = handle.owner;
	if (owner === undefined) {
		releaseGlobalValidation(handle.hostBytes, handle.detached);
		return;
	}
	owner.settleValidation(handle, result);
}

function releaseGlobalPost(bytes: number, detached: boolean): void {
	extensionRegistry.postWorkPendingEvents -= 1;
	extensionRegistry.postWorkPendingBytes -= bytes;
	if (detached) {
		extensionRegistry.detachedPosts -= 1;
		extensionRegistry.detachedPostBytes -= bytes;
	}
}

function settlePostHandle(handle: PostHandle, posted: boolean): void {
	if (handle.settled) {
		return;
	}
	handle.settled = true;
	const owner = handle.owner;
	if (owner === undefined) {
		releaseGlobalPost(handle.bytes, handle.detached);
		return;
	}
	owner.settlePost(handle, posted);
}

/**
 * Exact ActivityLease에서 same-panel Graph Source wire로 연결하는 bounded bridge다.
 * 모든 public wire는 기존 constructor를 사용하며 ordering metadata는 Host에만 남는다.
 */
export class AgentActivityGraphBridge {
	private readonly postMessage: AgentActivityBridgePostMessage;
	private readonly resolveWorkspace: WorkspaceResolver;
	private readonly invalidateLease: AgentActivityGraphBridgeOptions['invalidateLease'];
	private readonly validateSetTarget: AgentActivitySetTargetValidator;
	private readonly enabled: boolean;
	private readonly initialSequence: number;
	private nextReceiptId: number | undefined;
	private readonly leaseStates = new Map<ActivityLease, LeaseState>();
	private readonly currentLeaseBySession = new Map<string, ActivityLease>();
	private readonly highestEpochBySession = new WeakMap<
		ActivityLease['session'],
		number
	>();
	private readonly retiredCountBySession = new Map<string, number>();
	private readonly validationRecords = new Map<object, ValidationRecord>();
	private validationQueue: object[] = [];
	private readonly postRecords = new Map<object, PostRecord>();
	private readonly receiptRecords = new Map<number, ReceiptRecord>();
	private readonly retiredQuotas = new Set<RetiredSessionQuota>();
	private hostEvents = 0;
	private hostBytes = 0;
	private validationsInFlight = 0;
	private postEvents = 0;
	private postBytes = 0;
	private cleanupPostEvents = 0;
	private cleanupPostBytes = 0;
	private activeTargets = 0;
	private disposed = false;
	private pumping = false;
	private readonly validationWaiter = (): void => this.pumpValidations();

	constructor(options: AgentActivityGraphBridgeOptions) {
		this.postMessage = options.postMessage;
		this.resolveWorkspace = options.resolveWorkspace;
		this.invalidateLease = options.invalidateLease;
		this.validateSetTarget = options.validateSetTarget
			?? validateSetAgentActivityTarget;
		this.enabled = options.enabled !== false;
		this.initialSequence = normalizeInitialCounter(options.initialSequence);
		this.nextReceiptId = normalizeInitialCounter(options.initialReceiptId);
		if (this.enabled) {
			extensionRegistry.validationWaiters.add(this.validationWaiter);
		}
	}

	/** Host ownership gate를 통과한 exact handoff를 동기 admission한다. */
	handleAgentActivityRequest(request: HostAgentActivityRequest): void {
		if (!this.enabled || this.disposed || !this.isExactLiveRequest(request)) {
			return;
		}
		const leaseState = this.getOrCreateLeaseState(request.lease);
		if (leaseState === undefined || leaseState.closed) {
			return;
		}

		let bytes: number;
		try {
			bytes = wireUtf8Bytes(fixedActivityEvent(request.event));
		} catch {
			return;
		}
		const reservation = this.reserveHost(leaseState, bytes);
		if (reservation === undefined) {
			return;
		}
		const sequence = this.issueSequence(leaseState);
		if (sequence === undefined) {
			try {
				this.failClosed(leaseState, ROOT_UNAVAILABLE);
			} finally {
				this.releaseHost(reservation, true);
			}
			return;
		}

		const workspace = this.resolveFreshWorkspace(leaseState.lease);
		if (!workspace.ok) {
			try {
				this.failClosed(leaseState, workspace.failure);
			} finally {
				this.releaseHost(reservation, true);
			}
			return;
		}
		const normalized = normalizeAgentActivityPath(
			request.event.path,
			request.event.targetKind,
		);
		if (!normalized.ok || normalized.path !== request.event.path) {
			this.releaseHost(reservation, true);
			return;
		}
		const targetRequest = Object.freeze({
			path: normalized.path,
			targetKind: request.event.targetKind,
		});
		const target = request.event.operation === 'clear'
			? createClearAgentActivityTarget(
				leaseState.lease,
				workspace.root,
				targetRequest,
			)
			: createAgentActivityGraphTarget(
				leaseState.lease,
				workspace.root,
				targetRequest,
			);
		if (target === undefined) {
			try {
				this.failClosed(leaseState, ROOT_UNAVAILABLE);
			} finally {
				this.releaseHost(reservation, true);
			}
			return;
		}

		if (request.event.operation === 'clear') {
			try {
				this.processClear(
					leaseState,
					sequence,
					targetRequest,
					target,
				);
			} finally {
				this.releaseHost(reservation, true);
			}
			return;
		}

		this.enqueueSetValidation(
			leaseState,
			sequence,
			request.event.activity,
			targetRequest,
			target,
			reservation,
		);
	}

	/** Compatibility alias for integrations that name the seam as a handler. */
	handleRequest(request: HostAgentActivityRequest): void {
		this.handleAgentActivityRequest(request);
	}

	/** Exact lease common cleanup prefix. clearSession post invocation occurs inline. */
	revokeLease(lease: ActivityLease): void {
		const state = this.leaseStates.get(lease);
		if (state === undefined || state.closed) {
			return;
		}
		state.closed = true;
		this.leaseStates.delete(lease);
		if (this.currentLeaseBySession.get(state.sessionId) === lease) {
			this.currentLeaseBySession.delete(state.sessionId);
		}

		const quota: RetiredSessionQuota = {
			sessionId: state.sessionId,
			count: state.activeTargets,
			released: false,
		};
		state.activeTargets = 0;
		this.retiredQuotas.add(quota);
		if (quota.count !== 0) {
			this.retiredCountBySession.set(
				quota.sessionId,
				(this.retiredCountBySession.get(quota.sessionId) ?? 0) + quota.count,
			);
		}

		state.targets.clear();
		this.subsumeTargetReceipts(state);
		const deferredHostReleases: DeferredHostRelease[] = [];
		const deferredPostReleases: LocalPostReservation[] = [];
		this.removeQueuedValidations(state, undefined, deferredHostReleases);
		const orphanedValidationSlots = this.orphanRunningValidations(
			state,
			deferredHostReleases,
		);
		for (const record of [...this.postRecords.values()]) {
			if (
				(record.kind === 'set' || record.kind === 'targetClear')
				&& record.leaseState === state
			) {
				this.orphanPost(record, deferredPostReleases);
			}
		}
		this.postCleanupClear(quota);
		for (const deferred of deferredHostReleases) {
			this.releaseHost(deferred.reservation, deferred.releaseGlobal);
		}
		this.validationsInFlight -= orphanedValidationSlots;
		for (const local of deferredPostReleases) {
			this.releaseLocalPost(local);
		}
		this.pumpValidations();
	}

	/** Strict receipt parser. Valid-but-wrong/duplicate/late receipts are consumed. */
	handleWebviewMessage(value: unknown): boolean {
		const receipt = parseAgentActivityClearAppliedReceipt(value);
		if (receipt === undefined) {
			return false;
		}
		const record = this.receiptRecords.get(receipt.receiptId);
		if (record === undefined) {
			return true;
		}
		this.receiptRecords.delete(receipt.receiptId);
		const post = this.postRecords.get(record.postKey);
		if (record.kind === 'target') {
			const target = record.leaseState.targets.get(record.targetKey);
			const deferred = target?.deferredClearReceipts?.find(
				(candidate) => candidate.receiptId === receipt.receiptId
					&& candidate.record === record,
			);
			if (
				target !== undefined
				&& target.clearReceiptId === receipt.receiptId
				&& target.occupancy === record.occupancy
			) {
				this.discardAllTargetReceipts(target);
				this.releaseOccupiedTarget(
					record.leaseState,
					target,
					record.occupancy,
				);
				this.pruneTarget(record.leaseState, target);
			} else if (target !== undefined && deferred !== undefined) {
				if (
					deferred.pendingSetPostKeys.size === 0
					&& target.occupancy === record.occupancy
				) {
					this.discardAllTargetReceipts(target);
					this.releaseOccupiedTarget(
						record.leaseState,
						target,
						record.occupancy,
					);
					this.pruneTarget(record.leaseState, target);
				} else {
					deferred.receiptApplied = true;
					this.discardTargetReceiptsOlderThan(
						target,
						deferred.record.sequence,
					);
				}
			}
		} else {
			this.releaseRetiredQuota(record.quota);
		}
		if (post !== undefined) {
			this.maybeDeletePost(post);
		}
		return true;
	}

	/** Panel onDidDispose cleanup: no post, semantic records become path-free work. */
	disposePanel(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		extensionRegistry.validationWaiters.delete(this.validationWaiter);
		for (const state of [...this.leaseStates.values()]) {
			state.closed = true;
			this.removeQueuedValidations(state);
			this.orphanRunningValidations(state);
			state.targets.clear();
		}
		this.leaseStates.clear();
		this.currentLeaseBySession.clear();
		for (const record of [...this.postRecords.values()]) {
			this.orphanPost(record);
		}
		for (const quota of this.retiredQuotas) {
			this.releaseRetiredQuota(quota);
		}
		this.retiredCountBySession.clear();
		this.receiptRecords.clear();
		this.validationQueue = [];
		this.activeTargets = 0;
	}

	dispose(): void {
		this.disposePanel();
	}

	/** Sensitive identity를 노출하지 않는 focused-test용 panel accounting snapshot이다. */
	getPanelSnapshotForTest(): AgentActivityGraphBridgePanelSnapshot {
		let deferredReceiptLineageCount = 0;
		for (const state of this.leaseStates.values()) {
			for (const target of state.targets.values()) {
				deferredReceiptLineageCount += target.deferredClearReceipts?.length ?? 0;
			}
		}
		return Object.freeze({
			hostPendingEvents: this.hostEvents,
			hostPendingBytes: this.hostBytes,
			validationsInFlight: this.validationsInFlight,
			validationQueueLength: this.validationQueue.length,
			postPendingEvents: this.postEvents,
			postPendingBytes: this.postBytes,
			cleanupPostPendingEvents: this.cleanupPostEvents,
			cleanupPostPendingBytes: this.cleanupPostBytes,
			activeTargets: this.activeTargets,
			receiptCount: this.receiptRecords.size,
			deferredReceiptLineageCount,
			retiredQuotaCount: this.retiredQuotas.size,
		});
	}

	/** Path-free settlement entry used by module lifetime handles. */
	settleValidation(
		handle: ValidationHandle,
		result: boolean | ValidatedAgentActivityTarget | undefined,
	): void {
		const record = this.validationRecords.get(handle.key);
		this.validationsInFlight -= 1;
		releaseGlobalValidation(handle.hostBytes, false);
		if (record === undefined) {
			this.pumpValidations();
			return;
		}
		this.validationRecords.delete(handle.key);
		this.releaseHost(record.reservation, false);
		const target = record.leaseState.targets.get(record.targetKey);
		if (target !== undefined) {
			target.pendingValidations -= 1;
		}
		if (
			this.isValidationSuccess(result, record.target)
			&& !record.leaseState.closed
			&& !record.leaseState.lease.revoked
			&& target !== undefined
			&& target.sequence === record.sequence
			&& target.operation === 'set'
		) {
			const workspace = this.resolveFreshWorkspace(record.leaseState.lease);
			if (!workspace.ok) {
				this.failClosed(record.leaseState, workspace.failure);
			} else {
				const finalTarget = createAgentActivityGraphTarget(
					record.leaseState.lease,
					workspace.root,
					record.targetRequest,
				);
				if (finalTarget === undefined || !sameTarget(finalTarget, record.target)) {
					this.failClosed(record.leaseState, ROOT_UNAVAILABLE);
				} else {
					this.postValidatedSet(
						record.leaseState,
						target,
						record.sequence,
						record.activity,
					);
				}
			}
		}
		if (target !== undefined) {
			this.pruneTarget(record.leaseState, target);
		}
		this.pumpValidations();
	}

	/** Path-free settlement entry used by module lifetime handles. */
	settlePost(handle: PostHandle, posted: boolean): void {
		releaseGlobalPost(handle.bytes, false);
		const record = this.postRecords.get(handle.key);
		if (record === undefined) {
			return;
		}
		record.settled = true;
		this.releaseLocalPost(record.local);
		if (record.kind === 'set') {
			record.occupancy.pendingSetPosts -= 1;
			if (posted) {
				record.occupancy.hasPostedSet = true;
			}
			const target = record.leaseState.targets.get(record.targetKey);
			if (
				target !== undefined
				&& target.occupancy === record.occupancy
			) {
					this.settleDeferredClearReceipts(
						record.leaseState,
						target,
					record.key,
					posted,
				);
				this.maybeReleaseUnbackedOccupancy(record.leaseState, target);
			}
			if (target !== undefined) {
				this.pruneTarget(record.leaseState, target);
			}
		} else if (record.kind === 'targetClear') {
			const target = record.leaseState.targets.get(record.targetKey);
			if (!posted) {
				this.cancelReceipt(record.receiptId);
			} else if (target !== undefined) {
				this.discardTargetReceiptsOlderThan(target, record.sequence);
			}
			if (target !== undefined) {
				this.pruneTarget(record.leaseState, target);
			}
		} else if (!posted && record.receiptId !== undefined) {
			this.cancelReceipt(record.receiptId);
		}
		this.maybeDeletePost(record);
	}

	private isExactLiveRequest(request: HostAgentActivityRequest): boolean {
		const { lease, sourceRuntime, event } = request;
		return !lease.revoked
			&& sourceRuntime === lease.runtime
			&& sourceRuntime.lifecycle === 'running'
			&& sourceRuntime.sessionId === lease.session.sessionId
			&& sourceRuntime.sessionId === event.sessionId
			&& sourceRuntime.generation === lease.generation
			&& sourceRuntime.generation === event.generation
			&& lease.providerId === lease.assignment.providerId
			&& lease.workspaceRootId === lease.assignment.workspaceRootId;
	}

	private getOrCreateLeaseState(lease: ActivityLease): LeaseState | undefined {
		const existing = this.leaseStates.get(lease);
		if (existing !== undefined) {
			return existing;
		}
		const sessionId = lease.session.sessionId;
		const current = this.currentLeaseBySession.get(sessionId);
		if (current !== undefined && current !== lease) {
			return undefined;
		}
		const highestEpoch = this.highestEpochBySession.get(lease.session);
		if (highestEpoch !== undefined && lease.epoch <= highestEpoch) {
			return undefined;
		}
		const state: LeaseState = {
			lease,
			sessionId,
			targets: new Map(),
			nextSequence: this.initialSequence,
			hostEvents: 0,
			hostBytes: 0,
			postEvents: 0,
			postBytes: 0,
			activeTargets: 0,
			closed: false,
			invalidating: false,
		};
		this.leaseStates.set(lease, state);
		this.currentLeaseBySession.set(sessionId, lease);
		this.highestEpochBySession.set(lease.session, lease.epoch);
		return state;
	}

	private reserveHost(
		leaseState: LeaseState,
		bytes: number,
	): HostReservation | undefined {
		if (
			leaseState.hostEvents + 1 > HOST_PENDING_PER_SESSION_EVENTS
			|| leaseState.hostBytes + bytes > HOST_PENDING_PER_SESSION_BYTES
			|| this.hostEvents + 1 > HOST_PENDING_PER_PANEL_EVENTS
			|| this.hostBytes + bytes > HOST_PENDING_PER_PANEL_BYTES
			|| extensionRegistry.hostPendingEvents + 1
				> HOST_PENDING_PER_EXTENSION_EVENTS
			|| extensionRegistry.hostPendingBytes + bytes
				> HOST_PENDING_PER_EXTENSION_BYTES
		) {
			return undefined;
		}
		leaseState.hostEvents += 1;
		leaseState.hostBytes += bytes;
		this.hostEvents += 1;
		this.hostBytes += bytes;
		extensionRegistry.hostPendingEvents += 1;
		extensionRegistry.hostPendingBytes += bytes;
		return { bytes, leaseState, localHeld: true, globalHeld: true };
	}

	private releaseHost(reservation: HostReservation, releaseGlobal: boolean): void {
		if (reservation.localHeld) {
			reservation.localHeld = false;
			reservation.leaseState.hostEvents -= 1;
			reservation.leaseState.hostBytes -= reservation.bytes;
			this.hostEvents -= 1;
			this.hostBytes -= reservation.bytes;
		}
		if (releaseGlobal && reservation.globalHeld) {
			reservation.globalHeld = false;
			releaseGlobalHost(reservation.bytes);
		}
	}

	private issueSequence(state: LeaseState): number | undefined {
		const issued = state.nextSequence;
		if (issued === undefined) {
			return undefined;
		}
		state.nextSequence = issued === Number.MAX_SAFE_INTEGER
			? undefined
			: issued + 1;
		return issued;
	}

	private peekReceiptId(): number | undefined {
		return this.nextReceiptId;
	}

	/** Receipt IDs are committed only after every post quota reservation succeeds. */
	private commitReceiptId(receiptId: number): void {
		if (this.nextReceiptId !== receiptId) {
			throw new Error('Agent Activity receipt admission is inconsistent.');
		}
		this.nextReceiptId = receiptId === Number.MAX_SAFE_INTEGER
			? undefined
			: receiptId + 1;
	}

	private resolveFreshWorkspace(lease: ActivityLease): FreshWorkspaceResult {
		let result: ReturnType<WorkspaceResolver>;
		try {
			result = this.resolveWorkspace(lease.workspaceRootId);
		} catch {
			return { ok: false, failure: ROOT_UNAVAILABLE };
		}
		if (!result.ok) {
			return { ok: false, failure: result };
		}
		return matchesAgentActivityLeaseWorkspaceRoot(lease, result.root)
			? { ok: true, root: result.root }
			: { ok: false, failure: ROOT_UNAVAILABLE };
	}

	private failClosed(
		state: LeaseState,
		failure: WorkspaceValidationFailure,
	): void {
		if (state.closed || state.invalidating) {
			return;
		}
		state.invalidating = true;
		try {
			this.invalidateLease(state.lease, failure);
		} catch {
			/* Cleanup remains fail-closed even if the Host invalidation observer faults. */
		} finally {
			this.revokeLease(state.lease);
		}
	}

	private enqueueSetValidation(
		leaseState: LeaseState,
		sequence: number,
		activity: Parameters<typeof setAgentActivity>[2],
		targetRequest: AgentActivityTargetRequest,
		target: Readonly<GraphNodeEffectTarget>,
		reservation: HostReservation,
	): void {
		const key = targetKey(target);
		const state = this.prepareTargetOperation(
			leaseState,
			key,
			target,
			sequence,
			'set',
		);
		state.pendingValidations += 1;
		const workKey = {};
		const record: ValidationRecord = {
			key: workKey,
			leaseState,
			targetKey: key,
			sequence,
			activity,
			targetRequest,
			target,
			reservation,
			status: 'queued',
		};
		this.validationRecords.set(workKey, record);
		this.validationQueue.push(workKey);
		this.pumpValidations();
	}

	private processClear(
		leaseState: LeaseState,
		sequence: number,
		targetRequest: AgentActivityTargetRequest,
		target: Readonly<GraphNodeEffectTarget>,
	): void {
		const key = targetKey(target);
		const state = this.prepareTargetOperation(
			leaseState,
			key,
			target,
			sequence,
			'clear',
		);
		const occupancy = state.occupancy;
		if (occupancy === undefined) {
			this.pruneTarget(leaseState, state);
			return;
		}
		/** The already-admitted clear remains the exact latest clear for this slot. */
		if (state.clearReceiptId !== undefined) {
			return;
		}
		const workspace = this.resolveFreshWorkspace(leaseState.lease);
		if (!workspace.ok) {
			this.failClosed(leaseState, workspace.failure);
			return;
		}
		const finalTarget = createClearAgentActivityTarget(
			leaseState.lease,
			workspace.root,
			targetRequest,
		);
		if (finalTarget === undefined || !sameTarget(finalTarget, target)) {
			this.failClosed(leaseState, ROOT_UNAVAILABLE);
			return;
		}
		const receiptId = this.peekReceiptId();
		if (receiptId === undefined) {
			this.failClosed(leaseState, ROOT_UNAVAILABLE);
			return;
		}
		const publicMessage = clearAgentActivity(leaseState.sessionId, target);
		const message: AgentActivityTrackedClearMessage = Object.freeze({
			type: 'agent.activity.clearTracked',
			receiptId,
			publicMessage,
		});
		const record = this.prepareRegularPost(
			leaseState,
			message,
			(workKey, local, handle): TargetClearPostRecord => ({
				kind: 'targetClear',
				key: workKey,
				leaseState,
				targetKey: key,
				sequence,
				receiptId,
				local,
				handle,
				settled: false,
			}),
		);
		if (record === undefined) {
			this.maybeReleaseUnbackedOccupancy(leaseState, state);
			this.pruneTarget(leaseState, state);
			return;
		}
		this.commitReceiptId(receiptId);
		state.clearReceiptId = receiptId;
		this.receiptRecords.set(receiptId, {
			kind: 'target',
			postKey: record.key,
			leaseState,
			targetKey: key,
			sequence,
			occupancy,
		});
		this.invokePost(record, message);
	}

	private prepareTargetOperation(
		leaseState: LeaseState,
		key: string,
		target: Readonly<GraphNodeEffectTarget>,
		sequence: number,
		operation: 'set' | 'clear',
	): TargetState {
		let state = leaseState.targets.get(key);
		if (state === undefined) {
			state = {
				key,
				target,
				sequence,
				operation,
				pendingValidations: 0,
			};
			leaseState.targets.set(key, state);
		} else {
			state.sequence = sequence;
			state.operation = operation;
		}
		this.removeQueuedValidations(leaseState, key);
		return state;
	}

	private removeQueuedValidations(
		leaseState: LeaseState,
		targetKeyToRemove?: string,
		deferredReleases?: DeferredHostRelease[],
	): void {
		const retained: object[] = [];
		for (const workKey of this.validationQueue) {
			const record = this.validationRecords.get(workKey);
			if (
				record === undefined
				|| record.status !== 'queued'
				|| record.leaseState !== leaseState
				|| (
					targetKeyToRemove !== undefined
					&& record.targetKey !== targetKeyToRemove
				)
			) {
				retained.push(workKey);
				continue;
			}
			this.validationRecords.delete(workKey);
			const target = leaseState.targets.get(record.targetKey);
			if (target !== undefined) {
				target.pendingValidations -= 1;
			}
			if (deferredReleases === undefined) {
				this.releaseHost(record.reservation, true);
			} else {
				deferredReleases.push({
					reservation: record.reservation,
					releaseGlobal: true,
				});
			}
		}
		this.validationQueue = retained;
	}

	private pumpValidations(): void {
		if (this.disposed || this.pumping) {
			return;
		}
		this.pumping = true;
		try {
			while (
				this.validationsInFlight < VALIDATIONS_IN_FLIGHT_PER_PANEL
				&& extensionRegistry.validationsInFlight
					< VALIDATIONS_IN_FLIGHT_PER_EXTENSION
			) {
				const workKey = this.validationQueue.shift();
				if (workKey === undefined) {
					break;
				}
				const record = this.validationRecords.get(workKey);
				if (record === undefined || record.status !== 'queued') {
					continue;
				}
				record.status = 'running';
				this.validationsInFlight += 1;
				extensionRegistry.validationsInFlight += 1;
				const handle: ValidationHandle = {
					key: workKey,
					hostBytes: record.reservation.bytes,
					owner: this,
					settled: false,
					detached: false,
				};
				record.handle = handle;
				const workspace = this.resolveFreshWorkspace(record.leaseState.lease);
				if (!workspace.ok) {
					this.failClosed(record.leaseState, workspace.failure);
					settleValidationHandle(handle, undefined);
					continue;
				}
				const startTarget = createAgentActivityGraphTarget(
					record.leaseState.lease,
					workspace.root,
					record.targetRequest,
				);
				if (startTarget === undefined || !sameTarget(startTarget, record.target)) {
					this.failClosed(record.leaseState, ROOT_UNAVAILABLE);
					settleValidationHandle(handle, undefined);
					continue;
				}
				let result:
					| ReturnType<AgentActivitySetTargetValidator>
					| undefined;
				try {
					result = this.validateSetTarget(
						record.leaseState.lease,
						workspace.root,
						record.targetRequest,
					);
				} catch {
					settleValidationHandle(handle, undefined);
					continue;
				}
				Promise.resolve(result).then(
					(value) => settleValidationHandle(handle, value),
					() => settleValidationHandle(handle, undefined),
				);
			}
		} finally {
			this.pumping = false;
		}
	}

	private orphanRunningValidations(
		leaseState: LeaseState,
		deferredReleases?: DeferredHostRelease[],
	): number {
		let orphanedSlots = 0;
		for (const record of [...this.validationRecords.values()]) {
			if (record.leaseState !== leaseState || record.status !== 'running') {
				continue;
			}
			this.validationRecords.delete(record.key);
			if (deferredReleases === undefined) {
				this.releaseHost(record.reservation, false);
				this.validationsInFlight -= 1;
			} else {
				deferredReleases.push({
					reservation: record.reservation,
					releaseGlobal: false,
				});
				orphanedSlots += 1;
			}
			const handle = record.handle;
			if (handle !== undefined && !handle.settled) {
				handle.owner = undefined;
				handle.detached = true;
				extensionRegistry.detachedValidations += 1;
				extensionRegistry.detachedValidationBytes += handle.hostBytes;
			}
		}
		return orphanedSlots;
	}

	private isValidationSuccess(
		result: boolean | ValidatedAgentActivityTarget | undefined,
		target: Readonly<GraphNodeEffectTarget>,
	): boolean {
		return result === true
			|| (
				typeof result === 'object'
				&& result !== null
				&& sameTarget(result.target, target)
			);
	}

	private postValidatedSet(
		leaseState: LeaseState,
		target: TargetState,
		sequence: number,
		activity: Parameters<typeof setAgentActivity>[2],
	): void {
		const existingOccupancy = target.occupancy;
		if (existingOccupancy === undefined && !this.canReserveOccupiedTarget(leaseState)) {
			return;
		}
		const occupancy: TargetOccupancy = existingOccupancy ?? {
			pendingSetPosts: 0,
			hasPostedSet: false,
			counted: false,
		};
		const message = setAgentActivity(
			leaseState.sessionId,
			target.target,
			activity,
		);
		const record = this.prepareRegularPost(
			leaseState,
			message,
			(workKey, local, handle): SetPostRecord => ({
				kind: 'set',
				key: workKey,
				leaseState,
				targetKey: target.key,
				sequence,
				occupancy,
				local,
				handle,
				settled: false,
			}),
		);
		if (record === undefined) {
			return;
		}
		this.deferClearReceiptsForSet(target, record.key);
		if (existingOccupancy === undefined) {
			this.reserveOccupiedTarget(leaseState, target, occupancy);
		}
		occupancy.pendingSetPosts += 1;
		this.invokePost(record, message);
	}

	private prepareRegularPost<RecordType extends PostRecord>(
		leaseState: LeaseState,
		message: ExtensionToWebviewMessage,
		createRecord: (
			key: object,
			local: LocalPostReservation,
			handle: PostHandle,
		) => RecordType,
	): RecordType | undefined {
		let bytes: number;
		try {
			bytes = wireUtf8Bytes(message);
		} catch {
			return undefined;
		}
		if (!this.canReserveRegularPost(leaseState, bytes)) {
			return undefined;
		}
		this.reserveRegularPost(leaseState, bytes);
		const local: LocalPostReservation = {
			kind: 'regular',
			bytes,
			leaseState,
			held: true,
		};
		const key = {};
		const handle: PostHandle = {
			key,
			bytes,
			owner: this,
			settled: false,
			detached: false,
		};
		const record = createRecord(key, local, handle);
		this.postRecords.set(key, record);
		return record;
	}

	private postCleanupClear(quota: RetiredSessionQuota): void {
		if (this.disposed) {
			return;
		}
		const publicMessage = clearAgentActivitiesBySession(quota.sessionId);
		const receiptId = quota.count === 0 ? undefined : this.peekReceiptId();
		if (quota.count === 0) {
			this.releaseRetiredQuota(quota);
		}
		const message: ExtensionToWebviewMessage = receiptId === undefined
			? publicMessage
			: Object.freeze({
				type: 'agent.activity.clearTracked',
				receiptId,
				publicMessage,
			});
		let bytes: number;
		try {
			bytes = wireUtf8Bytes(message);
		} catch {
			return;
		}
		if (!this.canReserveCleanupPost(bytes)) {
			return;
		}
		this.cleanupPostEvents += 1;
		this.cleanupPostBytes += bytes;
		extensionRegistry.postWorkPendingEvents += 1;
		extensionRegistry.postWorkPendingBytes += bytes;
		if (receiptId !== undefined) {
			this.commitReceiptId(receiptId);
		}
		const key = {};
		const local: LocalPostReservation = {
			kind: 'cleanup',
			bytes,
			held: true,
		};
		const handle: PostHandle = {
			key,
			bytes,
			owner: this,
			settled: false,
			detached: false,
		};
		const record: CleanupPostRecord = {
			kind: 'cleanup',
			key,
			quota,
			receiptId,
			local,
			handle,
			settled: false,
		};
		this.postRecords.set(key, record);
		if (receiptId !== undefined) {
			this.receiptRecords.set(receiptId, {
				kind: 'cleanup',
				postKey: key,
				quota,
			});
		}
		this.invokePost(record, message);
	}

	private invokePost(record: PostRecord, message: ExtensionToWebviewMessage): void {
		const handle = record.handle;
		let result: Thenable<boolean>;
		try {
			result = this.postMessage(message);
		} catch {
			settlePostHandle(handle, false);
			return;
		}
		Promise.resolve(result).then(
			(posted) => settlePostHandle(handle, posted === true),
			() => settlePostHandle(handle, false),
		);
	}

	private canReserveRegularPost(leaseState: LeaseState, bytes: number): boolean {
		return leaseState.postEvents + 1 <= POST_PENDING_PER_SESSION_EVENTS
			&& leaseState.postBytes + bytes <= POST_PENDING_PER_SESSION_BYTES
			&& this.postEvents + 1 <= POST_PENDING_PER_PANEL_EVENTS
			&& this.postBytes + bytes <= POST_PENDING_PER_PANEL_BYTES
			&& extensionRegistry.postWorkPendingEvents + 1
				<= POST_WORK_PENDING_PER_EXTENSION_EVENTS
			&& extensionRegistry.postWorkPendingBytes + bytes
				<= POST_WORK_PENDING_PER_EXTENSION_BYTES;
	}

	private reserveRegularPost(leaseState: LeaseState, bytes: number): void {
		leaseState.postEvents += 1;
		leaseState.postBytes += bytes;
		this.postEvents += 1;
		this.postBytes += bytes;
		extensionRegistry.postWorkPendingEvents += 1;
		extensionRegistry.postWorkPendingBytes += bytes;
	}

	private canReserveCleanupPost(bytes: number): boolean {
		return this.cleanupPostEvents + 1
			<= CLEANUP_POST_PENDING_PER_PANEL_EVENTS
			&& this.cleanupPostBytes + bytes
				<= CLEANUP_POST_PENDING_PER_PANEL_BYTES
			&& extensionRegistry.postWorkPendingEvents + 1
				<= POST_WORK_PENDING_PER_EXTENSION_EVENTS
			&& extensionRegistry.postWorkPendingBytes + bytes
				<= POST_WORK_PENDING_PER_EXTENSION_BYTES;
	}

	private releaseLocalPost(local: LocalPostReservation): void {
		if (!local.held) {
			return;
		}
		local.held = false;
		if (local.kind === 'regular') {
			const state = local.leaseState;
			if (state !== undefined) {
				state.postEvents -= 1;
				state.postBytes -= local.bytes;
			}
			this.postEvents -= 1;
			this.postBytes -= local.bytes;
		} else {
			this.cleanupPostEvents -= 1;
			this.cleanupPostBytes -= local.bytes;
		}
	}

	private deferClearReceiptsForSet(target: TargetState, postKey: object): void {
		const activeReceiptId = target.clearReceiptId;
		if (activeReceiptId !== undefined) {
			const receipt = this.receiptRecords.get(activeReceiptId);
			target.clearReceiptId = undefined;
			if (
				receipt?.kind === 'target'
				&& receipt.targetKey === target.key
				&& receipt.occupancy === target.occupancy
			) {
				const deferred: DeferredTargetClearReceipt = {
					receiptId: activeReceiptId,
					record: receipt,
					pendingSetPostKeys: new Set(),
					receiptApplied: false,
				};
				(target.deferredClearReceipts ??= []).push(deferred);
			}
		}
		for (const deferred of target.deferredClearReceipts ?? []) {
			deferred.pendingSetPostKeys.add(postKey);
		}
	}

	private settleDeferredClearReceipts(
		leaseState: LeaseState,
		target: TargetState,
		postKey: object,
		posted: boolean,
	): void {
		for (const deferred of [...(target.deferredClearReceipts ?? [])]) {
			if (!deferred.pendingSetPostKeys.delete(postKey)) {
				continue;
			}
			if (posted) {
				this.removeDeferredClearReceipt(target, deferred);
				continue;
			}
			if (deferred.pendingSetPostKeys.size !== 0 || !deferred.receiptApplied) {
				continue;
			}
			if (target.occupancy === deferred.record.occupancy) {
				this.discardAllTargetReceipts(target);
				this.releaseOccupiedTarget(
					leaseState,
					target,
					deferred.record.occupancy,
				);
				return;
			}
			this.removeDeferredClearReceipt(target, deferred);
		}
		this.promoteReadyDeferredClearReceipt(target);
	}

	private removeDeferredClearReceipt(
		target: TargetState,
		deferred: DeferredTargetClearReceipt,
	): void {
		const receipts = target.deferredClearReceipts;
		if (receipts === undefined) {
			return;
		}
		const index = receipts.indexOf(deferred);
		if (index === -1) {
			return;
		}
		receipts.splice(index, 1);
		if (receipts.length === 0) {
			target.deferredClearReceipts = undefined;
		}
		if (this.receiptRecords.get(deferred.receiptId) === deferred.record) {
			this.receiptRecords.delete(deferred.receiptId);
		}
	}

	private promoteReadyDeferredClearReceipt(target: TargetState): void {
		if (target.clearReceiptId !== undefined) {
			return;
		}
		const receipts = target.deferredClearReceipts;
		if (receipts === undefined) {
			return;
		}
		for (let index = receipts.length - 1; index >= 0; index -= 1) {
			const deferred = receipts[index] as DeferredTargetClearReceipt;
			if (
				deferred.pendingSetPostKeys.size !== 0
				|| deferred.receiptApplied
			) {
				continue;
			}
			if (this.receiptRecords.get(deferred.receiptId) !== deferred.record) {
				receipts.splice(index, 1);
				continue;
			}
			receipts.splice(index, 1);
			target.clearReceiptId = deferred.receiptId;
			break;
		}
		if (receipts.length === 0) {
			target.deferredClearReceipts = undefined;
		}
	}

	private discardTargetReceiptsOlderThan(
		target: TargetState,
		sequence: number,
	): void {
		const activeReceiptId = target.clearReceiptId;
		if (activeReceiptId !== undefined) {
			const active = this.receiptRecords.get(activeReceiptId);
			if (
				active?.kind === 'target'
				&& active.sequence < sequence
			) {
				this.receiptRecords.delete(activeReceiptId);
				target.clearReceiptId = undefined;
			}
		}
		for (const deferred of [...(target.deferredClearReceipts ?? [])]) {
			if (deferred.record.sequence < sequence) {
				this.removeDeferredClearReceipt(target, deferred);
			}
		}
		this.promoteReadyDeferredClearReceipt(target);
	}

	private discardAllTargetReceipts(target: TargetState): void {
		if (target.clearReceiptId !== undefined) {
			this.receiptRecords.delete(target.clearReceiptId);
			target.clearReceiptId = undefined;
		}
		for (const deferred of target.deferredClearReceipts ?? []) {
			if (this.receiptRecords.get(deferred.receiptId) === deferred.record) {
				this.receiptRecords.delete(deferred.receiptId);
			}
		}
		target.deferredClearReceipts = undefined;
	}

	private cancelReceipt(receiptId: number): void {
		const receipt = this.receiptRecords.get(receiptId);
		if (receipt === undefined) {
			return;
		}
		this.receiptRecords.delete(receiptId);
		if (receipt.kind === 'target') {
			const target = receipt.leaseState.targets.get(receipt.targetKey);
			if (target?.clearReceiptId === receiptId) {
				target.clearReceiptId = undefined;
			} else if (target !== undefined) {
				const deferred = target.deferredClearReceipts?.find(
					(candidate) => candidate.receiptId === receiptId
						&& candidate.record === receipt,
				);
				if (deferred !== undefined) {
					this.removeDeferredClearReceipt(target, deferred);
				}
			}
			if (target !== undefined) {
				this.promoteReadyDeferredClearReceipt(target);
				this.maybeReleaseUnbackedOccupancy(receipt.leaseState, target);
			}
		}
	}

	private subsumeTargetReceipts(leaseState: LeaseState): void {
		for (const [receiptId, receipt] of this.receiptRecords) {
			if (receipt.kind === 'target' && receipt.leaseState === leaseState) {
				this.receiptRecords.delete(receiptId);
			}
		}
	}

	private maybeDeletePost(record: PostRecord): void {
		if (record.settled && !record.local.held) {
			this.postRecords.delete(record.key);
		}
	}

	private orphanPost(
		record: PostRecord,
		deferredReleases?: LocalPostReservation[],
	): void {
		if (record.kind !== 'set' && record.receiptId !== undefined) {
			this.receiptRecords.delete(record.receiptId);
		}
		if (deferredReleases === undefined) {
			this.releaseLocalPost(record.local);
		} else {
			deferredReleases.push(record.local);
		}
		this.postRecords.delete(record.key);
		if (!record.handle.settled) {
			record.handle.owner = undefined;
			record.handle.detached = true;
			extensionRegistry.detachedPosts += 1;
			extensionRegistry.detachedPostBytes += record.handle.bytes;
		}
	}

	private canReserveOccupiedTarget(leaseState: LeaseState): boolean {
		const retiredCount = this.retiredCountBySession.get(leaseState.sessionId) ?? 0;
		return leaseState.activeTargets + retiredCount + 1
			<= ACTIVE_TARGETS_PER_SESSION
			&& this.activeTargets + 1 <= ACTIVE_TARGETS_PER_PANEL;
	}

	private reserveOccupiedTarget(
		leaseState: LeaseState,
		target: TargetState,
		occupancy: TargetOccupancy,
	): void {
		target.occupancy = occupancy;
		occupancy.counted = true;
		leaseState.activeTargets += 1;
		this.activeTargets += 1;
	}

	private releaseOccupiedTarget(
		leaseState: LeaseState,
		target: TargetState,
		occupancy: TargetOccupancy,
	): void {
		if (target.occupancy !== occupancy || !occupancy.counted) {
			return;
		}
		target.occupancy = undefined;
		occupancy.counted = false;
		leaseState.activeTargets -= 1;
		this.activeTargets -= 1;
	}

	private maybeReleaseUnbackedOccupancy(
		leaseState: LeaseState,
		target: TargetState,
	): void {
		const occupancy = target.occupancy;
		if (
			occupancy !== undefined
				&& occupancy.pendingSetPosts === 0
				&& !occupancy.hasPostedSet
				&& target.clearReceiptId === undefined
				&& (target.deferredClearReceipts?.length ?? 0) === 0
			) {
			this.releaseOccupiedTarget(leaseState, target, occupancy);
		}
	}

	private pruneTarget(leaseState: LeaseState, target: TargetState): void {
		if (target.occupancy === undefined && target.pendingValidations === 0) {
			leaseState.targets.delete(target.key);
		}
	}

	private releaseRetiredQuota(quota: RetiredSessionQuota): void {
		if (quota.released) {
			return;
		}
		quota.released = true;
		this.activeTargets -= quota.count;
		this.retiredQuotas.delete(quota);
		if (quota.count !== 0) {
			const remaining = (this.retiredCountBySession.get(quota.sessionId) ?? 0)
				- quota.count;
			if (remaining <= 0) {
				this.retiredCountBySession.delete(quota.sessionId);
			} else {
				this.retiredCountBySession.set(quota.sessionId, remaining);
			}
		}
	}
}

function normalizeInitialCounter(value: number | undefined): number {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0
		? value
		: 0;
}

export function createAgentActivityGraphBridge(
	options: AgentActivityGraphBridgeOptions,
): AgentActivityGraphBridge {
	return new AgentActivityGraphBridge(options);
}
