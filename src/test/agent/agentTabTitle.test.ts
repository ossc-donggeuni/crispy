import * as assert from 'assert';
import {
	AGENT_TAB_TITLE_MAX_CANDIDATES,
	AGENT_TAB_TITLE_PREVIEW_CODE_POINTS,
	countUnicodeCodePoints,
	createAgentTabNameKey,
	createAutomaticAgentTabTitleCandidates,
	createDisambiguatedAutomaticAgentTabTitle,
	normalizeManualAgentTabName,
} from '../../agent/UI/agentTabTitle';

suite('Agent Tab Title', () => {
	test('자동 제목은 탭 폭에 맞춘 12 code point 후보 하나만 사용한다', () => {
		assert.strictEqual(AGENT_TAB_TITLE_PREVIEW_CODE_POINTS, 12);
		assert.strictEqual(AGENT_TAB_TITLE_MAX_CANDIDATES, 1);
	});

	test('영문, 한국어와 혼합 입력의 원문 앞부분을 보존한다', () => {
		assert.strictEqual(
			createAutomaticAgentTabTitleCandidates(
				'Fix the authentication timeout in the login flow',
			)?.[0],
			'Fix the aut…',
		);
		assert.strictEqual(
			createAutomaticAgentTabTitleCandidates(
				'터미널 탭 라벨 디자인을 변경해줘',
			)?.[0],
			'터미널 탭 라벨 디자…',
		);
		assert.strictEqual(
			createAutomaticAgentTabTitleCandidates(
				'Why are the MCP tests failing?',
			)?.[0],
			'Why are the…',
		);
		assert.strictEqual(
			createAutomaticAgentTabTitleCandidates(
				'Fix MCP 테스트를 please fix',
			)?.[0],
			'Fix MCP 테스트…',
		);
	});

	test('NFC와 공백을 정규화하고 구두점과 대소문자는 유지한다', () => {
		const decomposed = 'Cafe\u0301 오류, CAFÉ 오류를 고쳐줘';
		const first = createAutomaticAgentTabTitleCandidates(decomposed)?.[0];

		assert.strictEqual(first, 'Café 오류, CA…');
		assert.strictEqual(first, first?.normalize('NFC'));
		assert.strictEqual(createAgentTabNameKey('  CAFÉ   오류 '), 'café 오류');
	});

	test('짧은 첫 프롬프트는 허용하고 제어·선택·숫자·고엔트로피 입력은 제외한다', () => {
		assert.deepStrictEqual(createAutomaticAgentTabTitleCandidates('대'), ['대']);
		assert.deepStrictEqual(createAutomaticAgentTabTitleCandidates('hello'), ['hello']);

		for (const input of [
			'/help explain this', 'EXIT', 'quit', 'y', 'N', 'yes', 'NO', '12345',
			`${'a'.repeat(65)} second`, 'hello\u0000world again', '...!?!',
		]) {
			assert.strictEqual(
				createAutomaticAgentTabTitleCandidates(input),
				undefined,
				input,
			);
		}
	});

	test('자동 제목 후보는 중복 없이 하나만 생성한다', () => {
		const shortCandidates = createAutomaticAgentTabTitleCandidates('alpha beta');
		assert.deepStrictEqual(shortCandidates, ['alpha beta']);

		const manyCandidates = createAutomaticAgentTabTitleCandidates(
			'one two three four five six seven eight nine ten eleven twelve thirteen',
		) ?? [];
		assert.deepStrictEqual(manyCandidates, ['one two thr…']);
	});

	test('12 code point 제한에 `…`를 포함하고 surrogate pair를 분리하지 않는다', () => {
		const candidates = createAutomaticAgentTabTitleCandidates(
			'abcdefghij klmnopqrst uvwxyzabcd efghijklmn extra',
		) ?? [];
		assert.deepStrictEqual(candidates, ['abcdefghij …']);
		assert.strictEqual(countUnicodeCodePoints(candidates[0]), 12);

		const emojiCandidate = createAutomaticAgentTabTitleCandidates(
			`emoji ${'😀'.repeat(20)}`,
		)?.[0];
		assert.strictEqual(countUnicodeCodePoints(emojiCandidate ?? ''), 12);
		assert.ok(emojiCandidate?.endsWith('…'));

		const fortyEmoji = '😀'.repeat(40);
		assert.deepStrictEqual(normalizeManualAgentTabName(fortyEmoji), {
			ok: true,
			value: fortyEmoji,
		});
		assert.deepStrictEqual(normalizeManualAgentTabName(`${fortyEmoji}😀`), {
			ok: false,
			error: 'tooLong',
		});
	});

	test('중복 자동 제목 suffix도 12 code point 안에서 원문 prefix를 보존한다', () => {
		const duplicate = createDisambiguatedAutomaticAgentTabTitle(
			'Workspace 파…',
			2,
		);
		assert.strictEqual(duplicate, 'Workspace…·2');
		assert.strictEqual(countUnicodeCodePoints(duplicate ?? ''), 12);
		assert.strictEqual(
			createDisambiguatedAutomaticAgentTabTitle('클로드 자동 탭명 변…', 3),
			'클로드 자동 탭명…·3',
		);
		assert.strictEqual(
			createDisambiguatedAutomaticAgentTabTitle('invalid', 1),
			undefined,
		);
	});

	test('수동 이름은 control과 공백을 정리하지만 kebab-case를 강제하지 않는다', () => {
		assert.deepStrictEqual(
			normalizeManualAgentTabName('  빌드\n\t 오류   조사  '),
			{ ok: true, value: '빌드 오류 조사' },
		);
		assert.deepStrictEqual(normalizeManualAgentTabName('\n\t'), {
			ok: false,
			error: 'empty',
		});
	});
});
