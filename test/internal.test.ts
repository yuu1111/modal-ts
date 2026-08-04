import { expect, test } from "vitest";
import {
	Empty,
	GenericResult_GenericStatus,
	Image,
	ModalClientDefinition,
	type ModalGrpcClient,
	Timestamp,
} from "../src/internal";

test("internal exposes generated proto classes with factory helpers", () => {
	expect(typeof Image.create).toBe("function");
	expect(Image.create({ dockerfileCommands: ["FROM base"] })).toMatchObject({
		dockerfileCommands: ["FROM base"],
	});
	expect(GenericResult_GenericStatus.GENERIC_STATUS_FAILURE).toBe(2);
});

test("internal re-exports well-known google protobuf types", async () => {
	expect(Empty).toBeDefined();
	expect(typeof Timestamp.create).toBe("function");
});

test("internal exposes the raw gRPC service definition and client type", () => {
	expect(typeof ModalClientDefinition.fullName).toBe("string");
	expect(ModalClientDefinition.methods.imageGetOrCreate).toBeDefined();
	expect(ModalClientDefinition.methods.imageJoinStreaming).toBeDefined();
	// Type-only export must be usable as a type annotation.
	const _check: ModalGrpcClient | undefined = undefined;
	expect(_check).toBeUndefined();
});
