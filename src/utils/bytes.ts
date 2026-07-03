/**
 * Splits bytes into non-empty chunks of at most the given size.
 *
 * @param data - Bytes to split
 * @param size - Maximum chunk size
 * @returns Byte chunks, including one empty chunk for empty input
 */
export function chunkBytes(data: Uint8Array, size: number): Uint8Array[] {
	if (data.length === 0) return [new Uint8Array()];
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < data.length; offset += size) {
		chunks.push(data.subarray(offset, offset + size));
	}
	return chunks;
}

/**
 * Concatenates byte chunks into a single Uint8Array.
 *
 * @param chunks - Byte chunks
 * @returns Concatenated bytes
 */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
