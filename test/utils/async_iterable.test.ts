import { expect, test } from "vitest";
import { collectAsync, collectMappedAsync } from "@/utils/async_iterable";

async function* numbers(): AsyncGenerator<number, void, unknown> {
	yield 1;
	yield 2;
	yield 3;
}

test("collectAsync collects async iterable values", async () => {
	expect(await collectAsync(numbers())).toEqual([1, 2, 3]);
});

test("collectMappedAsync maps and collects async iterable values", async () => {
	expect(await collectMappedAsync(numbers(), (value) => value * 2)).toEqual([
		2, 4, 6,
	]);
});
