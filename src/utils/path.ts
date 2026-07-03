/**
 * Returns the final path segment after normalizing Windows separators.
 *
 * @param value - Path-like value
 * @returns Final path segment, or "file" when no segment is present
 */
export function pathBasename(value: string): string {
	return value.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? "file";
}

/**
 * Joins path segments into an absolute POSIX-style path.
 *
 * @param parts - Path segments
 * @returns Absolute path using forward slashes
 */
export function posixJoin(...parts: string[]): string {
	return `/${parts
		.join("/")
		.replaceAll("\\", "/")
		.split("/")
		.filter((part) => part.length > 0)
		.join("/")}`;
}
