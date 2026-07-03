import { expect, test } from "vitest";
import { chunkBytes, concatBytes, sha256Bytes, sha256Hex } from "@/utils/bytes";

test("chunkBytes splits bytes and preserves an empty chunk for empty input", () => {
	expect(chunkBytes(new Uint8Array(), 4)).toEqual([new Uint8Array()]);
	expect(chunkBytes(new Uint8Array([1, 2, 3, 4, 5]), 2)).toEqual([
		new Uint8Array([1, 2]),
		new Uint8Array([3, 4]),
		new Uint8Array([5]),
	]);
});

test("concatBytes joins byte chunks", () => {
	expect(concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])])).toEqual(
		new Uint8Array([1, 2, 3]),
	);
	expect(concatBytes([])).toEqual(new Uint8Array());
});

test("sha256 helpers return bytes and hex", async () => {
	const data = new TextEncoder().encode("modal");
	expect(await sha256Bytes(data)).toEqual(
		new Uint8Array([
			197, 128, 58, 110, 77, 170, 106, 244, 0, 232, 175, 10, 228, 23, 255, 109,
			124, 85, 168, 109, 17, 186, 74, 12, 246, 212, 67, 193, 92, 230, 250, 197,
		]),
	);
	expect(await sha256Hex(data)).toBe(
		"c5803a6e4daa6af400e8af0ae417ff6d7c55a86d11ba4a0cf6d443c15ce6fac5",
	);
});
