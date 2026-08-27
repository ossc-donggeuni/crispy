import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

suite('Production UI language', () => {
	test('production string literals contain no Korean UI text', () => {
		const sourceRoot = path.resolve(__dirname, '../../src');
		const violations: string[] = [];

		for (const filePath of collectProductionTypeScriptFiles(sourceRoot)) {
			const sourceText = fs.readFileSync(filePath, 'utf8');
			const sourceFile = ts.createSourceFile(
				filePath,
				sourceText,
				ts.ScriptTarget.Latest,
				true,
			);

			const visit = (node: ts.Node): void => {
				if (isStringLiteralPart(node) && /[가-힣]/u.test(node.text)) {
					const location = sourceFile.getLineAndCharacterOfPosition(
						node.getStart(sourceFile),
					);
					violations.push(
						`${path.relative(sourceRoot, filePath)}:${location.line + 1}`,
					);
				}
				ts.forEachChild(node, visit);
			};

			visit(sourceFile);
		}

		assert.deepStrictEqual(violations, []);
	});
});

function collectProductionTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];

	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === 'test') {
			continue;
		}

		const entryPath = path.join(directory, entry.name);

		if (entry.isDirectory()) {
			files.push(...collectProductionTypeScriptFiles(entryPath));
		} else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
			files.push(entryPath);
		}
	}

	return files.sort((left, right) => left.localeCompare(right));
}

function isStringLiteralPart(node: ts.Node): node is ts.StringLiteralLike {
	return ts.isStringLiteralLike(node)
		|| node.kind === ts.SyntaxKind.TemplateHead
		|| node.kind === ts.SyntaxKind.TemplateMiddle
		|| node.kind === ts.SyntaxKind.TemplateTail;
}
