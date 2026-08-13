import { access, chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * macOS node-pty 설치본의 spawn-helper에 실행 권한을 부여한다.
 * prebuild와 source build 경로를 순서대로 탐색하며 다른 플랫폼에서는 아무 작업도 하지 않는다.
 */
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve('node-pty/package.json'));
  const candidates = [
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
  ];
  let prepared = false;

  for (const helperPath of candidates) {
    try {
      await access(helperPath);
      await chmod(helperPath, 0o755);
      console.log(`Prepared node-pty spawn helper: ${helperPath}`);
      prepared = true;
      break;
    } catch {
      // 현재 설치가 prebuild 또는 source build 중 어느 경로를 사용하든 나머지는 건너뛴다.
    }
  }

  if (!prepared) {
    throw new Error('Unable to locate the node-pty spawn helper for this macOS target.');
  }
}
