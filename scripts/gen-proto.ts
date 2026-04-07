import { execSync } from "node:child_process";
import {
	existsSync,
	globSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname ?? process.cwd(), "..");
const isWindows = platform() === "win32";
const ext = isWindows ? ".exe" : "";

mkdirSync(join(root, "proto"), { recursive: true });

const protoc = join(root, "node_modules", "grpc-tools", "bin", `protoc${ext}`);
const grpcPlugin = join(
	root,
	"node_modules",
	"grpc-tools",
	"bin",
	`grpc_node_plugin${ext}`,
);
const tsProtoPlugin = join(
	root,
	"node_modules",
	".bin",
	`protoc-gen-ts_proto${ext}`,
);

const protoFiles = globSync("modal_proto/*.proto", {
	cwd: root,
});

execSync(
	[
		`"${protoc}"`,
		`--plugin=protoc-gen-grpc="${grpcPlugin}"`,
		`--plugin=protoc-gen-ts_proto="${tsProtoPlugin}"`,
		"--ts_proto_out=./proto",
		"--ts_proto_opt=outputServices=nice-grpc,outputServices=generic-definitions,useExactTypes=false",
		"--proto_path=.",
		...protoFiles.map((f) => f.replace(/\\/g, "/")),
	].join(" "),
	{ cwd: root, stdio: "inherit" },
);

// Add @ts-nocheck to all generated files.
const generatedFiles = globSync("proto/**/*.ts", { cwd: root });
for (const rel of generatedFiles) {
	const file = join(root, rel);
	const content = readFileSync(file, "utf-8");
	if (!content.includes("@ts-nocheck")) {
		writeFileSync(file, `// @ts-nocheck\n${content}`);
	}
}

// HACK: Patch for bad Protobuf codegen: fix the "Object" type conflicting with
// builtin `Object` API in JavaScript and breaking Protobuf import.
const apiFile = join(root, "proto", "modal_proto", "api.ts");
if (existsSync(apiFile)) {
	let api = readFileSync(apiFile, "utf-8");
	api = api.replace(/Object\.entries/g, "PLACEHOLDER_OBJECT_ENTRIES");
	api = api.replace(/\bObject\b/g, "Object_");
	api = api.replace(/PLACEHOLDER_OBJECT_ENTRIES/g, "Object.entries");
	writeFileSync(apiFile, api);
}
