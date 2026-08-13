/**
 * ANSI, truecolor, alternate screen, Unicode 입력, resize 및 Ctrl+C 전달을 검증하는 PTY fixture다.
 * 알려진 marker를 stdout에 기록하여 smoke runner가 각 terminal capability를 단언할 수 있게 한다.
 */
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

process.stdout.write('\u001b[32mANSI_OK\u001b[0m\r\n');
process.stdout.write('\u001b[38;2;1;2;3mTRUECOLOR_OK\u001b[0m\r\n');
process.stdout.write('\u001b[?1049hALT_SCREEN_OK\u001b[?1049l');
process.stdout.write(`READY ${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0}\r\n`);
process.stdout.write(`CWD ${process.cwd()}\r\n`);

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;

  if (input.includes('\u0003')) {
    process.stdout.write('CTRL_C_OK\r\n');
    process.exit(130);
  }
  if (input.includes('한글😀\r')) {
    process.stdout.write('UNICODE_INPUT_OK 한글 😀\r\n');
    input = input.replace('한글😀\r', '');
  }
  if (input.includes('SIZE\r')) {
    process.stdout.write(`SIZE ${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0}\r\n`);
    input = input.replace('SIZE\r', '');
  }
});
