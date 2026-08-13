import { spawn } from 'node:child_process';

/**
 * process-tree cleanup 검증을 위해 종료되지 않는 자식 Node.js process를 생성한다.
 * 부모와 자식 PID는 smoke runner가 생존 여부를 확인할 수 있도록 PTY stdout으로 전달한다.
 */
const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
  stdio: 'ignore',
});

process.stdout.write(`TREE ${process.pid} ${child.pid}\r\n`);
setInterval(() => undefined, 1_000);
