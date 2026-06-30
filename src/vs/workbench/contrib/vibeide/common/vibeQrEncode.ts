/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Minimal QR Code encoder — byte mode, error-correction level M, versions 1–3, single block
 * (no interleaving). Enough for short loopback/LAN URLs (≤ 42 bytes). Pure and unit-testable.
 * Algorithm follows the QR Code specification (ISO/IEC 18004); structure modelled on the
 * well-known MIT reference by Project Nayuki.
 */

/** Total data codewords per version at EC level M (single block for v1–v3). */
const DATA_CODEWORDS_M = { 1: 16, 2: 28, 3: 44 } as const;
/** Error-correction codewords per version at EC level M (single block). */
const EC_CODEWORDS_M = { 1: 10, 2: 16, 3: 26 } as const;
/** Byte-mode payload capacity per version at EC level M. */
const BYTE_CAPACITY_M = { 1: 14, 2: 26, 3: 42 } as const;
/** Centre of the single alignment pattern per version (v1 has none). */
const ALIGN_CENTER = { 1: -1, 2: 18, 3: 22 } as const;

type Version = 1 | 2 | 3;

// ── Galois field GF(256) multiply (primitive 0x11d) ──────────────────────────────
function gfMul(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

/** Reed–Solomon divisor (generator polynomial) of the given degree. */
function rsDivisor(degree: number): number[] {
	const result = new Array(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gfMul(result[j], root);
			if (j + 1 < result.length) {
				result[j] ^= result[j + 1];
			}
		}
		root = gfMul(root, 0x02);
	}
	return result;
}

/** Reed–Solomon error-correction codewords for `data`. */
function rsRemainder(data: number[], degree: number): number[] {
	const divisor = rsDivisor(degree);
	const result = new Array(degree).fill(0);
	for (const b of data) {
		const factor = b ^ (result.shift() as number);
		result.push(0);
		for (let i = 0; i < divisor.length; i++) {
			result[i] ^= gfMul(divisor[i], factor);
		}
	}
	return result;
}

function pickVersion(byteLen: number): Version | undefined {
	for (const v of [1, 2, 3] as Version[]) {
		if (byteLen <= BYTE_CAPACITY_M[v]) {
			return v;
		}
	}
	return undefined;
}

function utf8Bytes(text: string): number[] {
	const out: number[] = [];
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp < 0x80) {
			out.push(cp);
		} else if (cp < 0x800) {
			out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
		} else if (cp < 0x10000) {
			out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
		} else {
			out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
		}
	}
	return out;
}

/** Builds the full codeword sequence (data + EC) for byte-mode level-M single block. */
function buildCodewords(bytes: number[], version: Version): number[] {
	const bits: number[] = [];
	const push = (value: number, len: number) => {
		for (let i = len - 1; i >= 0; i--) {
			bits.push((value >> i) & 1);
		}
	};
	push(0b0100, 4);          // byte mode
	push(bytes.length, 8);     // char count (8 bits for v1–9)
	for (const b of bytes) {
		push(b, 8);
	}
	const dataCount = DATA_CODEWORDS_M[version];
	const capacityBits = dataCount * 8;
	// Terminator (up to 4 zero bits) + pad to byte boundary.
	for (let i = 0; i < 4 && bits.length < capacityBits; i++) {
		bits.push(0);
	}
	while (bits.length % 8 !== 0) {
		bits.push(0);
	}
	const dataCodewords: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) {
			byte = (byte << 1) | bits[i + j];
		}
		dataCodewords.push(byte);
	}
	// Pad bytes alternate 0xEC / 0x11.
	for (let pad = 0xec; dataCodewords.length < dataCount; pad ^= 0xec ^ 0x11) {
		dataCodewords.push(pad);
	}
	const ec = rsRemainder(dataCodewords, EC_CODEWORDS_M[version]);
	return [...dataCodewords, ...ec];
}

// ── Matrix construction ──────────────────────────────────────────────────────────

class QrMatrix {
	readonly version: Version;
	readonly size: number;
	readonly modules: boolean[][];
	readonly isFunction: boolean[][];

	constructor(version: Version) {
		this.version = version;
		this.size = 17 + 4 * version;
		this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
		this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
	}

	private setFn(r: number, c: number, dark: boolean): void {
		this.modules[r][c] = dark;
		this.isFunction[r][c] = true;
	}

	private finder(r: number, c: number): void {
		for (let dr = -1; dr <= 7; dr++) {
			for (let dc = -1; dc <= 7; dc++) {
				const rr = r + dr, cc = c + dc;
				if (rr < 0 || rr >= this.size || cc < 0 || cc >= this.size) {
					continue;
				}
				const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
				this.setFn(rr, cc, dist !== 2 && dist !== 4);
			}
		}
	}

	private alignment(cr: number, cc: number): void {
		for (let dr = -2; dr <= 2; dr++) {
			for (let dc = -2; dc <= 2; dc++) {
				const dist = Math.max(Math.abs(dr), Math.abs(dc));
				this.setFn(cr + dr, cc + dc, dist !== 1);
			}
		}
	}

	drawFunctionPatterns(): void {
		// Timing patterns.
		for (let i = 0; i < this.size; i++) {
			this.setFn(6, i, i % 2 === 0);
			this.setFn(i, 6, i % 2 === 0);
		}
		// Finder patterns (3 corners). finder(r,c) places the 7×7 with its top-left at (r,c);
		// the -1..7 loop also paints the white separator ring around it.
		this.finder(0, 0);
		this.finder(0, this.size - 7);
		this.finder(this.size - 7, 0);
		// Alignment pattern (v2/v3).
		const center = ALIGN_CENTER[this.version];
		if (center >= 0) {
			this.alignment(center, center);
		}
		// Dark module.
		this.setFn(this.size - 8, 8, true);
		// Reserve format-info areas (filled later via setFormat).
		for (let i = 0; i < 9; i++) {
			if (!this.isFunction[8][i]) { this.setFn(8, i, false); }
			if (!this.isFunction[i][8]) { this.setFn(i, 8, false); }
		}
		for (let i = 0; i < 8; i++) {
			if (!this.isFunction[8][this.size - 1 - i]) { this.setFn(8, this.size - 1 - i, false); }
			if (!this.isFunction[this.size - 1 - i][8]) { this.setFn(this.size - 1 - i, 8, false); }
		}
	}

	/** Zig-zag placement of codeword bits over non-function modules. */
	placeData(codewords: number[]): void {
		let bitIndex = 0;
		const totalBits = codewords.length * 8;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			const col = right === 6 ? 5 : right; // skip the vertical timing column
			for (let v = 0; v < this.size; v++) {
				for (let c = 0; c < 2; c++) {
					const cc = col - c;
					const upward = ((right + 1) & 2) === 0;
					const rr = upward ? this.size - 1 - v : v;
					if (this.isFunction[rr][cc]) {
						continue;
					}
					let dark = false;
					if (bitIndex < totalBits) {
						dark = ((codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1) === 1;
						bitIndex++;
					}
					this.modules[rr][cc] = dark;
				}
			}
		}
	}

	applyMask(mask: number): void {
		for (let r = 0; r < this.size; r++) {
			for (let c = 0; c < this.size; c++) {
				if (this.isFunction[r][c]) {
					continue;
				}
				if (maskCondition(mask, r, c)) {
					this.modules[r][c] = !this.modules[r][c];
				}
			}
		}
	}

	setFormat(mask: number): void {
		const bits = formatBits(mask);
		// Around the top-left finder.
		for (let i = 0; i <= 5; i++) { this.setFn(8, i, ((bits >> i) & 1) === 1); }
		this.setFn(8, 7, ((bits >> 6) & 1) === 1);
		this.setFn(8, 8, ((bits >> 7) & 1) === 1);
		this.setFn(7, 8, ((bits >> 8) & 1) === 1);
		for (let i = 9; i < 15; i++) { this.setFn(14 - i, 8, ((bits >> i) & 1) === 1); }
		// Mirror copy around the other two finders.
		for (let i = 0; i < 8; i++) { this.setFn(8, this.size - 1 - i, ((bits >> i) & 1) === 1); }
		for (let i = 8; i < 15; i++) { this.setFn(this.size - 15 + i, 8, ((bits >> i) & 1) === 1); }
		this.setFn(this.size - 8, 8, true); // dark module stays set
	}

	penalty(): number {
		let score = 0;
		const n = this.size;
		// Rule 1: runs of ≥5 same-colour modules (rows + cols).
		for (let r = 0; r < n; r++) {
			for (let dir = 0; dir < 2; dir++) {
				let run = 1;
				for (let i = 1; i < n; i++) {
					const a = dir === 0 ? this.modules[r][i] : this.modules[i][r];
					const b = dir === 0 ? this.modules[r][i - 1] : this.modules[i - 1][r];
					if (a === b) {
						run++;
						if (run === 5) { score += 3; } else if (run > 5) { score += 1; }
					} else {
						run = 1;
					}
				}
			}
		}
		// Rule 2: 2×2 blocks of same colour.
		for (let r = 0; r < n - 1; r++) {
			for (let c = 0; c < n - 1; c++) {
				const v = this.modules[r][c];
				if (v === this.modules[r][c + 1] && v === this.modules[r + 1][c] && v === this.modules[r + 1][c + 1]) {
					score += 3;
				}
			}
		}
		// Rule 3: finder-like 1:1:3:1:1 patterns with a 4-module light run on one side.
		const patA = [true, false, true, true, true, false, true, false, false, false, false];
		const patB = [false, false, false, false, true, false, true, true, true, false, true];
		const lineFinderLike = (get: (i: number) => boolean): number => {
			let hits = 0;
			for (let i = 0; i + 11 <= n; i++) {
				let a = true, b = true;
				for (let k = 0; k < 11; k++) {
					const v = get(i + k);
					if (v !== patA[k]) { a = false; }
					if (v !== patB[k]) { b = false; }
				}
				if (a || b) { hits++; }
			}
			return hits;
		};
		for (let r = 0; r < n; r++) { score += 40 * lineFinderLike(i => this.modules[r][i]); }
		for (let c = 0; c < n; c++) { score += 40 * lineFinderLike(i => this.modules[i][c]); }
		// Rule 4: dark-module proportion deviation from 50%.
		let dark = 0;
		for (let r = 0; r < n; r++) {
			for (let c = 0; c < n; c++) {
				if (this.modules[r][c]) { dark++; }
			}
		}
		const percent = (dark * 100) / (n * n);
		score += Math.floor(Math.abs(percent - 50) / 5) * 10;
		return score;
	}
}

function maskCondition(mask: number, r: number, c: number): boolean {
	switch (mask) {
		case 0: return (r + c) % 2 === 0;
		case 1: return r % 2 === 0;
		case 2: return c % 3 === 0;
		case 3: return (r + c) % 3 === 0;
		case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
		case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
		case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
		default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
	}
}

/** 15-bit BCH format information for EC level M and the given mask. */
function formatBits(mask: number): number {
	const data = (0b00 << 3) | mask; // M = 00
	let rem = data;
	for (let i = 0; i < 10; i++) {
		rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
	}
	return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

/**
 * Encodes `text` into a QR matrix (`true` = dark module). Throws when the text exceeds the
 * supported capacity (42 bytes at level M / version 3).
 */
export function encodeQrMatrix(text: string): boolean[][] {
	const bytes = utf8Bytes(text);
	const version = pickVersion(bytes.length);
	if (!version) {
		throw new Error('QR: текст слишком длинный (поддерживаются версии 1–3, ≤42 байт)');
	}
	const codewords = buildCodewords(bytes, version);

	let best: QrMatrix | undefined;
	let bestScore = Infinity;
	for (let mask = 0; mask < 8; mask++) {
		const m = new QrMatrix(version);
		m.drawFunctionPatterns();
		m.placeData(codewords);
		m.applyMask(mask);
		m.setFormat(mask);
		const score = m.penalty();
		if (score < bestScore) {
			bestScore = score;
			best = m;
		}
	}
	return best!.modules;
}
