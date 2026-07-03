import { expect, test } from "vitest";
import { chunkBytes, concatBytes } from "@/utils/bytes";

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
