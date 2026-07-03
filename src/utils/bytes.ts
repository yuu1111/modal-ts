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

/**
 * Calculates a SHA-256 digest.
 *
 * @param data - Bytes to hash
 * @returns SHA-256 digest bytes
 */
export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/**
 * Calculates a SHA-256 digest encoded as lowercase hex.
 *
 * @param data - Bytes to hash
 * @returns SHA-256 digest as hex
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await sha256Bytes(data);
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads a fetch response body as bytes and validates success status.
 *
 * @param response - Fetch response
 * @param errorPrefix - Prefix for non-success status errors
 * @returns Response body bytes
 */
export async function responseBytes(
	response: Response,
	errorPrefix: string,
): Promise<Uint8Array> {
	if (!response.ok) {
		throw new Error(`${errorPrefix} with ${response.status}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}
