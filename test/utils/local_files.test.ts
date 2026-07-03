import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { walkLocalFiles } from "@/utils/local_files";
import { relativePosixPath } from "@/utils/path";

test("walkLocalFiles recursively yields files and applies ignore predicates", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "modal-local-files-"));
	try {
		await writeFile(path.join(dir, "a.txt"), "a");
		await mkdir(path.join(dir, "nested"));
		await writeFile(path.join(dir, "nested", "b.txt"), "b");

		const files: string[] = [];
		for await (const file of walkLocalFiles(dir, (_root, filePath) =>
			filePath.endsWith("b.txt"),
		)) {
			files.push(relativePosixPath(dir, file));
		}

		expect(files).toEqual(["a.txt"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
