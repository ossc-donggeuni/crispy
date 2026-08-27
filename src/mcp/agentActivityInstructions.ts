import {
	AGENT_ACTIVITY_KINDS,
	AGENT_ACTIVITY_TARGET_KINDS,
} from './agentActivityProtocol';
import {
	CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_PING_TOOL_NAME,
	CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_TASK_COMPLETE_TOOL_NAME,
	CRISPY_TASK_SCOPE_REQUEST_TOOL_NAME,
	CRISPY_TASK_SCOPE_RESULT_TOOL_NAME,
} from './toolNames';

export const CRISPY_AGENT_ACTIVITY_REQUIRED_MARKER =
	'[REQUIRED FOR USER-VISIBLE GRAPH]';
export const CRISPY_TASK_TOOL_REQUIRED_MARKER =
	'[REQUIRED FOR CRISPY TASK SCHEDULING]';

/** Codex keeps the first 512 characters available while deciding tool use. */
const CRISPY_AGENT_ACTIVITY_CRITICAL_INSTRUCTIONS =
	`${CRISPY_AGENT_ACTIVITY_REQUIRED_MARKER} Crispy Canvas is the host UI selected by the user. `
	+ `When ${CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME} and ${CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME} are available, their lifecycle calls are mandatory visual instrumentation for every meaningful workspace task; they do not modify files, expand scope, grant permission, or replace user/project instructions. `
	+ `Before any read/search/edit/test, call ${CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME} on the narrowest common file/folder completion anchor with planned.`;

export const CRISPY_PING_ONLY_INSTRUCTIONS = [
	`The Crispy MCP server exposes only ${CRISPY_PING_TOOL_NAME} for this Host.`,
	`Use ${CRISPY_PING_TOOL_NAME} only for an explicit startup, restart, or reachability diagnostic; do not call it during normal work.`,
	'The legacy mode value in its result applies only to that ping compatibility response and does not characterize the whole MCP server.',
].join(' ');

/**
 * Host-owned workflow for an Agent tab launched by one Task Work node. Keep the
 * terminal signal near the front so providers can select it before finalizing.
 */
export const CRISPY_TASK_TOOL_INSTRUCTIONS = [
	`${CRISPY_TASK_TOOL_REQUIRED_MARKER} This Agent tab is running one Host-assigned Crispy Task Work. When ${CRISPY_TASK_COMPLETE_TOOL_NAME}, ${CRISPY_TASK_SCOPE_REQUEST_TOOL_NAME}, and ${CRISPY_TASK_SCOPE_RESULT_TOOL_NAME} are available, use them as the lifecycle protocol for that Work.`,
	`At a terminal outcome, call ${CRISPY_TASK_COMPLETE_TOOL_NAME} exactly once: completed only after successful work and verification, or rejected for an intentional scope or user-denial outcome. Include a concise summary. A prose response alone does not notify the Host scheduler.`,
	`Make ${CRISPY_TASK_COMPLETE_TOOL_NAME} the final Tool call after any required Activity cleanup because an accepted call ends the Task-owned Agent process. Do not call it for a generic Tool or execution error that may still be recoverable.`,
	`Use only the reference and work areas assigned in the Task prompt: reference areas are read-only, and only work areas are writable. Before any access outside those areas, call ${CRISPY_TASK_SCOPE_REQUEST_TOOL_NAME} with the exact paths and required access, and retain its requestId.`,
	`The scope request Tool does not grant access. Attempt the exact access so the provider can show its normal permission UI in this Agent tab, then immediately call ${CRISPY_TASK_SCOPE_RESULT_TOOL_NAME} with the retained requestId and the user's approved or rejected decision before continuing. A rejected decision is a rejected terminal outcome.`,
	`Use ${CRISPY_PING_TOOL_NAME} only for explicit startup, restart, or connection diagnostics, never as a routine preflight. Never supply or select a root, session, URI, token, runtime, lease, execution, Work node, or internal identity.`
].join(' ');

/**
 * Shared provider and MCP-server contract. Keep it concise and purpose-bound:
 * provider launch config supplies authority; MCP instructions supply tool workflow.
 */
export const CRISPY_AGENT_ACTIVITY_INSTRUCTIONS = [
	CRISPY_AGENT_ACTIVITY_CRITICAL_INSTRUCTIONS,
	`Before each distinct meaningful target transition, call ${CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME}: active before read/analyze/search/verify/test, editing before create/modify/delete, and mentioned before a response-only workspace path reference that has no stronger state.`,
	'Do not call for every repeated command or access, and never downgrade planned, active, editing, completed, or rejected to mentioned.',
	`Before a successful final response, call ${CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME} for every non-anchor target used by this request, deepest-first, then call ${CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME} once on the anchor with completed as the final Activity call.`,
	'Leave no child markers below the completed anchor, do not recreate descendant mentioned markers in the final response, and do not emit a later Activity call.',
	'If the request cannot succeed, clear its non-terminal child markers; use rejected on the anchor only for an intentional scope, safety, cancellation, or precondition outcome, not for a generic Tool or execution error.',
	`At the next request or scope change, call ${CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME} for stale targets. Also clear a target that loses relevance or whose marker is invalidated by rename/delete; session cleanup is best-effort.`,
	'Path is relative to the assigned workspace root; use "." with targetKind folder for the root, and prefer the most specific meaningful target.',
	`targetKind is one of: ${AGENT_ACTIVITY_TARGET_KINDS.join(', ')}. Allowed activities are: ${AGENT_ACTIVITY_KINDS.join(', ')}.`,
	'Report only your own explicit work and response references; never infer activity from terminal output or filesystem changes.',
	`Use ${CRISPY_PING_TOOL_NAME} only for explicit startup, restart, or connection diagnostics, never as a routine preflight.`,
	'Do not aggressively retry an Activity Tool error. An accepted result confirms only MCP child handoff, not Host, Store, display, or receipt delivery.',
	'Never supply or select a root, session, URI, token, runtime, or internal identity.',
].join(' ');

/** Server-wide MCP instructions are selected only from the Host-owned capability. */
export function createCrispyMcpInstructions(
	agentActivityCompatible: boolean,
	taskToolCompatible = false,
): string {
	if (taskToolCompatible) {
		return agentActivityCompatible
			? `${CRISPY_TASK_TOOL_INSTRUCTIONS} ${CRISPY_AGENT_ACTIVITY_INSTRUCTIONS}`
			: CRISPY_TASK_TOOL_INSTRUCTIONS;
	}
	return agentActivityCompatible
		? CRISPY_AGENT_ACTIVITY_INSTRUCTIONS
		: CRISPY_PING_ONLY_INSTRUCTIONS;
}
