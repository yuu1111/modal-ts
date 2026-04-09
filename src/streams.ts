/**
 * @description `ReadableStream` に便利なメソッドを追加したラッパーインターフェース
 *
 * `.readText()` でストリーム全体を文字列として読み取り、
 * `.readBytes()` でバイナリデータとして読み取ることができる。
 *
 * Background: https://developer.mozilla.org/en-US/docs/Web/API/Streams_API
 */
export interface ModalReadStream<R = unknown> extends ReadableStream<R> {
	/**
	 * @description ストリーム全体を文字列として読み取る
	 */
	readText(): Promise<string>;

	/**
	 * @description ストリーム全体をバイト配列として読み取る
	 */
	readBytes(): Promise<Uint8Array>;
}

/**
 * @description `WritableStream` に便利なメソッドを追加したラッパーインターフェース
 *
 * `.writeText()` で文字列を書き込み、
 * `.writeBytes()` でバイナリデータを書き込むことができる。
 *
 * Background: https://developer.mozilla.org/en-US/docs/Web/API/Streams_API
 */
export interface ModalWriteStream<R = unknown> extends WritableStream<R> {
	/**
	 * @description テキストストリームに文字列を書き込む
	 * @param text - 書き込む文字列
	 */
	writeText(text: string): Promise<void>;

	/**
	 * @description バイトストリームにバイト配列を書き込む
	 * @param bytes - 書き込むバイト配列
	 */
	writeBytes(bytes: Uint8Array): Promise<void>;
}

/**
 * @description ReadableStream を ModalReadStream に変換する
 * @param stream - 変換元の ReadableStream
 * @returns 便利メソッド付きの ModalReadStream
 */
export function toModalReadStream<
	R extends string | Uint8Array = string | Uint8Array,
>(stream: ReadableStream<R>): ModalReadStream<R> {
	return Object.assign(stream, readMixin);
}

/**
 * @description WritableStream を ModalWriteStream に変換する
 * @param stream - 変換元の WritableStream
 * @returns 便利メソッド付きの ModalWriteStream
 */
export function toModalWriteStream<
	R extends string | Uint8Array = string | Uint8Array,
>(stream: WritableStream<R>): ModalWriteStream<R> {
	return Object.assign(stream, writeMixin);
}

/**
 * @description ModalReadStream に追加する読み取り用メソッド群
 */
const readMixin = {
	async readText<R extends string | Uint8Array>(
		this: ReadableStream<R>,
	): Promise<string> {
		const reader = this.getReader();
		try {
			const decoder = new TextDecoder("utf-8"); // used if binary
			const chunks: string[] = [];
			while (true) {
				const { value, done } = await reader.read();
				if (value) {
					if (typeof value === "string") chunks.push(value);
					else {
						chunks.push(
							decoder.decode(value.buffer as ArrayBuffer, { stream: true }),
						);
					}
				}
				if (done) {
					chunks.push(decoder.decode(undefined, { stream: false })); // may be empty
					break;
				}
			}
			return chunks.join("");
		} finally {
			reader.releaseLock();
		}
	},

	async readBytes<R extends string | Uint8Array>(
		this: ReadableStream<R>,
	): Promise<Uint8Array> {
		const chunks: Uint8Array[] = [];
		const reader = this.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (value) {
					if (typeof value === "string") {
						chunks.push(new TextEncoder().encode(value));
					} else {
						chunks.push(value);
					}
				}
				if (done) break;
			}
		} finally {
			reader.releaseLock();
		}

		let totalLength = 0;
		for (const chunk of chunks) {
			totalLength += chunk.length;
		}
		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	},
};

/**
 * @description ModalWriteStream に追加する書き込み用メソッド群
 */
const writeMixin = {
	async writeText<R extends string | Uint8Array>(
		this: WritableStream<R>,
		text: string,
	): Promise<void> {
		const writer = this.getWriter();
		try {
			// Cast to R so TS is happy; underlying sink must accept strings
			await writer.write(text as unknown as R);
		} finally {
			writer.releaseLock();
		}
	},

	async writeBytes<R extends string | Uint8Array>(
		this: WritableStream<R>,
		bytes: Uint8Array,
	): Promise<void> {
		const writer = this.getWriter();
		try {
			// Cast to R so TS is happy; underlying sink must accept Uint8Array
			await writer.write(bytes as unknown as R);
		} finally {
			writer.releaseLock();
		}
	},
};

/**
 * @description AsyncIterable から ReadableStream を構築する
 *
 * ストリームがキャンセルされた場合、イテレータの return() を呼び出して
 * ソース側のクリーンアップを即座に行う。
 * @param iterable - 変換元の非同期イテラブル
 * @param onCancel - キャンセル時に呼ばれるコールバック
 * @returns バイトストリーム
 */
export function streamConsumingIter(
	iterable: AsyncIterable<Uint8Array>,
	onCancel?: () => void,
): ReadableStream<Uint8Array> {
	const iter = iterable[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				const { done, value } = await iter.next();
				if (value) {
					controller.enqueue(value);
				}
				if (done) {
					controller.close();
				}
			},
			async cancel() {
				try {
					onCancel?.();
				} finally {
					// Propagate cancellation upstream and run source cleanup.
					// return() is optional on AsyncIterator, so guard before calling.
					if (typeof iter.return === "function") {
						await iter.return();
					}
				}
			},
		},
		new ByteLengthQueuingStrategy({
			highWaterMark: 64 * 1024, // 64 KiB
		}),
	);
}
