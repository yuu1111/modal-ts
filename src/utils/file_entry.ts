import type { FileEntry } from "@/generated/modal_proto/api";

/**
 * Common file entry shape returned by storage-like resources.
 */
export type ResourceFileEntry = {
	path: string;
	type: number;
	mtime: number;
	size: number;
};

/**
 * Converts a file entry proto into a public file entry.
 *
 * @param entry - File entry proto
 * @returns Public file entry
 */
export function resourceFileEntryFromProto<T extends ResourceFileEntry>(
	entry: FileEntry,
): T {
	return {
		path: entry.path,
		type: entry.type,
		mtime: entry.mtime,
		size: entry.size,
	} as T;
}
