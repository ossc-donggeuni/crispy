import * as assert from 'assert';
import {
	BRACKETED_PASTE_END,
	BRACKETED_PASTE_START,
	createTerminalInputCollector,
	isXtermProtocolResponse,
	TERMINAL_TITLE_BUFFER_MAX_BYTES,
	type TerminalTitleCandidateEvent,
} from '../../agent/webview/terminalInputCollector';

suite('Terminal Input Collector', () => {
	test('xterm 자체 protocol 응답만 사용자 입력과 구분한다', () => {
		const protocolResponses = [
			'\u001b[I',
			'\u001b[O',
			'\u001b[?1;2c',
			'\u001b[>0;276;0c',
			'\u001b[0n',
			'\u001b[12;34R',
			'\u001b[?12;34R',
			'\u001b[?2004;1$y',
			'\u001b[8;24;80t',
			'\u001bP1$r0m\u001b\\',
			'\u001bP0\u001b\\',
			'\u001b]10;rgb:ffff/0000/7f7f\u001b\\',
			'\u001b]4;255;rgb:0000/ffff/7f7f\u001b\\',
		];
		for (const response of protocolResponses) {
			assert.strictEqual(isXtermProtocolResponse(response), true, response);
		}

		const userOrUnknownInput = [
			'\u001b[A',
			'\u001b[3~',
			'\u001bOH',
			'\u001bx',
			BRACKETED_PASTE_START,
			'\u001b[?1;2cprompt',
			'normal prompt',
		];
		for (const input of userOrUnknownInput) {
			assert.strictEqual(isXtermProtocolResponse(input), false, input);
		}
	});

	test('문자 및 여러 조각 입력을 복원하고 원문 없이 제목 후보만 전달한다', () => {
		const events: TerminalTitleCandidateEvent[] = [];
		const collector = createTerminalInputCollector('tab-one', (event) => {
			events.push(event);
		});
		collector.startSession('session-one');

		for (const chunk of ['Fix ', 'the auth', ' timeout', '\r']) {
			collector.handleData('session-one', chunk);
		}

		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual(events[0], {
			tabId: 'tab-one',
			sessionId: 'session-one',
			candidates: events[0].candidates,
		});
		assert.strictEqual(events[0].candidates[0], 'Fix the aut…');
		assert.deepStrictEqual(Object.keys(events[0]).sort(), [
			'candidates', 'sessionId', 'tabId',
		]);
		assert.strictEqual(collector.getState().bufferByteLength, 0);
		assert.strictEqual(collector.getState().attempted, true);
	});

	test('제어/선택 응답은 시도로 세지 않고 다음 안전 후보를 기다린다', () => {
		const events: TerminalTitleCandidateEvent[] = [];
		const collector = createTerminalInputCollector('tab', (event) => events.push(event));
		collector.startSession('session');

		collector.handleData('session', '/help now\r');
		collector.handleData('session', 'yes\r\n');
		collector.handleData('session', 'explain build failure\n');

		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].candidates[0], 'explain bui…');
	});

	test('Backspace, Delete Backspace, Ctrl+U, Ctrl+W와 Ctrl+C를 지원한다', () => {
		const events: TerminalTitleCandidateEvent[] = [];
		const collector = createTerminalInputCollector('tab', (event) => events.push(event));
		collector.startSession('session');

		collector.handleData('session', 'discard me\u0015');
		collector.handleData('session', 'cancel line\u0003');
		collector.handleData('session', 'fix typo😀\bX\u007f auth extra\u0017 timeout\r');

		assert.strictEqual(events[0].candidates[0], 'fix typo au…');
	});

	test('분할 bracketed paste의 내부 줄바꿈을 공백으로 만들고 외부 Enter에서 제출한다', () => {
		const events: TerminalTitleCandidateEvent[] = [];
		const collector = createTerminalInputCollector('tab', (event) => events.push(event));
		collector.startSession('session');

		collector.handleData('session', BRACKETED_PASTE_START.slice(0, 3));
		collector.handleData(
			'session',
			`${BRACKETED_PASTE_START.slice(3)}fix auth\r\ntimeout${BRACKETED_PASTE_END.slice(0, 4)}`,
		);
		assert.strictEqual(events.length, 0);
		collector.handleData('session', `${BRACKETED_PASTE_END.slice(4)}\r`);

		assert.strictEqual(events[0].candidates[0], 'fix auth ti…');
		assert.strictEqual(collector.getState().inBracketedPaste, false);
	});

	test('미완성 paste, stale session, 종료 및 fresh session에서 buffer를 폐기한다', () => {
		const events: TerminalTitleCandidateEvent[] = [];
		const collector = createTerminalInputCollector('tab', (event) => events.push(event));
		collector.startSession('session-old');
		collector.handleData('session-stale', 'stale prompt\r');
		collector.handleData('session-old', `${BRACKETED_PASTE_START}unfinished prompt`);
		collector.endSession('session-old');
		assert.strictEqual(events.length, 0);

		collector.startSession('session-fresh');
		collector.handleData('session-fresh', 'fresh prompt title\r');
		assert.strictEqual(events[0].sessionId, 'session-fresh');
	});

	test('방향키와 알 수 없는 Escape sequence에서 session을 fail-closed 처리한다', () => {
		for (const sequence of ['\u001b[A', '\u001b[3~', '\u001bOH', '\u001bx']) {
			const events: TerminalTitleCandidateEvent[] = [];
			const collector = createTerminalInputCollector('tab', (event) => events.push(event));
			collector.startSession('session');
			collector.handleData('session', `partial${sequence}`);
			collector.handleData('session', 'safe prompt later\r');

			assert.strictEqual(collector.getState().abandoned, true, sequence);
			assert.deepStrictEqual(events, [], sequence);
		}
	});

	test('UTF-8 16 KiB를 초과하면 buffer를 버리고 같은 session에서 재시도하지 않는다', () => {
		const events: TerminalTitleCandidateEvent[] = [];
		const collector = createTerminalInputCollector('tab', (event) => events.push(event));
		collector.startSession('session');
		collector.handleData('session', 'a'.repeat(TERMINAL_TITLE_BUFFER_MAX_BYTES));
		assert.strictEqual(collector.getState().abandoned, false);

		collector.handleData('session', 'b');
		collector.handleData('session', 'safe title later\r');
		assert.strictEqual(collector.getState().abandoned, true);
		assert.strictEqual(collector.getState().bufferByteLength, 0);
		assert.deepStrictEqual(events, []);
	});

	test('dispose 뒤에는 session과 입력을 보관하거나 callback하지 않는다', () => {
		const events: TerminalTitleCandidateEvent[] = [];
		const collector = createTerminalInputCollector('tab', (event) => events.push(event));
		collector.startSession('session');
		collector.handleData('session', 'private partial');
		collector.dispose();
		collector.handleData('session', ' title\r');

		assert.deepStrictEqual(events, []);
		assert.deepStrictEqual(collector.getState(), {
			bufferByteLength: 0,
			inBracketedPaste: false,
			abandoned: false,
			attempted: false,
		});
	});
});
