'use strict';

function nativeBinaryError(target, artifactPath, reason, expected, actual) {
	const details = [
		`[native-binary] target=${target} failed: ${reason}`,
		`[native-binary] path=${artifactPath}`,
	];

	if (expected !== undefined) {
		details.push(`[native-binary] expected=${expected}`);
	}

	if (actual !== undefined) {
		details.push(`[native-binary] actual=${actual}`);
	}

	return new Error(details.join('\n'));
}

function requireLength(target, artifactPath, binary, expectedLength, format) {
	if (binary.length < expectedLength) {
		throw nativeBinaryError(
			target,
			artifactPath,
			`${format} header is truncated`,
			`at least ${expectedLength} bytes`,
			`${binary.length} bytes`,
		);
	}
}

function hex(value) {
	return `0x${value.toString(16)}`;
}

function verifyMachO(target, artifactPath, binary, expectedCpu, expectedFileType) {
	requireLength(target, artifactPath, binary, 32, 'Mach-O 64');

	const machOMagic64 = 0xfeedfacf;
	let readUInt32;

	if (binary.readUInt32LE(0) === machOMagic64) {
		readUInt32 = (offset) => binary.readUInt32LE(offset);
	} else if (binary.readUInt32BE(0) === machOMagic64) {
		readUInt32 = (offset) => binary.readUInt32BE(offset);
	} else {
		throw nativeBinaryError(
			target,
			artifactPath,
			'native artifact is not a thin Mach-O 64 binary',
			hex(machOMagic64),
			binary.subarray(0, 4).toString('hex'),
		);
	}

	const actualCpu = readUInt32(4);
	const actualFileType = readUInt32(12);

	if (actualCpu !== expectedCpu) {
		throw nativeBinaryError(target, artifactPath, 'Mach-O CPU architecture mismatch', hex(expectedCpu), hex(actualCpu));
	}

	if (actualFileType !== expectedFileType) {
		throw nativeBinaryError(target, artifactPath, 'Mach-O file type mismatch', hex(expectedFileType), hex(actualFileType));
	}
}

function verifyElf(target, artifactPath, binary) {
	requireLength(target, artifactPath, binary, 64, 'ELF 64');

	const magic = binary.subarray(0, 4).toString('hex');

	if (magic !== '7f454c46') {
		throw nativeBinaryError(target, artifactPath, 'invalid ELF magic', '7f454c46', magic);
	}

	if (binary[4] !== 2) {
		throw nativeBinaryError(target, artifactPath, 'invalid ELF class', 'ELFCLASS64 (2)', String(binary[4]));
	}

	if (binary[5] !== 1) {
		throw nativeBinaryError(target, artifactPath, 'invalid ELF byte order', 'little-endian (1)', String(binary[5]));
	}

	const fileType = binary.readUInt16LE(16);
	const machine = binary.readUInt16LE(18);

	if (fileType !== 3) {
		throw nativeBinaryError(target, artifactPath, 'invalid ELF file type', 'ET_DYN (3)', String(fileType));
	}

	if (machine !== 62) {
		throw nativeBinaryError(target, artifactPath, 'invalid ELF machine', 'EM_X86_64 (62)', String(machine));
	}
}

function verifyPe(target, artifactPath, binary) {
	requireLength(target, artifactPath, binary, 64, 'PE');

	const dosMagic = binary.subarray(0, 2).toString('ascii');

	if (dosMagic !== 'MZ') {
		throw nativeBinaryError(target, artifactPath, 'invalid DOS header magic', 'MZ', dosMagic);
	}

	const peOffset = binary.readUInt32LE(0x3c);
	const requiredLength = peOffset + 26;

	if (!Number.isSafeInteger(requiredLength) || peOffset > binary.length || requiredLength > binary.length) {
		throw nativeBinaryError(
			target,
			artifactPath,
			'PE e_lfanew points outside the artifact',
			`offset with 26-byte header <= ${binary.length}`,
			`e_lfanew=${peOffset}`,
		);
	}

	const peMagic = binary.subarray(peOffset, peOffset + 4).toString('hex');

	if (peMagic !== '50450000') {
		throw nativeBinaryError(target, artifactPath, 'invalid PE signature', '50450000', peMagic);
	}

	const machine = binary.readUInt16LE(peOffset + 4);
	const optionalHeaderSize = binary.readUInt16LE(peOffset + 20);
	const optionalHeaderMagic = binary.readUInt16LE(peOffset + 24);

	if (machine !== 0x8664) {
		throw nativeBinaryError(target, artifactPath, 'invalid PE machine', 'IMAGE_FILE_MACHINE_AMD64 (0x8664)', hex(machine));
	}

	if (optionalHeaderSize < 2) {
		throw nativeBinaryError(target, artifactPath, 'PE optional header is truncated', 'at least 2 bytes', `${optionalHeaderSize} bytes`);
	}

	if (optionalHeaderMagic !== 0x20b) {
		throw nativeBinaryError(target, artifactPath, 'invalid PE optional header', 'PE32+ (0x20b)', hex(optionalHeaderMagic));
	}
}

function verifyNativeBinary(target, artifactPath, binary) {
	if (!Buffer.isBuffer(binary)) {
		throw nativeBinaryError(target, artifactPath, 'native artifact was not provided as a Buffer', 'Buffer', typeof binary);
	}

	if (target === 'darwin-arm64') {
		const expectedCpu = 0x0100000c;
		const expectedFileType = artifactPath.endsWith('/spawn-helper') ? 2 : 8;
		verifyMachO(target, artifactPath, binary, expectedCpu, expectedFileType);
		return;
	}

	if (target === 'linux-x64') {
		verifyElf(target, artifactPath, binary);
		return;
	}

	if (target === 'win32-x64') {
		verifyPe(target, artifactPath, binary);
		return;
	}

	throw nativeBinaryError(target, artifactPath, 'unsupported native target');
}

module.exports = Object.freeze({ verifyNativeBinary });
