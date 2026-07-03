/**
 * @description Wrapper interface that adds convenience methods to `ReadableStream`
 *
 * `.readText()` reads the entire stream as a string,
 * and `.readBytes()` reads it as binary data.
 *
 * Background: https://developer.mozilla.org/en-US/docs/Web/API/Streams_API
 */
export interface ModalReadStream<R = unknown> extends ReadableStream<R> {
	/**
	 * @description Reads the entire stream as a string
	 */
	readText(): Promise<string>;

	/**
	 * @description Reads the entire stream as bytes
	 */
	readBytes(): Promise<Uint8Array>;
}

/**
 * @description Wrapper interface that adds convenience methods to `WritableStream`
 *
 * `.writeText()` writes a string,
 * and `.writeBytes()` writes binary data.
 *
 * Background: https://developer.mozilla.org/en-US/docs/Web/API/Streams_API
 */
export interface ModalWriteStream<R = unknown> extends WritableStream<R> {
	/**
	 * @description Writes a string to a text stream
	 * @param text - String to write
	 */
	writeText(text: string): Promise<void>;

	/**
	 * @description Writes bytes to a byte stream
	 * @param bytes - Bytes to write
	 */
	writeBytes(bytes: Uint8Array): Promise<void>;
}

/**
 * @description Converts a ReadableStream into a ModalReadStream
 * @param stream - Source ReadableStream
 * @returns ModalReadStream with convenience methods
 */
export function toModalReadStream<
	R extends string | Uint8Array = string | Uint8Array,
>(stream: ReadableStream<R>): ModalReadStream<R> {
	return Object.assign(stream, readMixin);
}

/**
 * @description Converts a WritableStream into a ModalWriteStream
 * @param stream - Source WritableStream
 * @returns ModalWriteStream with convenience methods
 */
export function toModalWriteStream<
	R extends string | Uint8Array = string | Uint8Array,
>(stream: WritableStream<R>): ModalWriteStream<R> {
	return Object.assign(stream, writeMixin);
}

/**
 * @description Converts strings to UTF-8 bytes and returns Uint8Array values unchanged
 * @param chunk - Value to convert
 * @returns Bytes
 */
export function encodeIfString(chunk: Uint8Array | string): Uint8Array {
	return typeof chunk === "string" ? encoder.encode(chunk) : chunk;
}

/**
 * @description Module-shared TextEncoder instance
 */
const encoder = new TextEncoder();

/**
 * @description Read methods added to ModalReadStream
 */
const readMixin = {
	async readText<R extends string | Uint8Array>(
		this: ReadableStream<R>,
	): Promise<string> {
		const decoder = new TextDecoder("utf-8");
		const parts: string[] = [];
		const reader = this.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (value !== undefined) {
					if (typeof value === "string") parts.push(value);
					else parts.push(decoder.decode(value, { stream: true }));
				}
				if (done) break;
			}
		} finally {
			reader.releaseLock();
		}
		const flushed = decoder.decode();
		if (flushed) parts.push(flushed);
		return parts.join("");
	},

	async readBytes<R extends string | Uint8Array>(
		this: ReadableStream<R>,
	): Promise<Uint8Array> {
		const chunks: Uint8Array[] = [];
		let totalLength = 0;
		const reader = this.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (value !== undefined) {
					const chunk = encodeIfString(value as string | Uint8Array);
					chunks.push(chunk);
					totalLength += chunk.byteLength;
				}
				if (done) break;
			}
		} finally {
			reader.releaseLock();
		}
		if (chunks.length === 1) return new Uint8Array(chunks[0] as Uint8Array);
		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return result;
	},
};

/**
 * @description One-shot write helper that acquires and releases a writer lock per call
 * @param stream - Destination WritableStream
 * @param chunk - Data to write
 */
async function writeChunk<R>(
	stream: WritableStream<R>,
	chunk: string | Uint8Array,
): Promise<void> {
	const writer = stream.getWriter();
	try {
		await writer.write(chunk as unknown as R);
	} finally {
		writer.releaseLock();
	}
}

/**
 * @description Write methods added to ModalWriteStream
 */
const writeMixin = {
	async writeText<R extends string | Uint8Array>(
		this: WritableStream<R>,
		text: string,
	): Promise<void> {
		await writeChunk(this, text);
	},

	async writeBytes<R extends string | Uint8Array>(
		this: WritableStream<R>,
		bytes: Uint8Array,
	): Promise<void> {
		await writeChunk(this, bytes);
	},
};

/**
 * @description Builds a ReadableStream from an AsyncIterable
 *
 * When the stream is cancelled, calls the iterator's return() method
 * so the source can clean up immediately.
 * @param iterable - Source async iterable
 * @param onCancel - Callback invoked on cancellation
 * @returns Byte stream
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
