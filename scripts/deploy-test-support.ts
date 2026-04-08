/**
 * Test support setup script — deploys test resources to Modal.
 * Replaces the former Python-based setup.sh + test_support.py.
 *
 * Usage: bun test-support/setup.ts
 */

import { ModalClient } from "../src/client";
import {
	createMount,
	createSecret,
	deployApp,
	getOrCreateImage,
} from "../src/deploy";
import { WebhookType } from "../src/generated/modal_proto/api";

const TEST_SUPPORT_PY = `\
import os
import time
import typing

import modal

app = modal.App("libmodal-test-support")


@app.function(min_containers=1, _experimental_restrict_output=True)
def echo_string(s: str) -> str:
    return "output: " + s


@app.function(min_containers=1, _experimental_restrict_output=True)
def identity_with_repr(s: typing.Any) -> typing.Any:
    return s, repr(s)


@app.function(min_containers=1)
def sleep(t: int) -> None:
    time.sleep(t)


@app.function(min_containers=1)
def bytelength(buf: bytes) -> int:
    return len(buf)


@app.function(min_containers=1, experimental_options={"input_plane_region": "us-west"})
def input_plane(s: str) -> str:
    return "output: " + s


@app.cls(min_containers=1)
class EchoCls:
    @modal.method()
    def echo_string(self, s: str) -> str:
        return "output: " + s


@app.cls(min_containers=1, experimental_options={"input_plane_region": "us-west"})
class EchoClsInputPlane:
    @modal.method()
    def echo_string(self, s: str) -> str:
        return "output: " + s


@app.cls()
class EchoClsParametrized:
    name: str = modal.parameter(default="test")

    @modal.method()
    def echo_parameter(self) -> str:
        return "output: " + self.name

    @modal.method()
    def echo_env_var(self, var_name: str) -> str:
        return f"output: {var_name}='{os.getenv(var_name, '[not set]')}'"


@app.function(image=modal.Image.debian_slim().pip_install("fastapi"))
@modal.fastapi_endpoint()
def web_endpoint_echo(s: str) -> str:
    return "output: " + s
`;

const TEST_SUPPORT_1_1_PY = `\
import typing

import modal

app = modal.App("test-support-1-1")


@app.function(min_containers=1)
def identity_with_repr(s: typing.Any) -> typing.Any:
    return s, repr(s)
`;

/**
 * @description AWS Secrets Manager からシークレットを取得してModal Secretに登録
 */
async function createAwsSecrets(client: ModalClient) {
	const { SecretsManagerClient, GetSecretValueCommand } = await import(
		"@aws-sdk/client-secrets-manager"
	);
	const sm = new SecretsManagerClient({});

	async function getAwsSecret(
		secretId: string,
	): Promise<Record<string, string>> {
		const resp = await sm.send(
			new GetSecretValueCommand({ SecretId: secretId }),
		);
		if (!resp.SecretString) throw new Error(`Secret ${secretId} has no value`);
		return JSON.parse(resp.SecretString);
	}

	const ecrSecret = await getAwsSecret("test/libmodal/AwsEcrTest");
	await createSecret(client, "libmodal-aws-ecr-test", {
		AWS_ACCESS_KEY_ID: ecrSecret.AWS_ACCESS_KEY_ID,
		AWS_SECRET_ACCESS_KEY: ecrSecret.AWS_SECRET_ACCESS_KEY,
		AWS_REGION: "us-east-1",
	});
	console.log("  Created 'libmodal-aws-ecr-test'");

	const gcpSecret = await getAwsSecret("test/libmodal/GcpArtifactRegistryTest");
	await createSecret(client, "libmodal-gcp-artifact-registry-test", {
		SERVICE_ACCOUNT_JSON: gcpSecret.SERVICE_ACCOUNT_JSON,
		REGISTRY_USERNAME: "_json_key",
		REGISTRY_PASSWORD: gcpSecret.SERVICE_ACCOUNT_JSON,
	});
	console.log("  Created 'libmodal-gcp-artifact-registry-test'");

	const anthropicSecret = await getAwsSecret("dev/libmodal/AnthropicApiKey");
	await createSecret(client, "libmodal-anthropic-secret", {
		ANTHROPIC_API_KEY: anthropicSecret.ANTHROPIC_API_KEY,
	});
	console.log("  Created 'libmodal-anthropic-secret'");
}

async function main() {
	const client = new ModalClient();

	console.log("Creating secret 'libmodal-test-secret'...");
	await createSecret(client, "libmodal-test-secret", {
		a: "1",
		b: "2",
		c: "hello world",
	});

	if (process.env.AWS_REGION) {
		console.log("Creating AWS-based secrets...");
		await createAwsSecrets(client);
	} else {
		console.log(
			"Skipping AWS-based secrets (AWS_REGION not set). Set AWS credentials to create ECR/GCP/Anthropic secrets.",
		);
	}

	console.log("Deploying 'libmodal-test-support'...");
	const mountId = await createMount(client.cpClient, "", [
		{ remotePath: "/root/test_support.py", content: TEST_SUPPORT_PY },
	]);

	const defaultImageId = await getOrCreateImage(client.cpClient, "");
	const fastapiImageId = await getOrCreateImage(client.cpClient, "", [
		"RUN pip install fastapi",
	]);

	await deployApp(client, {
		name: "libmodal-test-support",
		functions: [
			{
				functionName: "echo_string",
				moduleName: "test_support",
				mountIds: [mountId],
				imageId: defaultImageId,
				minContainers: 1,
			},
			{
				functionName: "identity_with_repr",
				moduleName: "test_support",
				mountIds: [mountId],
				imageId: defaultImageId,
				minContainers: 1,
			},
			{
				functionName: "sleep",
				moduleName: "test_support",
				mountIds: [mountId],
				imageId: defaultImageId,
				minContainers: 1,
			},
			{
				functionName: "bytelength",
				moduleName: "test_support",
				mountIds: [mountId],
				imageId: defaultImageId,
				minContainers: 1,
			},
			{
				functionName: "input_plane",
				moduleName: "test_support",
				mountIds: [mountId],
				imageId: defaultImageId,
				minContainers: 1,
				experimentalOptions: { input_plane_region: "us-west" },
			},
			{
				functionName: "web_endpoint_echo",
				moduleName: "test_support",
				mountIds: [mountId],
				imageId: fastapiImageId,
				webhookConfig: {
					type: WebhookType.WEBHOOK_TYPE_FUNCTION,
					method: "GET",
				},
			},
		],
		classes: [
			{
				className: "EchoCls",
				moduleName: "test_support",
				methods: ["echo_string"],
				mountIds: [mountId],
				imageId: defaultImageId,
				minContainers: 1,
			},
			{
				className: "EchoClsInputPlane",
				moduleName: "test_support",
				methods: ["echo_string"],
				mountIds: [mountId],
				imageId: defaultImageId,
				minContainers: 1,
				experimentalOptions: { input_plane_region: "us-west" },
			},
			{
				className: "EchoClsParametrized",
				moduleName: "test_support",
				methods: ["echo_parameter", "echo_env_var"],
				mountIds: [mountId],
				imageId: defaultImageId,
			},
		],
	});
	console.log("Deployed 'libmodal-test-support'.");

	console.log("Deploying 'test-support-1-1'...");
	const mount11Id = await createMount(client.cpClient, "", [
		{
			remotePath: "/root/test_support_1_1.py",
			content: TEST_SUPPORT_1_1_PY,
		},
	]);

	await deployApp(client, {
		name: "test-support-1-1",
		functions: [
			{
				functionName: "identity_with_repr",
				moduleName: "test_support_1_1",
				mountIds: [mount11Id],
				imageId: defaultImageId,
				minContainers: 1,
			},
		],
	});
	console.log("Deployed 'test-support-1-1'.");

	console.log(
		"\nNOTE: Tests also require a Proxy named 'libmodal-test-proxy', which must be created via the dashboard.",
	);

	client.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
