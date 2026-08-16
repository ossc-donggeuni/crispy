'use strict';

function isPathInside(candidatePath, parentPath) {
	const path = require('node:path');
	const relativePath = path.relative(parentPath, candidatePath);
	return relativePath === ''
		|| (!relativePath.startsWith(`..${path.sep}`)
			&& relativePath !== '..'
			&& !path.isAbsolute(relativePath));
}

function dispose(disposable) {
	try {
		if (disposable !== undefined && disposable !== null && typeof disposable.dispose === 'function') {
			disposable.dispose();
		}
	} catch {
		// Listener cleanup must not prevent the PTY handle from being released.
	}
}

function releaseTerminal(terminal) {
	if (terminal === undefined || terminal === null || typeof terminal.kill !== 'function') {
		return;
	}

	try {
		/*
		 * A naturally exited Windows shell can still leave node-pty's ConPTY
		 * worker and pipe handles alive. kill() is also the public handle-release
		 * boundary, so call it after both successful and failed smoke runs.
		 */
		terminal.kill();
	} catch {
		// The shell process may already have exited; handle release is best-effort.
	}
}

function runPtySmoke(nodePty, target, smokeCwd) {
	return new Promise((resolve, reject) => {
		const isWindowsTarget = target.startsWith('win32-');
		const nonce = `${process.pid}-${Date.now().toString(36)}`;
		const readyMarker = `crispy-ready-${nonce}`;
		const firstMarker = `crispy-initial-${nonce}`;
		const resizedMarker = `crispy-resized-${nonce}`;
		const readyNeedle = `CRISPY_READY:${readyMarker}`;
		const initialNeedle = `CRISPY_INITIAL:${firstMarker}`;
		const resizedNeedle = `CRISPY_RESIZED:${resizedMarker}`;
		let output = '';
		let initialWriteRequested = false;
		let resizeRequested = false;
		let settled = false;
		let terminal;
		let dataListener;
		let exitListener;

		const timeout = setTimeout(() => {
			finish(new Error(`PTY smoke timed out; output=${JSON.stringify(output.slice(-2000))}`));
		}, 15000);

		function finish(error, result) {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timeout);
			dispose(dataListener);
			dispose(exitListener);
			releaseTerminal(terminal);

			if (error !== undefined) {
				reject(error);
				return;
			}

			resolve(result);
		}

		try {
			if (isWindowsTarget) {
				/*
				 * beta.14는 첫 output data가 도착할 때까지 write/resize를 defer한다.
				 * 따라서 입력을 기다리기 전에 readiness marker를 먼저 출력하여
				 * ConPTY 연결을 깨운다. 그 뒤 두 번의 입력을 받는 유한한 /c 명령으로
				 * write, output, resize와 정상 종료를 검증한다.
				 */
				const shellCommand = [
					`@echo ${readyNeedle}`,
					'@set /p CRISPY_VALUE=',
					'@echo CRISPY_INITIAL:!CRISPY_VALUE!',
					'@set /p CRISPY_VALUE=',
					'@echo CRISPY_RESIZED:!CRISPY_VALUE!',
				].join(' & ');
				terminal = nodePty.spawn(process.env.ComSpec || 'cmd.exe', [
					'/d',
					'/s',
					'/q',
					'/v:on',
					'/c',
					shellCommand,
				], {
					cols: 80,
					rows: 24,
					cwd: smokeCwd,
					env: process.env,
				});
			} else {
				const shellScript = [
					'stty -echo',
					'IFS= read -r first',
					'printf \'CRISPY_INITIAL:%s\\n\' "$first"',
					'IFS= read -r second',
					'current_size=$(stty size)',
					'printf \'CRISPY_RESIZED:%s\\n\' "$second"',
					'printf \'CRISPY_SIZE:%s\\n\' "$current_size"',
					'exit 0',
				].join('; ');

				terminal = nodePty.spawn('/bin/sh', ['-c', shellScript], {
					name: 'xterm-256color',
					cols: 80,
					rows: 24,
					cwd: smokeCwd,
					env: { ...process.env, TERM: 'xterm-256color' },
				});
			}

			dataListener = terminal.onData((data) => {
				output += data;

				if (
					isWindowsTarget
					&& !initialWriteRequested
					&& output.includes(readyNeedle)
				) {
					initialWriteRequested = true;
					if (!Number.isSafeInteger(terminal.pid) || terminal.pid <= 1) {
						finish(new Error('PTY produced readiness output without a valid process identifier'));
						return;
					}
					try {
						terminal.write(`${firstMarker}\r`);
					} catch (error) {
						finish(error);
						return;
					}
				}

				if (!resizeRequested && output.includes(initialNeedle)) {
					resizeRequested = true;
					try {
						terminal.resize(100, 30);
						if (isWindowsTarget) {
							terminal.write(`${resizedMarker}\r`);
						} else {
							terminal.write(`${resizedMarker}\n`);
						}
					} catch (error) {
						finish(error);
					}
				}
			});

			exitListener = terminal.onExit((event) => {
				if (event.exitCode !== 0) {
					finish(new Error(`PTY exited with code=${event.exitCode} signal=${event.signal}`));
					return;
				}

				if (!output.includes(initialNeedle)) {
					finish(new Error(`PTY did not return the initial marker; output=${JSON.stringify(output)}`));
					return;
				}

				if (!resizeRequested || !output.includes(resizedNeedle)) {
					finish(new Error(`PTY did not return the post-resize marker; output=${JSON.stringify(output)}`));
					return;
				}

				if (!isWindowsTarget && !/CRISPY_SIZE:30\s+100(?:\r?\n|$)/.test(output)) {
					finish(new Error(`PTY size did not become 30 100; output=${JSON.stringify(output)}`));
					return;
				}

				finish(undefined, {
					exitCode: event.exitCode,
					resize: isWindowsTarget ? 'completed' : '30 100',
				});
			});

			if (!isWindowsTarget) {
				terminal.write(`${firstMarker}\n`);
			}
		} catch (error) {
			finish(error);
		}
	});
}

module.exports = Object.freeze({ isPathInside, runPtySmoke });
