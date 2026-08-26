import * as assert from 'node:assert/strict';
import {
	AGENT_ACTIVITY_MINIMUM_VSCODE_VERSION,
	isAgentActivityVscodeVersionAllowed,
	parseStableVscodeVersion,
} from '../../mcp/agentActivityCapability';

suite('Agent Activity VS Code production capability', () => {
	test('declared minimum and newer compatible stable Hosts are enabled', () => {
		assert.strictEqual(AGENT_ACTIVITY_MINIMUM_VSCODE_VERSION, '1.125.0');
		assert.deepStrictEqual(parseStableVscodeVersion('1.125.0'), {
			major: 1,
			minor: 125,
			patch: 0,
			version: '1.125.0',
		});

		for (const version of ['1.125.0', '1.125.1', '1.126.0', '1.999.999']) {
			assert.strictEqual(
				isAgentActivityVscodeVersionAllowed(version),
				true,
				version,
			);
		}
	});

	test('too-old and next-major stable Hosts fail closed', () => {
		for (const version of ['0.999.999', '1.124.999', '2.0.0', '2.125.0']) {
			assert.ok(parseStableVscodeVersion(version) !== undefined);
			assert.strictEqual(
				isAgentActivityVscodeVersionAllowed(version),
				false,
				version,
			);
		}
	});

	test('newer canonical prerelease Hosts are enabled without weakening the minimum', () => {
		for (const version of [
			'1.125.1-insider',
			'1.126.0-insider',
			'1.126.0-insider.1',
		]) {
			assert.strictEqual(parseStableVscodeVersion(version), undefined);
			assert.strictEqual(
				isAgentActivityVscodeVersionAllowed(version),
				true,
				version,
			);
		}

		for (const version of ['1.124.999-insider', '1.125.0-insider']) {
			assert.strictEqual(
				isAgentActivityVscodeVersionAllowed(version),
				false,
				version,
			);
		}
	});

	test('malformed and non-canonical versions fail closed', () => {
		for (const version of [
			'',
			'1.125',
			'v1.125.0',
			'1.125.0+build',
			'1.125.0 ',
			'01.125.0',
			'1.0125.0',
			'1.125.00',
			'1.126.0-insider.01',
			'9007199254740992.125.0',
		]) {
			assert.strictEqual(parseStableVscodeVersion(version), undefined);
			assert.strictEqual(
				isAgentActivityVscodeVersionAllowed(version),
				false,
				version,
			);
		}
	});
});
