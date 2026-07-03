import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Predicate that decides whether a local path should be skipped.
 */
export type LocalFileIgnorePredicate = (
	rootPath: string,
	filePath: string,
) => boolean;

/**
 * Recursively walks regular files under a local directory.
 *
 * @param dir - Directory to walk
 * @param ignore - Optional ignore predicate
 * @param rootPath - Root directory used for ignore predicates
 * @returns Local file paths
 */
export async function* walkLocalFiles(
	dir: string,
	ignore?: LocalFileIgnorePredicate,
	rootPath = dir,
): AsyncGenerator<string, void, unknown> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (ignore?.(rootPath, entryPath)) {
			continue;
		}
		if (entry.isDirectory()) {
			yield* walkLocalFiles(entryPath, ignore, rootPath);
		} else if (entry.isFile()) {
			yield entryPath;
		}
	}
}
