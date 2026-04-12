/**
 * @description protocol 3, 4, 5 対応の最小 pickle コーデック
 *
 * JSON 互換プリミティブ(null, bool, number, string, 配列, プレーンオブジェクト)
 * と Uint8Array をサポートする。エンコーダは protocol 3/4/5 を出力でき(デフォルト 4),
 * デコーダは最初の PROTO が 3/4/5 でサポート済み opcode のみ使用する pickle を読み取る。
 * 完全な Python pickler ではないが, 軽量データ交換には十分。
 */

/**
 * @description エンコード用 UTF-8 変換シングルトン
 */
const textEncoder = new TextEncoder();

/**
 * @description デコード用 UTF-8 変換シングルトン
 */
const textDecoder = new TextDecoder();

/**
 * @description float64BE 書き込み用の再利用バッファ
 */
const scratchBuf = new ArrayBuffer(8);
const scratchDv = new DataView(scratchBuf);
const scratchBytes = new Uint8Array(scratchBuf);

/**
 * @description pickle 処理固有のエラー
 */
class PickleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PickleError";
	}
}

/**
 * @description pickle opcode 定義 (単バイト値)
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
 * @description pickle バイナリ出力を組み立てるバッファ
 */
class Writer {
	private out: number[] = [];

	/**
	 * @description 1 バイト書き込み
	 * @param b - 書き込む値 (下位 8 ビットのみ使用)
	 */
	byte(b: number) {
		this.out.push(b & 0xff);
	}

	/**
	 * @description バイト列をそのまま書き込み
	 * @param arr - 書き込むバイト列
	 */
	bytes(arr: Uint8Array | number[]) {
		for (const b of arr) this.byte(b as number);
	}

	/**
	 * @description 32 ビット符号なし整数をリトルエンディアンで書き込み
	 * @param x - 書き込む値
	 */
	uint32LE(x: number) {
		this.byte(x);
		this.byte(x >>> 8);
		this.byte(x >>> 16);
		this.byte(x >>> 24);
	}

	/**
	 * @description 64 ビット符号なし整数をリトルエンディアンで書き込み
	 * @param n - 書き込む値
	 */
	uint64LE(n: number | bigint) {
		let v = BigInt(n);
		for (let i = 0; i < 8; i++) {
			this.byte(Number(v & 0xffn));
			v >>= 8n;
		}
	}

	/**
	 * @description 64 ビット浮動小数点数をビッグエンディアンで書き込み
	 * @param v - 書き込む値
	 */
	float64BE(v: number) {
		scratchDv.setFloat64(0, v, false);
		this.bytes(scratchBytes);
	}

	/**
	 * @description バッファ内容を Uint8Array として取得
	 * @returns 蓄積されたバイト列
	 */
	toUint8(): Uint8Array {
		return new Uint8Array(this.out);
	}
}

/**
 * @description pickle バイナリデータの順次読み取りカーソル
 */
class Reader {
	constructor(
		private buf: Uint8Array,
		public pos = 0,
	) {}

	/**
	 * @description バッファ末尾に達したか
	 * @returns 末尾なら true
	 */
	eof() {
		return this.pos >= this.buf.length;
	}

	/**
	 * @description 1 バイト読み取り
	 * @returns 読み取った値
	 * @throws データ末尾を超えた場合
	 */
	byte(): number {
		const value = this.buf[this.pos++];
		if (value === undefined) {
			throw new PickleError("Unexpected end of pickle data");
		}
		return value;
	}

	/**
	 * @description n バイトの subarray を返す (ゼロコピー)
	 * @param n - 読み取るバイト数
	 * @returns バッファの部分ビュー
	 */
	take(n: number) {
		const s = this.buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return s;
	}

	/**
	 * @description 32 ビット符号なし整数をリトルエンディアンで読み取り
	 * @returns 読み取った値
	 */
	uint32LE() {
		const b0 = this.byte(),
			b1 = this.byte(),
			b2 = this.byte(),
			b3 = this.byte();
		return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
	}

	/**
	 * @description 64 ビット符号なし整数をリトルエンディアンで読み取り
	 * @returns 読み取った値 (number 精度に収まる範囲)
	 */
	uint64LE() {
		const lo = this.uint32LE() >>> 0;
		const hi = this.uint32LE() >>> 0;
		return hi * 2 ** 32 + lo;
	}

	/**
	 * @description 32 ビット符号付き整数をリトルエンディアンで読み取り
	 * @returns 読み取った値
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
	 * @description 64 ビット浮動小数点数をビッグエンディアンで読み取り
	 * @returns 読み取った値
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
 * @description pickle protocol バージョン
 */
export type Protocol = 3 | 4 | 5;

/**
 * @description JS 値を pickle opcode 列に再帰的にエンコードする
 * @param val - エンコード対象の値
 * @param w - 出力先 Writer
 * @param proto - 使用する protocol バージョン
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
 * @description protocol 4 以上のとき MEMOIZE opcode を出力する
 * @param w - 出力先 Writer
 * @param proto - 使用中の protocol バージョン
 */
function maybeMemoize(w: Writer, proto: Protocol) {
	if (proto >= 4) {
		w.byte(Op.MEMOIZE);
	}
}

/**
 * @description JS 値を pickle バイト列にシリアライズする
 * @param obj - シリアライズ対象
 * @param protocol - pickle protocol バージョン @defaultValue 4
 * @returns pickle バイト列
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
		// CPython が proto-5 と認識するためにゼロ長 FRAME を出力
		w.byte(Op.FRAME);
		w.uint64LE(0);
	}
	encodeValue(obj, w, protocol);
	w.byte(Op.STOP);
	return w.toUint8();
}

/**
 * @description pickle バイト列を JS 値にデシリアライズする
 * @param buf - pickle データ
 * @returns デシリアライズ済みの値
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

	// Symbol を使うことで MARK とユーザーデータを混同しない
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
