import { ClientError, Status } from "nice-grpc";
import { expect, onTestFinished, test } from "vitest";
import { NotFoundError } from "../../../src/core/errors";
import {
	Volume,
	volumeToMountProto,
} from "../../../src/services/volume/volume";
import { createMockModalClients } from "../../support/grpc_mock";
import { tc } from "../../support/test-client";

test("Volume.fromName", async () => {
	const volume = await tc.volumes.fromName("libmodal-test-volume", {
		createIfMissing: true,
	});
	expect(volume.volumeId).toMatch(/^vo-/);
	expect(volume.name).toBe("libmodal-test-volume");

	const promise = tc.volumes.fromName("missing-volume");
	await expect(promise).rejects.toThrowError(
		/Volume 'missing-volume' not found/,
	);
});

test("Volume.readOnly", async () => {
	const volume = await tc.volumes.fromName("libmodal-test-volume", {
		createIfMissing: true,
	});

	expect(volume.isReadOnly).toBe(false);

	const readOnlyVolume = volume.readOnly();
	expect(readOnlyVolume.isReadOnly).toBe(true);
	expect(readOnlyVolume.volumeId).toBe(volume.volumeId);
	expect(readOnlyVolume.name).toBe(volume.name);

	expect(volume.isReadOnly).toBe(false);
});

test("Volume.withMountOptions", () => {
	const volume = new Volume("vo-test", "test-volume");

	const scoped = volume.withMountOptions({
		readOnly: true,
		subPath: "/users/alice",
	});

	expect(scoped.isReadOnly).toBe(true);
	expect(volume.isReadOnly).toBe(false);
	expect(volumeToMountProto("/mnt/data", scoped)).toMatchObject({
		volumeId: "vo-test",
		mountPath: "/mnt/data",
		allowBackgroundCommits: true,
		readOnly: true,
		subPath: "/users/alice",
	});

	const wholeVolume = scoped.withMountOptions({ subPath: "/" });
	expect(volumeToMountProto("/mnt/data", wholeVolume).subPath).toBeUndefined();
});

test("VolumeEphemeral", async () => {
	const volume = await tc.volumes.ephemeral();
	onTestFinished(() => volume.closeEphemeral());

	expect(volume.name).toBeUndefined();
	expect(volume.volumeId).toMatch(/^vo-/);
	expect(volume.isReadOnly).toBe(false);
	expect(volume.readOnly().isReadOnly).toBe(true);
});

test("VolumeDelete success", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/VolumeGetOrCreate", () => ({
		volumeId: "vo-test-123",
		metadata: { name: "test-volume" },
	}));

	mock.handleUnary("/VolumeDelete", (req: unknown) => {
		expect((req as Record<string, unknown>).volumeId).toBe("vo-test-123");
		return {};
	});

	await mc.volumes.delete("test-volume");
	mock.assertExhausted();
});

test("VolumeDelete with allowMissing=true", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/VolumeGetOrCreate", () => {
		throw new NotFoundError("Volume 'missing' not found");
	});

	await mc.volumes.delete("missing", { allowMissing: true });
	mock.assertExhausted();
});

test("VolumeDelete with allowMissing=true when delete RPC returns NOT_FOUND", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	// fromName succeeds — volume exists at lookup time
	mock.handleUnary("/VolumeGetOrCreate", () => ({
		volumeId: "vo-test-123",
		metadata: { name: "test-volume" },
	}));

	// volumeDelete fails — volume was deleted between lookup and delete
	mock.handleUnary("/VolumeDelete", () => {
		throw new ClientError(
			"/modal.client.ModalClient/VolumeDelete",
			Status.NOT_FOUND,
			"No Volume with ID 'vo-test-123' found",
		);
	});

	// With allowMissing=true, this should succeed silently
	await mc.volumes.delete("test-volume", { allowMissing: true });
	mock.assertExhausted();
});

test("VolumeDelete with allowMissing=false throws", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/VolumeGetOrCreate", () => {
		throw new NotFoundError("Volume 'missing' not found");
	});

	await expect(
		mc.volumes.delete("missing", { allowMissing: false }),
	).rejects.toThrow(NotFoundError);
});

test("VolumeRename", async () => {
	const { mockClient: mc, mockCpClient: mock } = createMockModalClients();

	mock.handleUnary("/VolumeGetOrCreate", (req) => {
		expect(req).toMatchObject({
			deploymentName: "old-volume",
			environmentName: "prod",
			objectCreationType: 0,
		});
		return {
			volumeId: "vo-test-123",
			metadata: { name: "old-volume" },
		};
	});

	mock.handleUnary("/VolumeRename", (req) => {
		expect(req).toMatchObject({
			volumeId: "vo-test-123",
			name: "new-volume",
		});
		return {};
	});

	await mc.volumes.rename("old-volume", "new-volume", { environment: "prod" });
	mock.assertExhausted();
});
