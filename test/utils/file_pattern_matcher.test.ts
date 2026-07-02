import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { FilePatternMatcher } from "../../src/utils/file_pattern_matcher";

test("FilePatternMatcher matches patterns and exclusions", () => {
	const matcher = new FilePatternMatcher("*.py", "build", "!keep.py");

	expect(matcher.matches("foo.py")).toBe(true);
	expect(matcher.matches("build/output.txt")).toBe(true);
	expect(matcher.matches("keep.py")).toBe(false);
	expect(matcher.canPruneDirectories()).toBe(false);
	expect(matcher.invert().matches("foo.py")).toBe(false);
});

test("FilePatternMatcher fromFile", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "modal-pattern-"));
	const file = path.join(dir, ".modalignore");
	writeFileSync(file, "*.ts\n");

	try {
		const matcher = FilePatternMatcher.from_file(file);
		expect(matcher.matches("index.ts")).toBe(true);
		expect(matcher.matches("index.js")).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("FilePatternMatcher double-star slash also matches top-level files", () => {
	const matcher = new FilePatternMatcher("**/*.py");

	expect(matcher.matches("main.py")).toBe(true);
	expect(matcher.matches("pkg/main.py")).toBe(true);
	expect(matcher.matches("pkg/nested/main.py")).toBe(true);
	expect(matcher.matches("main.ts")).toBe(false);
	expect(matcher.can_prune_directories()).toBe(true);
});
