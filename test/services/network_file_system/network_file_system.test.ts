import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createMockModalClients } from "../../support/grpc_mock";

test("NetworkFileSystemService.fromName and file operations", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/SharedVolumeGetOrCreate", (req) => {
		expect(req.deploymentName).toBe("test-nfs");
		expect(req.environmentName).toBe("dev");
		expect(req.objectCreationType).toBe(1);
		return { sharedVolumeId: "sv-test" };
	});

	mock.handleUnary("/SharedVolumePutFile", (req) => {
		expect(req.sharedVolumeId).toBe("sv-test");
		expect(req.path).toBe("/hello.txt");
		expect(req.data).toEqual(new Uint8Array([104, 105]));
		return { exists: true };
	});

	mock.handleUnary("/SharedVolumeGetFile", (req) => {
		expect(req.sharedVolumeId).toBe("sv-test");
		expect(req.path).toBe("/hello.txt");
		return { data: new Uint8Array([104, 105]) };
	});

	mock.handleUnary("/SharedVolumeGetFile", (req) => {
		expect(req.sharedVolumeId).toBe("sv-test");
		expect(req.path).toBe("/large.bin");
		return { dataBlobId: "bl-large" };
	});

	mock.handleUnary("/BlobGet", (req) => {
		expect(req.blobId).toBe("bl-large");
		return { downloadUrl: "https://blob.test/large.bin" };
	});

	const nfs = await mc.networkFileSystems.fromName("test-nfs", {
		create_if_missing: true,
		environment_name: "dev",
	});
	await nfs.writeFile("/hello.txt", new TextEncoder().encode("hi"));
	expect(new TextDecoder().decode(await nfs.readFile("/hello.txt"))).toBe("hi");
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		if (url === "https://blob.test/large.bin") {
			return new Response(new Uint8Array([1, 2, 3]));
		}
		return originalFetch(input);
	};
	try {
		expect(await nfs.readFile("/large.bin")).toEqual(new Uint8Array([1, 2, 3]));
	} finally {
		globalThis.fetch = originalFetch;
	}
	mock.assertExhausted();
});

test("NetworkFileSystem.addLocalDir uploads files recursively", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();
	const dir = await mkdtemp(path.join(tmpdir(), "modal-nfs-"));
	try {
		await writeFile(path.join(dir, "a.txt"), "a");
		await mkdir(path.join(dir, "nested"), { recursive: true });
		await writeFile(path.join(dir, "nested", "b.txt"), "bb");

		mock.handleUnary("/SharedVolumeGetOrCreate", () => ({
			sharedVolumeId: "sv-test",
		}));
		mock.handleUnary("/SharedVolumePutFile", (req) => {
			expect(req.path).toBe("/remote/a.txt");
			expect(Array.from(req.data as Uint8Array)).toEqual([97]);
			return { exists: true };
		});
		mock.handleUnary("/SharedVolumePutFile", (req) => {
			expect(req.path).toBe("/remote/nested/b.txt");
			expect(Array.from(req.data as Uint8Array)).toEqual([98, 98]);
			return { exists: true };
		});

		const nfs = await mc.networkFileSystems.fromName("test-nfs");
		await expect(nfs.addLocalDir(dir, "/remote")).resolves.toBe(3);
		mock.assertExhausted();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
