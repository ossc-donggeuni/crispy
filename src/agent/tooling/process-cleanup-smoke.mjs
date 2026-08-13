import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PtySessionManager } = require('../../../out/agent/host/ptySessionManager.js');
const fixture = fileURLToPath(new URL('../fixtures/process-tree-fixture.mjs', import.meta.url));
const manager = new PtySessionManager({ log: () => undefined, error: console.error });
let treePids;
let sessionId;

/**
 * 실제 PTY가 생성한 부모와 자식 process tree를 중단하고 두 PID가 모두 사라지는지 검증한다.
 */
try {
  sessionId = manager.startShell({
    launch: { executable: process.execPath, args: [fixture], label: 'cleanup-fixture' },
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    emit: (message) => {
      if (message.type !== 'terminal/output' || treePids) {
        return;
      }
      const match = /TREE (\d+) (\d+)/.exec(message.payload.data);
      if (match) {
        treePids = [Number(match[1]), Number(match[2])];
      }
    },
  });

  await waitFor(() => treePids !== undefined, 5_000, 'process tree fixture did not report PIDs');
  assert.equal(await manager.stop(sessionId), true, 'PTY exit was not confirmed');
  await waitFor(
    () => treePids.every((pid) => !isAlive(pid)),
    5_000,
    `process tree remained alive: ${treePids.join(', ')}`,
  );
  console.log('Process cleanup smoke passed: PTY parent and child process tree exited.');
} finally {
  await manager.dispose();
  if (treePids) {
    for (const pid of treePids) {
      if (isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  }
}

/**
 * PID가 현재 signal을 받을 수 있는 상태인지 확인한다.
 *
 * @param {number} pid 생존 여부를 확인할 process ID
 * @returns {boolean} process가 존재하거나 접근 오류로 생존 가능성이 있는지 여부
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/**
 * 조건이 만족될 때까지 짧은 간격으로 반복 확인한다.
 *
 * @param {() => boolean} predicate 완료 조건
 * @param {number} timeoutMs 최대 대기 시간
 * @param {string} message timeout 시 사용할 오류 메시지
 * @returns {Promise<void>} 조건 충족 시 완료되는 Promise
 */
async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}
