import { expect, test } from "vitest";
import { collectAsync } from "@/utils/async_iterable";

async function* numbers(): AsyncGenerator<number, void, unknown> {
	yield 1;
	yield 2;
	yield 3;
}

test("collectAsync collects async iterable values", async () => {
	expect(await collectAsync(numbers())).toEqual([1, 2, 3]);
});
