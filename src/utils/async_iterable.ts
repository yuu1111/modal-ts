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
