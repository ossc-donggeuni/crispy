import * as assert from 'assert';
import { FileAnalysisStateStore } from '../webview/fileAnalysisState';

suite('File Analysis State', () => {
	test('prevents duplicate requests, caches results, retries failures, and ignores stale results', () => {
		let sequence = 0;
		const store = new FileAnalysisStateStore(
			() => `request-${++sequence}`,
		);
		const fileNodeId = 'file:src/extension.ts';

		const firstRequestId = store.beginOnOpen(fileNodeId);
		assert.strictEqual(firstRequestId, 'request-1');
		assert.deepStrictEqual(store.get(fileNodeId), {
			status: 'loading',
			requestId: 'request-1',
		});
		assert.strictEqual(store.beginOnOpen(fileNodeId), undefined);

		assert.strictEqual(store.applyResult({
			requestId: 'stale-request',
			fileNodeId,
			status: 'ready',
			symbolNodes: [],
			symbolMetadata: [],
		}), false);
		assert.deepStrictEqual(store.get(fileNodeId), {
			status: 'loading',
			requestId: 'request-1',
		});

		assert.strictEqual(store.applyResult({
			requestId: 'request-1',
			fileNodeId,
			status: 'ready',
			symbolNodes: [],
			symbolMetadata: [],
		}), true);
		assert.strictEqual(store.beginOnOpen(fileNodeId), undefined);
		assert.strictEqual(store.retry(fileNodeId), undefined);

		const failedFileNodeId = 'file:src/failing.ts';
		assert.strictEqual(store.beginOnOpen(failedFileNodeId), 'request-2');
		assert.strictEqual(store.applyResult({
			requestId: 'request-2',
			fileNodeId: failedFileNodeId,
			status: 'failed',
			symbolNodes: [],
			symbolMetadata: [],
			errorMessage: 'Provider failed',
		}), true);
		assert.strictEqual(store.beginOnOpen(failedFileNodeId), undefined);
		assert.strictEqual(store.retry(failedFileNodeId), 'request-3');
		assert.strictEqual(store.retry(failedFileNodeId), undefined);
		assert.strictEqual(store.applyResult({
			requestId: 'request-2',
			fileNodeId: failedFileNodeId,
			status: 'ready',
			symbolNodes: [],
			symbolMetadata: [],
		}), false);
		assert.strictEqual(store.applyResult({
			requestId: 'request-3',
			fileNodeId: failedFileNodeId,
			status: 'unsupported',
			symbolNodes: [],
			symbolMetadata: [],
		}), true);
		assert.strictEqual(store.beginOnOpen(failedFileNodeId), undefined);
	});
});
