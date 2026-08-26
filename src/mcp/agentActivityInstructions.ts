import {
	AGENT_ACTIVITY_KINDS,
	AGENT_ACTIVITY_TARGET_KINDS,
} from './agentActivityProtocol';
import {
	CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_PING_TOOL_NAME,
	CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
} from './toolServer';

export const CRISPY_PING_ONLY_INSTRUCTIONS = [
	`The Crispy MCP server exposes only ${CRISPY_PING_TOOL_NAME} for this Host.`,
	`Use ${CRISPY_PING_TOOL_NAME} only when a reachability check is useful.`,
	'The legacy mode value in its result applies only to that ping compatibility response and does not characterize the whole MCP server.',
].join(' ');

export const CRISPY_AGENT_ACTIVITY_INSTRUCTIONS = [
	`Use ${CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME} when work starts on a target or changes state.`,
	`Use ${CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME} when that work ends.`,
	'path must be relative to the assigned workspace root; use "." with targetKind "folder" for the root itself.',
	`targetKind must be one of: ${AGENT_ACTIVITY_TARGET_KINDS.join(', ')}.`,
	`activity must be one of: ${AGENT_ACTIVITY_KINDS.join(', ')}.`,
	'Do not infer activity from terminal output or filesystem changes; report only explicit work.',
	'A successful Tool result means only that the request was accepted, not that it was delivered to the Host, displayed in the UI, applied by the Store, or acknowledged by a receipt.',
	'Do not provide or attempt to select a root, session, URI, token, runtime, or internal identity.',
	'The legacy mode value returned by crispy_ping applies only to that ping compatibility response and does not characterize the whole MCP server.',
].join(' ');

/** Claude additive prompt instructions are selected only from the Host-owned capability. */
export function createCrispyMcpInstructions(
	agentActivityCompatible: boolean,
): string {
	return agentActivityCompatible
		? CRISPY_AGENT_ACTIVITY_INSTRUCTIONS
		: CRISPY_PING_ONLY_INSTRUCTIONS;
}
