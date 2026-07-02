import { expect, test } from "vitest";
import { Dict } from "../../src/services/dict/dict";
import { Image } from "../../src/services/image/image";
import { NetworkFileSystem } from "../../src/services/network_file_system/network_file_system";
import { Queue } from "../../src/services/queue/queue";
import { Sandbox } from "../../src/services/sandbox/sandbox";
import { Secret } from "../../src/services/secret/secret";
import { Volume } from "../../src/services/volume/volume";

test("Python-style static Image factories are available", () => {
	expect(Image.from_registry("alpine:3.21")).toBeInstanceOf(Image);
	expect(Image.from_scratch()).toBeInstanceOf(Image);
	expect(Image.debian_slim()).toBeInstanceOf(Image);
	expect(Image.micromamba()).toBeInstanceOf(Image);
});

test("Python-style static resource helpers are available", () => {
	expect(Sandbox.create).toBeTypeOf("function");
	expect(Sandbox.from_id).toBeTypeOf("function");
	expect(Sandbox.from_name).toBeTypeOf("function");
	expect(Sandbox.list).toBeTypeOf("function");
	expect(Queue.ephemeral).toBeTypeOf("function");
	expect(Dict.ephemeral).toBeTypeOf("function");
	expect(Volume.ephemeral).toBeTypeOf("function");
	expect(Volume.rename).toBeTypeOf("function");
	expect(NetworkFileSystem.ephemeral).toBeTypeOf("function");
	expect(NetworkFileSystem.create_deployed).toBeTypeOf("function");
	expect(NetworkFileSystem.delete).toBeTypeOf("function");
	expect(Secret.prototype.update).toBeTypeOf("function");
});
