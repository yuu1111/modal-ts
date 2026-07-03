import { expect, test } from "vitest";
import { InvalidError } from "@/core/errors";
import {
	hasListCapacity,
	listPageSize,
	resolveListPagination,
} from "@/utils/pagination";

test("resolveListPagination reads aliases and rejects negative maxObjects", () => {
	expect(
		resolveListPagination({ max_objects: 5, created_before: 123 }),
	).toEqual({
		maxObjects: 5,
		createdBefore: 123,
	});
	expect(() => resolveListPagination({ maxObjects: -1 })).toThrow(InvalidError);
});

test("listPageSize respects maxObjects and default page size", () => {
	expect(hasListCapacity(undefined, 100)).toBe(true);
	expect(hasListCapacity(10, 10)).toBe(false);
	expect(listPageSize(undefined, 0)).toBe(100);
	expect(listPageSize(10, 7)).toBe(3);
	expect(listPageSize(200, 0)).toBe(100);
});
