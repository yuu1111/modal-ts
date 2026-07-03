import { InvalidError } from "@/core/errors";
import { aliasedNumber } from "@/utils/param_aliases";

/**
 * List pagination aliases shared by resource listing APIs.
 */
export type ListPaginationParams = {
	maxObjects?: number;
	max_objects?: number;
	createdBefore?: number;
	created_before?: number;
};

/**
 * Resolved list pagination options.
 */
export type ResolvedListPagination = {
	maxObjects: number | undefined;
	createdBefore: number;
};

/**
 * Resolves list pagination aliases and validates maxObjects.
 *
 * @param params - List parameters
 * @returns Resolved pagination options
 */
export function resolveListPagination(
	params: ListPaginationParams,
): ResolvedListPagination {
	const maxObjects = aliasedNumber(params, "maxObjects", "max_objects");
	if (maxObjects !== undefined && maxObjects < 0) {
		throw new InvalidError("maxObjects cannot be negative");
	}
	return {
		maxObjects,
		createdBefore:
			aliasedNumber(params, "createdBefore", "created_before") ?? 0,
	};
}

/**
 * Checks whether another page should be fetched.
 *
 * @param maxObjects - Maximum object count
 * @param currentLength - Number of objects collected so far
 * @returns True when another page can be fetched
 */
export function hasListCapacity(
	maxObjects: number | undefined,
	currentLength: number,
): boolean {
	return maxObjects === undefined || currentLength < maxObjects;
}

/**
 * Computes the next page size for a list request.
 *
 * @param maxObjects - Maximum object count
 * @param currentLength - Number of objects collected so far
 * @param defaultPageSize - Page size to use when maxObjects is unlimited
 * @returns Next page size
 */
export function listPageSize(
	maxObjects: number | undefined,
	currentLength: number,
	defaultPageSize = 100,
): number {
	return maxObjects === undefined
		? defaultPageSize
		: Math.min(defaultPageSize, maxObjects - currentLength);
}
