import { expect, test } from "vitest";
import {
	normalizePathSeparators,
	pathBasename,
	posixJoin,
	relativePosixPath,
} from "@/utils/path";

test("normalizePathSeparators converts Windows separators", () => {
	expect(normalizePathSeparators("a\\b/c")).toBe("a/b/c");
});

test("pathBasename normalizes separators and falls back to file", () => {
	expect(pathBasename("C:\\tmp\\data.txt")).toBe("data.txt");
	expect(pathBasename("/tmp/data.txt")).toBe("data.txt");
	expect(pathBasename("/")).toBe("file");
});

test("posixJoin creates absolute normalized paths", () => {
	expect(posixJoin("/root", "nested\\file.txt")).toBe("/root/nested/file.txt");
	expect(posixJoin("root/", "/nested/", "file.txt")).toBe(
		"/root/nested/file.txt",
	);
});

test("relativePosixPath returns normalized relative paths", () => {
	expect(relativePosixPath("C:\\tmp", "C:\\tmp\\nested\\file.txt")).toBe(
		"nested/file.txt",
	);
});
