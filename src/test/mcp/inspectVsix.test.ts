import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface InspectVsixModule {
	findExtensionManifestCapabilityProblems(
		manifest: unknown,
	): readonly string[];
	findUnresolvedMcpRuntimeSpecifiers(source: string): readonly string[];
	findUnexpectedVsixPayloadEntries(entryNames: Iterable<string>): readonly string[];
}

const {
	findExtensionManifestCapabilityProblems,
	findUnresolvedMcpRuntimeSpecifiers,
	findUnexpectedVsixPayloadEntries,
} = require(
	'../../../scripts/inspect-vsix',
) as InspectVsixModule;

suite('MCP VSIX bundle dependency inspection', () => {
	test('extension manifest는 limited Workspace capability와 restricted CLI 설정을 선언한다', () => {
		const manifest = JSON.parse(
			readFileSync(join(__dirname, '../../../package.json'), 'utf8'),
		) as {
			readonly capabilities?: {
				readonly untrustedWorkspaces?: unknown;
				readonly virtualWorkspaces?: unknown;
			};
		};

		assert.deepStrictEqual(manifest.capabilities, {
			untrustedWorkspaces: {
				supported: 'limited',
				restrictedConfigurations: [
					'crispy.codexCliPath',
					'crispy.claudeCliPath',
					'crispy.antigravityCliPath',
				],
			},
			virtualWorkspaces: {
				supported: 'limited',
			},
		});
		assert.deepStrictEqual(
			findExtensionManifestCapabilityProblems(manifest),
			[],
		);
	});

	test('VSIX manifest 검사기는 entrypoint, Node와 Workspace capability 누락을 열거한다', () => {
		assert.deepStrictEqual(
			findExtensionManifestCapabilityProblems({
				main: './unexpected.js',
				engines: { node: '22.x' },
				capabilities: {
					untrustedWorkspaces: {
						supported: true,
						restrictedConfigurations: ['crispy.codexCliPath'],
					},
					virtualWorkspaces: { supported: false },
				},
			}),
			[
				'main',
				'engines.node',
				'capabilities.untrustedWorkspaces.supported',
				'capabilities.untrustedWorkspaces.restrictedConfigurations',
				'capabilities.virtualWorkspaces.supported',
			],
		);
	});

	test('실제 import와 require에서 Node builtin만 허용한다', () => {
		const source = [
			'import fs from "node:fs";',
			'import("node:path");',
			'export { EventEmitter } from "events";',
			'const crypto = require("crypto");',
			'const util = __require("node:util");',
			'const stream = module.require("node:stream");',
		].join('\n');

		assert.deepStrictEqual(findUnresolvedMcpRuntimeSpecifiers(source), []);
	});

	test('external require와 존재하지 않는 node: specifier를 거부한다', () => {
		const source = [
			'import externalImport from "external-import";',
			'import("external-dynamic");',
			'const first = require("external-require");',
			'const second = __require("external-esbuild-require");',
			'const third = module.require("external-module-require");',
			'const fakeBuiltin = require("node:not-a-real-builtin");',
		].join('\n');

		assert.deepStrictEqual(findUnresolvedMcpRuntimeSpecifiers(source), [
			'external-dynamic',
			'external-esbuild-require',
			'external-import',
			'external-module-require',
			'external-require',
			'node:not-a-real-builtin',
		]);
	});

	test('문자열과 주석 속 require 문구는 runtime dependency로 오인하지 않는다', () => {
		const source = [
			'const generatedCode = \'require("ajv/dist/runtime/equal")\';',
			'const documentation = `import "example-only"`;',
			'// require("comment-only")',
			'/* import("block-comment-only") */',
		].join('\n');

		assert.deepStrictEqual(findUnresolvedMcpRuntimeSpecifiers(source), []);
	});

	test('설치 metadata와 dist 밖의 개발 파일은 VSIX payload에서 거부한다', () => {
		assert.deepStrictEqual(findUnexpectedVsixPayloadEntries([
			'[Content_Types].xml',
			'extension.vsixmanifest',
			'extension/package.json',
			'extension/LICENSE.md',
			'extension/THIRD_PARTY_NOTICES.md',
			'extension/readme.md',
			'extension/dist/extension.js',
			'extension/dist/mcp-server.mjs',
		]), []);
		assert.deepStrictEqual(findUnexpectedVsixPayloadEntries([
			'notes.txt',
			'extension/IMPLEMENTATION_PROMPT.md',
			'extension/src/extension.ts',
		]), [
			'extension/IMPLEMENTATION_PROMPT.md',
			'extension/src/extension.ts',
			'notes.txt',
		]);
	});
});
