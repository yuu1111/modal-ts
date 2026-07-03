import path from "node:path";

/**
 * Normalizes Windows path separators to POSIX separators.
 *
 * @param value - Path-like value
 * @returns Path-like value using forward slashes
 */
export function normalizePathSeparators(value: string): string {
	return value.replaceAll("\\", "/");
}

/**
 * Returns the final path segment after normalizing Windows separators.
 *
 * @param value - Path-like value
 * @returns Final path segment, or "file" when no segment is present
 */
export function pathBasename(value: string): string {
	return (
		normalizePathSeparators(value).split("/").filter(Boolean).pop() ?? "file"
	);
}

/**
 * Joins path segments into an absolute POSIX-style path.
 *
 * @param parts - Path segments
 * @returns Absolute path using forward slashes
 */
export function posixJoin(...parts: string[]): string {
	return `/${normalizePathSeparators(parts.join("/"))
		.split("/")
		.filter((part) => part.length > 0)
		.join("/")}`;
}

/**
 * Calculates a relative path with POSIX separators.
 *
 * @param from - Base path
 * @param to - Target path
 * @returns Relative path using forward slashes
 */
export function relativePosixPath(from: string, to: string): string {
	return normalizePathSeparators(path.relative(from, to));
}
