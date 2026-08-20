import * as assert from 'assert';
import {
	hasMatchingSuccessResult,
	responseProvesMcpActivity,
} from '../../mcp/activity';

const request = {
	jsonrpc: '2.0' as const,
	id: 7,
	method: 'tools/list',
	params: {},
};

suite('MCP activity 판정', () => {
	test('같은 ID의 JSON-RPC success result만 activity로 판정한다', () => {
		assert.strictEqual(hasMatchingSuccessResult(request, [{
			jsonrpc: '2.0',
			id: 7,
			result: { tools: [] },
		}]), true);
		assert.strictEqual(hasMatchingSuccessResult(request, [{
			jsonrpc: '2.0',
			id: 8,
			result: { tools: [] },
		}]), false);
	});

	test('notification과 JSON-RPC error만으로는 activity가 아니다', () => {
		assert.strictEqual(hasMatchingSuccessResult({
			jsonrpc: '2.0',
			method: 'notifications/initialized',
		}, [{
			jsonrpc: '2.0',
			id: 7,
			result: {},
		}]), false);
		assert.strictEqual(hasMatchingSuccessResult(request, [{
			jsonrpc: '2.0',
			id: 7,
			error: { code: -32601, message: 'Method not found' },
		}]), false);
	});

	test('batch는 qualifying sibling result가 있을 때만 activity다', () => {
		const batch = [
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			request,
			{ jsonrpc: '2.0', id: 'other', method: 'unknown' },
		];
		assert.strictEqual(hasMatchingSuccessResult(batch, [[
			{
				jsonrpc: '2.0',
				id: 'other',
				error: { code: -32601, message: 'Method not found' },
			},
			{ jsonrpc: '2.0', id: 7, result: { tools: [] } },
		]]), true);
		assert.strictEqual(hasMatchingSuccessResult(batch, [[{
			jsonrpc: '2.0',
			id: 'other',
			error: { code: -32601, message: 'Method not found' },
		}]]), false);
	});

	test('tool-level isError가 정상 result 안에 있으면 왕복 성공으로 판정한다', () => {
		assert.strictEqual(hasMatchingSuccessResult({
			jsonrpc: '2.0',
			id: 'call-1',
			method: 'tools/call',
			params: { name: 'crispy_ping', arguments: {} },
		}, [{
			jsonrpc: '2.0',
			id: 'call-1',
			result: { isError: true, content: [{ type: 'text', text: 'failed' }] },
		}]), true);
	});

	test('202 acknowledgement와 JSON-RPC error response를 제외한다', async () => {
		assert.strictEqual(await responseProvesMcpActivity(
			request,
			new Response(null, { status: 202 }),
		), false);
		assert.strictEqual(await responseProvesMcpActivity(
			request,
			Response.json({
				jsonrpc: '2.0',
				id: 7,
				error: { code: -32602, message: 'Invalid params' },
			}),
		), false);
	});

	test('SDK SSE response에서도 data framing 뒤 success result를 확인한다', async () => {
		const response = new Response(
			'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n',
			{ headers: { 'Content-Type': 'text/event-stream' } },
		);
		assert.strictEqual(await responseProvesMcpActivity(request, response), true);
	});
});
