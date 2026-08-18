/** tab 및 session ID에 허용되는 최대 UTF-16 code unit 길이다. */
export const ID_MAX_LENGTH = 128;

/** ID는 영숫자로 시작하고 이후 영숫자, 점, 밑줄, 콜론, 하이픈만 허용한다. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Terminal 열 수의 최솟값과 최댓값이다. */
export const TERMINAL_COLS_MIN = 1;
export const TERMINAL_COLS_MAX = 1_000;

/** Terminal 행 수의 최솟값과 최댓값이다. */
export const TERMINAL_ROWS_MIN = 1;
export const TERMINAL_ROWS_MAX = 1_000;

/** terminal.input 한 건에 허용되는 UTF-8 byte 크기다. */
export const TERMINAL_INPUT_MAX_BYTES = 64 * 1024;

/** Validator와 Host 정책이 함께 사용할 protocol 제한값 모음이다. */
export const PROTOCOL_LIMITS = Object.freeze({
	idMaxLength: ID_MAX_LENGTH,
	terminalColsMin: TERMINAL_COLS_MIN,
	terminalColsMax: TERMINAL_COLS_MAX,
	terminalRowsMin: TERMINAL_ROWS_MIN,
	terminalRowsMax: TERMINAL_ROWS_MAX,
	terminalInputMaxBytes: TERMINAL_INPUT_MAX_BYTES,
});
