import {
	McpServer,
	type CallToolResult,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export const CRISPY_MCP_SERVER_NAME = 'crispy';
export const CRISPY_MCP_SERVER_VERSION = '0.0.1';
export const CRISPY_PING_TOOL_NAME = 'crispy_ping';

const CRISPY_PING_INPUT_SCHEMA = z.object({}).strict();

/** 매 stateless request가 독립적으로 사용하는 read-only MCP server instance를 만든다. */
export function createCrispyToolServer(): McpServer {
	const server = new McpServer({
		name: CRISPY_MCP_SERVER_NAME,
		version: CRISPY_MCP_SERVER_VERSION,
	});

	server.registerTool(
		CRISPY_PING_TOOL_NAME,
		{
			description: 'Reports that the Crispy observation-only MCP adapter is reachable.',
			inputSchema: CRISPY_PING_INPUT_SCHEMA,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		(): CallToolResult => ({
			content: [{
				type: 'text',
				text: JSON.stringify({
					ok: true,
					server: CRISPY_MCP_SERVER_NAME,
					mode: 'observation-only',
				}),
			}],
		}),
	);

	return server;
}
