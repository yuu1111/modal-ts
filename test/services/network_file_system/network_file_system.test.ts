import { expect, test } from "vitest";
import { createMockModalClients } from "../../support/grpc_mock";

test("NetworkFileSystemService.fromName and file operations", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/SharedVolumeGetOrCreate", (req) => {
		expect(req.deploymentName).toBe("test-nfs");
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

	const nfs = await mc.networkFileSystems.fromName("test-nfs");
	await nfs.writeFile("/hello.txt", new TextEncoder().encode("hi"));
	expect(new TextDecoder().decode(await nfs.readFile("/hello.txt"))).toBe("hi");
	mock.assertExhausted();
});
