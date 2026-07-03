/**
 * Collects all values from an async iterable.
 *
 * @param iterable - Values to collect
 * @returns Collected values
 */
export async function collectAsync<T>(
	iterable: AsyncIterable<T>,
): Promise<T[]> {
	const values: T[] = [];
	for await (const value of iterable) values.push(value);
	return values;
}

/**
 * Collects all values from an async iterable after mapping each value.
 *
 * @param iterable - Values to collect
 * @param mapper - Mapping function
 * @returns Mapped values
 */
export async function collectMappedAsync<T, U>(
	iterable: AsyncIterable<T>,
	mapper: (value: T) => U,
): Promise<U[]> {
	const values: U[] = [];
	for await (const value of iterable) values.push(mapper(value));
	return values;
}
