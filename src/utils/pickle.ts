/**
 * Minimal pickle codec supporting protocols 3, 4, and 5
 *
 * Supports JSON-compatible primitives (null, bool, number, string, arrays,
 * plain objects) and Uint8Array. The encoder can emit protocols 3/4/5
 * (default 4), and the decoder reads pickles whose first PROTO is 3/4/5 and
 * that use only supported opcodes. This is not a complete Python pickler, but
 * it is sufficient for lightweight data exchange.
 */

/**
 * UTF-8 conversion singleton for encoding
 */
const textEncoder = new TextEncoder();

/**
 * UTF-8 conversion singleton for decoding
 */
const textDecoder = new TextDecoder();

/**
 * Reusable buffer for float64BE writes
 */
const scratchBuf = new ArrayBuffer(8);
const scratchDv = new DataView(scratchBuf);
const scratchBytes = new Uint8Array(scratchBuf);

/**
 * Error specific to pickle processing
 */
class PickleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PickleError";
	}
}

/**
 * Pickle opcode definitions as single-byte values
 */
enum Op {
	PROTO = 0x80,
	STOP = 0x2e,
	NONE = 0x4e,
	NEWTRUE = 0x88,
	NEWFALSE = 0x89,

	BININT1 = 0x4b,
	BININT2 = 0x4d,
	BININT4 = 0x4a,
	BINFLOAT = 0x47,

	SHORT_BINUNICODE = 0x8c,
	BINUNICODE = 0x58,
	BINUNICODE8 = 0x8d,

	SHORT_BINBYTES = 0x43,
	BINBYTES = 0x42,
	BINBYTES8 = 0x8e,

	EMPTY_LIST = 0x5d,
	APPEND = 0x61,
	EMPTY_DICT = 0x7d,
	SETITEM = 0x73,
	MARK = 0x28,

	BINPUT = 0x71,
	LONG_BINPUT = 0x72,
	BINGET = 0x68,
	LONG_BINGET = 0x6a,
	MEMOIZE = 0x94,
	FRAME = 0x95,
	APPENDS = 0x65,
	SETITEMS = 0x75,
}

/**
 * Buffer that builds pickle binary output
 */
class Writer {
	private out: number[] = [];

	/**
	 * Writes one byte
	 * @param b - Value to write; only the low 8 bits are used
	 */
	byte(b: number) {
		this.out.push(b & 0xff);
	}

	/**
	 * Writes bytes as-is
	 * @param arr - Bytes to write
	 */
	bytes(arr: Uint8Array | number[]) {
		for (const b of arr) this.byte(b as number);
	}

	/**
	 * Writes a 32-bit unsigned integer in little-endian order
	 * @param x - Value to write
	 */
	uint32LE(x: number) {
		this.byte(x);
		this.byte(x >>> 8);
		this.byte(x >>> 16);
		this.byte(x >>> 24);
	}

	/**
	 * Writes a 64-bit unsigned integer in little-endian order
	 * @param n - Value to write
	 */
	uint64LE(n: number | bigint) {
		let v = BigInt(n);
		for (let i = 0; i < 8; i++) {
			this.byte(Number(v & 0xffn));
			v >>= 8n;
		}
	}

	/**
	 * Writes a 64-bit floating-point number in big-endian order
	 * @param v - Value to write
	 */
	float64BE(v: number) {
		scratchDv.setFloat64(0, v, false);
		this.bytes(scratchBytes);
	}

	/**
	 * Returns the buffer contents as a Uint8Array
	 * @returns Accumulated bytes
	 */
	toUint8(): Uint8Array {
		return new Uint8Array(this.out);
	}
}

/**
 * Cursor for sequentially reading pickle binary data
 */
class Reader {
	constructor(
		private buf: Uint8Array,
		public pos = 0,
	) {}

	/**
	 * Checks whether the cursor reached the end of the buffer
	 * @returns true at the end
	 */
	eof() {
		return this.pos >= this.buf.length;
	}

	/**
	 * Reads one byte
	 * @returns Read value
	 * @throws When reading past the end of data
	 */
	byte(): number {
		const value = this.buf[this.pos++];
		if (value === undefined) {
			throw new PickleError("Unexpected end of pickle data");
		}
		return value;
	}

	/**
	 * Returns an n-byte subarray without copying
	 * @param n - Number of bytes to read
	 * @returns Partial view into the buffer
	 */
	take(n: number) {
		const s = this.buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return s;
	}

	/**
	 * Reads a 32-bit unsigned integer in little-endian order
	 * @returns Read value
	 */
	uint32LE() {
		const b0 = this.byte(),
			b1 = this.byte(),
			b2 = this.byte(),
			b3 = this.byte();
		return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
	}

	/**
	 * Reads a 64-bit unsigned integer in little-endian order
	 * @returns Read value within number precision
	 */
	uint64LE() {
		const lo = this.uint32LE() >>> 0;
		const hi = this.uint32LE() >>> 0;
		return hi * 2 ** 32 + lo;
	}

	/**
	 * Reads a 32-bit signed integer in little-endian order
	 * @returns Read value
	 */
	int32LE() {
		const v = new DataView(
			this.buf.buffer,
			this.buf.byteOffset + this.pos,
			4,
		).getInt32(0, true);
		this.pos += 4;
		return v;
	}

	/**
	 * Reads a 64-bit floating-point number in big-endian order
	 * @returns Read value
	 */
	float64BE() {
		const v = new DataView(
			this.buf.buffer,
			this.buf.byteOffset + this.pos,
			8,
		).getFloat64(0, false);
		this.pos += 8;
		return v;
	}
}

/**
 * Pickle protocol version
 */
export type Protocol = 3 | 4 | 5;

/**
 * Recursively encodes a JS value into pickle opcodes
 * @param val - Value to encode
 * @param w - Destination Writer
 * @param proto - Protocol version to use
 */
function encodeValue(val: unknown, w: Writer, proto: Protocol) {
	if (val === null || val === undefined) {
		w.byte(Op.NONE);
		return;
	}
	if (typeof val === "boolean") {
		w.byte(val ? Op.NEWTRUE : Op.NEWFALSE);
		return;
	}

	if (typeof val === "number") {
		if (Number.isInteger(val)) {
			if (val >= 0 && val <= 0xff) {
				w.byte(Op.BININT1);
				w.byte(val);
			} else if (val >= 0 && val <= 0xffff) {
				w.byte(Op.BININT2);
				w.byte(val & 0xff);
				w.byte((val >> 8) & 0xff);
			} else if (val >= -2147483648 && val <= 2147483647) {
				w.byte(Op.BININT4);
				w.uint32LE(val >>> 0);
			} else {
				throw new PickleError(`Integer out of encodable range: ${val}`);
			}
		} else {
			w.byte(Op.BINFLOAT);
			w.float64BE(val);
		}
		return;
	}

	if (typeof val === "string") {
		const utf8 = textEncoder.encode(val);
		if (proto >= 4 && utf8.length < 256) {
			w.byte(Op.SHORT_BINUNICODE);
			w.byte(utf8.length);
		} else if (proto >= 4 && utf8.length > 0xffff_ffff) {
			w.byte(Op.BINUNICODE8);
			w.uint64LE(utf8.length);
		} else {
			w.byte(Op.BINUNICODE);
			w.uint32LE(utf8.length);
		}
		w.bytes(utf8);
		maybeMemoize(w, proto);
		return;
	}

	if (val instanceof Uint8Array) {
		const len = val.length;
		if (proto >= 4 && len < 256) {
			w.byte(Op.SHORT_BINBYTES);
			w.byte(len);
		} else if (proto >= 4 && len > 0xffff_ffff) {
			w.byte(Op.BINBYTES8);
			w.uint64LE(len);
		} else {
			w.byte(Op.BINBYTES);
			w.uint32LE(len);
		}
		w.bytes(val);
		maybeMemoize(w, proto);
		return;
	}

	if (Array.isArray(val)) {
		w.byte(Op.EMPTY_LIST);
		maybeMemoize(w, proto);
		for (const item of val) {
			encodeValue(item, w, proto);
			w.byte(Op.APPEND);
		}
		return;
	}

	if (typeof val === "object") {
		w.byte(Op.EMPTY_DICT);
		maybeMemoize(w, proto);
		for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
			encodeValue(k, w, proto);
			encodeValue(v, w, proto);
			w.byte(Op.SETITEM);
		}
		return;
	}

	throw new PickleError(
		`The JS Modal SDK does not support encoding/pickling data of type ${typeof val}`,
	);
}

/**
 * Emits a MEMOIZE opcode when protocol 4 or newer is used
 * @param w - Destination Writer
 * @param proto - Active protocol version
 */
function maybeMemoize(w: Writer, proto: Protocol) {
	if (proto >= 4) {
		w.byte(Op.MEMOIZE);
	}
}

/**
 * Serializes a JS value into pickle bytes
 * @param obj - Value to serialize
 * @param protocol - Pickle protocol version @defaultValue 4
 * @returns Pickle bytes
 */
export function dumps(obj: unknown, protocol: Protocol = 4): Uint8Array {
	if (![3, 4, 5].includes(protocol))
		throw new PickleError(
			`The JS Modal SDK does not support pickle protocol version ${protocol}`,
		);
	const w = new Writer();
	w.byte(Op.PROTO);
	w.byte(protocol);
	if (protocol === 5) {
		// Emit a zero-length FRAME so CPython recognizes this as proto-5.
		w.byte(Op.FRAME);
		w.uint64LE(0);
	}
	encodeValue(obj, w, protocol);
	w.byte(Op.STOP);
	return w.toUint8();
}

/**
 * Deserializes pickle bytes into a JS value
 * @param buf - Pickle data
 * @returns Deserialized value
 */
export function loads(buf: Uint8Array): unknown {
	const r = new Reader(buf);
	const op0 = r.byte();
	if (op0 !== Op.PROTO) throw new PickleError("pickle missing PROTO header");
	const proto: Protocol = r.byte() as Protocol;
	if (![3, 4, 5].includes(proto))
		throw new PickleError(
			`The JS Modal SDK does not support pickle protocol version ${proto}`,
		);

	const stack: unknown[] = [];
	const memo: unknown[] = [];

	if (proto === 5 && buf[r.pos] === Op.FRAME) {
		r.byte();
		r.uint64LE(); // FRAME size - we stream-read instead
	}

	// Use a Symbol so MARK is not confused with user data.
	const MARK = Symbol("pickle-mark");

	while (!r.eof()) {
		const op = r.byte();
		switch (op) {
			case Op.STOP:
				return stack.pop();
			case Op.NONE:
				stack.push(null);
				break;
			case Op.NEWTRUE:
				stack.push(true);
				break;
			case Op.NEWFALSE:
				stack.push(false);
				break;

			case Op.BININT1:
				stack.push(r.byte());
				break;
			case Op.BININT2: {
				const lo = r.byte(),
					hi = r.byte();
				const n = (hi << 8) | lo;
				stack.push(n);
				break;
			}
			case Op.BININT4: {
				stack.push(r.int32LE());
				break;
			}
			case Op.BINFLOAT:
				stack.push(r.float64BE());
				break;

			case Op.SHORT_BINUNICODE: {
				const n = r.byte();
				stack.push(textDecoder.decode(r.take(n)));
				break;
			}
			case Op.BINUNICODE: {
				const n = r.uint32LE();
				stack.push(textDecoder.decode(r.take(n)));
				break;
			}
			case Op.BINUNICODE8: {
				const n = r.uint64LE();
				stack.push(textDecoder.decode(r.take(n)));
				break;
			}

			case Op.SHORT_BINBYTES: {
				const n = r.byte();
				stack.push(r.take(n));
				break;
			}
			case Op.BINBYTES: {
				const n = r.uint32LE();
				stack.push(r.take(n));
				break;
			}
			case Op.BINBYTES8: {
				const n = r.uint64LE();
				stack.push(r.take(n));
				break;
			}

			case Op.EMPTY_LIST:
				stack.push([]);
				break;
			case Op.APPEND: {
				const v = stack.pop();
				const lst = stack.pop() as unknown[];
				lst.push(v);
				stack.push(lst);
				break;
			}
			case Op.EMPTY_DICT:
				stack.push({});
				break;
			case Op.SETITEM: {
				const v = stack.pop(),
					k = stack.pop() as string,
					d = stack.pop() as Record<string, unknown>;
				d[k] = v;
				stack.push(d);
				break;
			}

			case Op.MEMOIZE:
				memo.push(stack[stack.length - 1]);
				break;
			case Op.BINPUT:
				memo[r.byte()] = stack[stack.length - 1];
				break;
			case Op.LONG_BINPUT:
				memo[r.uint32LE()] = stack[stack.length - 1];
				break;
			case Op.BINGET:
				stack.push(memo[r.byte()]);
				break;
			case Op.LONG_BINGET:
				stack.push(memo[r.uint32LE()]);
				break;

			case Op.FRAME:
				r.uint64LE();
				break;

			case Op.MARK:
				stack.push(MARK);
				break;

			case Op.APPENDS: {
				const markIndex = stack.lastIndexOf(MARK);
				if (markIndex === -1) {
					throw new PickleError("APPENDS without MARK");
				}
				const lst = stack[markIndex - 1];
				if (!Array.isArray(lst)) {
					throw new PickleError("APPENDS expects a list below MARK");
				}
				const items = stack.slice(markIndex + 1);
				lst.push(...items);
				stack.length = markIndex - 1;
				stack.push(lst);
				break;
			}

			case Op.SETITEMS: {
				const markIndex = stack.lastIndexOf(MARK);
				if (markIndex === -1) {
					throw new PickleError("SETITEMS without MARK");
				}
				const d = stack[markIndex - 1];
				if (typeof d !== "object" || d === null || Array.isArray(d)) {
					throw new PickleError("SETITEMS expects a dict below MARK");
				}
				const dict = d as Record<string, unknown>;
				const items = stack.slice(markIndex + 1);
				for (let i = 0; i < items.length; i += 2) {
					if (i + 1 < items.length) {
						dict[items[i] as string] = items[i + 1];
					}
				}
				stack.length = markIndex - 1;
				stack.push(d);
				break;
			}

			default:
				throw new PickleError(
					`The JS Modal SDK does not support decoding/unpickling this kind of data. Error: unsupported opcode 0x${op.toString(16)}`,
				);
		}
	}
	throw new PickleError("pickle stream ended without STOP");
}
