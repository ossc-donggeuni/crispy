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
	if (disposable !== undefined && disposable !== null && typeof disposable.dispose === 'function') {
		disposable.dispose();
	}
}

function runPtySmoke(nodePty, target, smokeCwd) {
	return new Promise((resolve, reject) => {
		const nonce = `${process.pid}-${Date.now().toString(36)}`;
		const firstMarker = `crispy-initial-${nonce}`;
		const resizedMarker = `crispy-resized-${nonce}`;
		const initialNeedle = `CRISPY_INITIAL:${firstMarker}`;
		const resizedNeedle = `CRISPY_RESIZED:${resizedMarker}`;
		let output = '';
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

			if (error !== undefined) {
				if (terminal !== undefined) {
					try {
						terminal.kill();
					} catch {
						// The child may already have exited.
					}
				}
				reject(error);
				return;
			}

			resolve(result);
		}

		try {
			if (target.startsWith('win32-')) {
				terminal = nodePty.spawn(process.env.ComSpec || 'cmd.exe', [], {
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

				if (!resizeRequested && output.includes(initialNeedle)) {
					resizeRequested = true;
					try {
						terminal.resize(100, 30);
						if (target.startsWith('win32-')) {
							terminal.write([
								'@set /p CRISPY_VALUE=',
								resizedMarker,
								'@echo CRISPY_RESIZED:%CRISPY_VALUE%',
								'@exit 0',
								'',
							].join('\r'));
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

				if (!target.startsWith('win32-') && !/CRISPY_SIZE:30\s+100(?:\r?\n|$)/.test(output)) {
					finish(new Error(`PTY size did not become 30 100; output=${JSON.stringify(output)}`));
					return;
				}

				finish(undefined, {
					exitCode: event.exitCode,
					resize: target.startsWith('win32-') ? 'completed' : '30 100',
				});
			});

			if (target.startsWith('win32-')) {
				terminal.write([
					'@set /p CRISPY_VALUE=',
					firstMarker,
					'@echo CRISPY_INITIAL:%CRISPY_VALUE%',
					'',
				].join('\r'));
			} else {
				terminal.write(`${firstMarker}\n`);
			}
		} catch (error) {
			finish(error);
		}
	});
}

module.exports = Object.freeze({ isPathInside, runPtySmoke });
