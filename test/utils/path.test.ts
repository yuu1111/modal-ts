import { expect, test } from "vitest";
import { pathBasename, posixJoin } from "@/utils/path";

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
