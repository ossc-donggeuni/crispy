import type { AgentActivityRequested } from './agentActivityProtocol';

export const AGENT_ACTIVITY_SMOKE_ANCHOR = 'src/mcp';
export const AGENT_ACTIVITY_SMOKE_CHILDREN = Object.freeze([
	'src/mcp/toolNames.ts',
	'src/mcp/agentActivityInstructions.ts',
] as const);

export const AGENT_ACTIVITY_LIFECYCLE_SMOKE_PROMPT = [
	'Read src/mcp/toolNames.ts and src/mcp/agentActivityInstructions.ts.',
	'Report what each file controls.',
	'Do not modify files.',
].join(' ');

/**
 * Validates the actual provider smoke against the shared presentation contract.
 * Success requires an outer planned anchor, both meaningful child reads, child
 * cleanup, and a final completed anchor with no later Activity call.
 */
export function isStrictAgentActivitySmokeLifecycle(
	events: readonly AgentActivityRequested[],
): boolean {
	if (events.length < 6) {
		return false;
	}
	const first = events[0];
	const last = events.at(-1)!;
	if (
		first.operation !== 'set'
		|| first.path !== AGENT_ACTIVITY_SMOKE_ANCHOR
		|| first.targetKind !== 'folder'
		|| first.activity !== 'planned'
		|| last.operation !== 'set'
		|| last.path !== AGENT_ACTIVITY_SMOKE_ANCHOR
		|| last.targetKind !== 'folder'
		|| last.activity !== 'completed'
	) {
		return false;
	}

	const allowedPaths = new Set<string>([
		AGENT_ACTIVITY_SMOKE_ANCHOR,
		...AGENT_ACTIVITY_SMOKE_CHILDREN,
	]);
	const current = new Map<string, AgentActivityRequested>();
	const activeChildren = new Set<string>();

	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (!allowedPaths.has(event.path)) {
			return false;
		}
		const isAnchor = event.path === AGENT_ACTIVITY_SMOKE_ANCHOR;
		if (event.targetKind !== (isAnchor ? 'folder' : 'file')) {
			return false;
		}
		if (event.operation === 'clear') {
			if (isAnchor || !current.has(event.path)) {
				return false;
			}
			current.delete(event.path);
			continue;
		}
		if (event.activity === 'completed' && isAnchor && index !== events.length - 1) {
			return false;
		}
		if (!isAnchor && event.activity === 'active') {
			activeChildren.add(event.path);
		}
		current.set(event.path, event);
	}

	return AGENT_ACTIVITY_SMOKE_CHILDREN.every(
		(path) => activeChildren.has(path) && !current.has(path),
	)
		&& current.size === 1
		&& current.get(AGENT_ACTIVITY_SMOKE_ANCHOR) === last;
}
