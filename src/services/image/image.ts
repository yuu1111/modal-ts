import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import { rethrowNotFound } from "@/core/grpc/errors";
import {
	type GenericResult,
	GenericResult_GenericStatus,
	type GPUConfig,
	Image as ImageProto,
	type ImageRegistryConfig,
	RegistryAuthType,
} from "@/generated/modal_proto/api";
import { type App, parseGpuConfig } from "@/services/deploy/app";
import { createMount, type MountFileEntry } from "@/services/deploy/deploy";
import { mergeEnvIntoSecrets, Secret } from "@/services/secret/secret";
import { FilePatternMatcher } from "@/utils/file_pattern_matcher";

const DEFAULT_IMAGE_TAG = "latest";

function validateImageName(name: string): void {
	if (name === "") {
		throw new InvalidError("Image name must be non-empty.");
	}
	if (name.startsWith("im-")) {
		throw new InvalidError(
			"Image name cannot start with 'im-' (reserved for image IDs).",
		);
	}
}

function validateImageTag(tag: string): void {
	if (tag === "") {
		throw new InvalidError("Image tag must be non-empty.");
	}
}

function parseNamedImageRef(value: string): string {
	const separatorIndex = value.indexOf(":");
	if (separatorIndex === -1) {
		validateImageName(value);
		return `${value}:${DEFAULT_IMAGE_TAG}`;
	}

	const name = value.slice(0, separatorIndex);
	const tag = value.slice(separatorIndex + 1);
	validateImageName(name);
	validateImageTag(tag);
	return `${name}:${tag}`;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function jsonArrayCommand(values: string[]): string {
	return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

function asArray(value: string | string[]): string[] {
	return Array.isArray(value) ? value : [value];
}

function normalizeContainerPath(value: string): string {
	return value.replaceAll("\\", "/");
}

function basename(value: string): string {
	return value.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? "file";
}

function posixJoin(...parts: string[]): string {
	return `/${parts
		.join("/")
		.replaceAll("\\", "/")
		.split("/")
		.filter((part) => part.length > 0)
		.join("/")}`;
}

function ensureAbsoluteRemotePath(remotePath: string, method: string): void {
	if (!remotePath.startsWith("/")) {
		throw new InvalidError(
			`${method} currently only supports absolute remotePath values`,
		);
	}
}

export type ImageIgnoreMatcher =
	| string[]
	| FilePatternMatcher
	| ((filePath: string) => boolean);

function shouldIgnore(
	ignore: ImageIgnoreMatcher | undefined,
	rootPath: string,
	filePath: string,
): boolean {
	if (ignore === undefined) return false;
	const relativePath = path.relative(rootPath, filePath).replaceAll("\\", "/");
	if (Array.isArray(ignore)) {
		return new FilePatternMatcher(...ignore).matches(relativePath);
	}
	if (ignore instanceof FilePatternMatcher) {
		return ignore.matches(relativePath);
	}
	return ignore(filePath);
}

async function* walkLocalFiles(
	dir: string,
	ignore?: ImageIgnoreMatcher,
	rootPath = dir,
): AsyncGenerator<string, void, unknown> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (shouldIgnore(ignore, rootPath, entryPath)) {
			continue;
		}
		if (entry.isDirectory()) {
			yield* walkLocalFiles(entryPath, ignore, rootPath);
		} else if (entry.isFile()) {
			yield entryPath;
		}
	}
}

type LocalPathSpec =
	| string
	| { localPath: string; ignore?: ImageIgnoreMatcher };

async function buildContextFiles(
	contextFiles: Record<string, LocalPathSpec>,
): Promise<Array<{ filename: string; data: Uint8Array }>> {
	const files: Array<{ filename: string; data: Uint8Array }> = [];
	for (const [containerPath, spec] of Object.entries(contextFiles)) {
		const localPath = typeof spec === "string" ? spec : spec.localPath;
		const ignore = typeof spec === "string" ? undefined : spec.ignore;
		const localStat = await stat(localPath);
		if (localStat.isDirectory()) {
			for await (const filePath of walkLocalFiles(localPath, ignore)) {
				const relativePath = path
					.relative(localPath, filePath)
					.replaceAll("\\", "/");
				files.push({
					filename: posixJoin(containerPath, relativePath),
					data: await readFile(filePath),
				});
			}
		} else {
			files.push({
				filename: normalizeContainerPath(containerPath),
				data: await readFile(localPath),
			});
		}
	}
	return files;
}

type LocalMountLayer = {
	remotePath: string;
	localPath: string;
	ignore?: ImageIgnoreMatcher;
	isDirectory: boolean;
};

async function localMountLayerFiles(
	layer: LocalMountLayer,
): Promise<MountFileEntry[]> {
	const localStat = await stat(layer.localPath);
	if (layer.isDirectory || localStat.isDirectory()) {
		const files: MountFileEntry[] = [];
		for await (const filePath of walkLocalFiles(
			layer.localPath,
			layer.ignore,
		)) {
			const relativePath = path.relative(layer.localPath, filePath);
			files.push({
				remotePath: posixJoin(
					layer.remotePath,
					relativePath.replaceAll("\\", "/"),
				),
				content: await readFile(filePath),
			});
		}
		return files;
	}
	return [
		{
			remotePath: layer.remotePath,
			content: await readFile(layer.localPath),
		},
	];
}

/**
 * @description {@link Image} を管理するサービス
 *
 * 通常はクライアント経由でのみアクセスする:
 * ```typescript
 * const modal = new ModalClient();
 * const image = await modal.images.fromRegistry("alpine");
 * ```
 */
export class ImageService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Image ID から {@link Image} を作成する
	 * @param imageId - Image ID
	 * @returns Image インスタンス
	 */
	async fromId(imageId: string): Promise<Image> {
		try {
			const resp = await this.#client.cpClient.imageFromId({ imageId });
			return new Image(this.#client, resp.imageId, "");
		} catch (err) {
			rethrowNotFound(err, {
				preconditionPatterns: ["Could not find image with ID"],
			});
		}
	}

	/**
	 * @description {@link ImageService#fromId} の Python 互換 alias
	 */
	async from_id(imageId: string): Promise<Image> {
		return await this.fromId(imageId);
	}

	/**
	 * @description publish 済みの名前付き Image を参照する
	 * @param name - Image 名。`name:tag` 形式も指定可能。タグ未指定時は `latest`
	 * @param params - オプションパラメータ
	 * @returns Image インスタンス
	 */
	async fromName(
		name: string,
		params: ImageFromNameParams = {},
	): Promise<Image> {
		const tag = parseNamedImageRef(name);
		try {
			const resp = await this.#client.cpClient.imageGetByTag({
				environmentName: this.#client.environmentName(params.environment),
				tag,
			});
			return new Image(this.#client, resp.imageId, "");
		} catch (err) {
			rethrowNotFound(err);
		}
	}

	/**
	 * @description {@link ImageService#fromName} の Python 互換 alias
	 */
	async from_name(
		name: string,
		params: ImageFromNameParams = {},
	): Promise<Image> {
		return await this.fromName(name, params);
	}

	/**
	 * @description レジストリタグから {@link Image} を作成する。認証用に {@link Secret} を指定可能
	 * @param tag - Image のレジストリタグ
	 * @param secret - レジストリ認証用の Secret
	 * @returns Image インスタンス
	 */
	fromRegistry(tag: string, secret?: Secret): Image {
		return this.#fromRegistryWith(
			tag,
			secret,
			RegistryAuthType.REGISTRY_AUTH_TYPE_STATIC_CREDS,
		);
	}

	/**
	 * @description {@link ImageService#fromRegistry} の Python 互換 alias
	 */
	from_registry(tag: string, secret?: Secret): Image {
		return this.fromRegistry(tag, secret);
	}

	/**
	 * @description AWS ECR のレジストリタグから {@link Image} を作成する
	 * @param tag - Image のレジストリタグ
	 * @param secret - AWS 認証用の Secret
	 * @returns Image インスタンス
	 */
	fromAwsEcr(tag: string, secret: Secret): Image {
		return this.#fromRegistryWith(
			tag,
			secret,
			RegistryAuthType.REGISTRY_AUTH_TYPE_AWS,
		);
	}

	/**
	 * @description {@link ImageService#fromAwsEcr} の Python 互換 alias
	 */
	from_aws_ecr(tag: string, secret: Secret): Image {
		return this.fromAwsEcr(tag, secret);
	}

	/**
	 * @description GCP Artifact Registry のレジストリタグから {@link Image} を作成する
	 * @param tag - Image のレジストリタグ
	 * @param secret - GCP 認証用の Secret
	 * @returns Image インスタンス
	 */
	fromGcpArtifactRegistry(tag: string, secret: Secret): Image {
		return this.#fromRegistryWith(
			tag,
			secret,
			RegistryAuthType.REGISTRY_AUTH_TYPE_GCP,
		);
	}

	/**
	 * @description {@link ImageService#fromGcpArtifactRegistry} の Python 互換 alias
	 */
	from_gcp_artifact_registry(tag: string, secret: Secret): Image {
		return this.fromGcpArtifactRegistry(tag, secret);
	}

	/**
	 * @description 空の scratch image を作成する
	 * @param params - オプションパラメータ
	 */
	fromScratch(params: { forceBuild?: boolean } = {}): Image {
		const layer: Layer = { commands: [] };
		if (params.forceBuild !== undefined) layer.forceBuild = params.forceBuild;
		return new Image(this.#client, "", "scratch", undefined, [layer]);
	}

	/**
	 * @description {@link ImageService#fromScratch} の Python 互換 alias
	 */
	from_scratch(params: { forceBuild?: boolean } = {}): Image {
		return this.fromScratch(params);
	}

	/**
	 * @description Python Debian slim ベースの Image を作成する
	 * @param params - Python version と build オプション
	 */
	debianSlim(
		params: { pythonVersion?: string; forceBuild?: boolean } = {},
	): Image {
		const pythonVersion = params.pythonVersion ?? "3.12";
		const image = new Image(
			this.#client,
			"",
			`python:${pythonVersion}-slim-bookworm`,
		);
		return image.dockerfileCommands(
			[
				"RUN apt-get update",
				"RUN apt-get install -y gcc gfortran build-essential",
				"RUN pip install --upgrade pip setuptools wheel",
				"RUN echo 'debconf debconf/frontend select Noninteractive' | debconf-set-selections",
				'CMD ["sleep", "172800"]',
			],
			params.forceBuild === undefined
				? undefined
				: { forceBuild: params.forceBuild },
		);
	}

	/**
	 * @description {@link ImageService#debianSlim} の Python 互換 alias
	 */
	debian_slim(
		params: { pythonVersion?: string; forceBuild?: boolean } = {},
	): Image {
		return this.debianSlim(params);
	}

	/**
	 * @description local Dockerfile から Image を作成する
	 */
	fromDockerfile(
		dockerfilePath: string,
		params: ImageBuildStepParams & {
			contextDir?: string;
			addPython?: string;
		} = {},
	): Image {
		const commands = readFileSync(dockerfilePath, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.length > 0);
		const contextDir = params.contextDir ?? path.dirname(dockerfilePath);
		let image = new Image(this.#client, "", "scratch", undefined, [
			{
				commands,
				contextFiles: { "/": contextDir },
				...(params.forceBuild !== undefined && {
					forceBuild: params.forceBuild,
				}),
				...(params.gpu !== undefined && {
					gpuConfig: parseGpuConfig(params.gpu),
				}),
				...(params.env !== undefined && { env: params.env }),
				...(params.secrets !== undefined && { secrets: params.secrets }),
				...(params.buildArgs !== undefined && { buildArgs: params.buildArgs }),
				includeBase: false,
			},
		]);
		if (params.addPython) {
			image = image.dockerfileCommands([
				`RUN apt-get update && apt-get install -y python${params.addPython} python3-pip`,
			]);
		}
		return image;
	}

	/**
	 * @description {@link ImageService#fromDockerfile} の Python 互換 alias
	 */
	from_dockerfile(
		dockerfilePath: string,
		params: Parameters<ImageService["fromDockerfile"]>[1] = {},
	): Image {
		return this.fromDockerfile(dockerfilePath, params);
	}

	/**
	 * @description Micromamba base image を作成する
	 */
	micromamba(
		params: { pythonVersion?: string; forceBuild?: boolean } = {},
	): Image {
		const pythonVersion = params.pythonVersion ?? "3.12";
		const image = new Image(this.#client, "", "mambaorg/micromamba:latest");
		return image.dockerfileCommands(
			[
				'SHELL ["/usr/local/bin/_dockerfile_shell.sh"]',
				"ENV MAMBA_DOCKERFILE_ACTIVATE=1",
				`RUN micromamba install -n base -y python=${pythonVersion} pip -c conda-forge`,
			],
			params.forceBuild === undefined
				? undefined
				: { forceBuild: params.forceBuild },
		);
	}

	#fromRegistryWith(
		tag: string,
		secret: Secret | undefined,
		authType: RegistryAuthType,
	): Image {
		let imageRegistryConfig: ImageRegistryConfig | undefined;
		if (secret) {
			if (!(secret instanceof Secret)) {
				throw new TypeError(
					"secret must be a reference to an existing Secret, e.g. `await Secret.fromName('my_secret')`",
				);
			}
			imageRegistryConfig = {
				registryAuthType: authType,
				secretId: secret.secretId,
			};
		}
		return new Image(this.#client, "", tag, imageRegistryConfig);
	}

	/**
	 * @description ID で {@link Image} を削除する。削除は不可逆で、Function/Sandbox からの使用を妨げる。中間レイヤーは削除されない
	 * @param imageId - 削除する Image の ID
	 * @param _ - 将来の拡張用パラメータ
	 */
	async delete(imageId: string, _: ImageDeleteParams = {}): Promise<void> {
		try {
			await this.#client.cpClient.imageDelete({ imageId });
		} catch (err) {
			rethrowNotFound(err, {
				preconditionPatterns: ["Could not find image with ID"],
			});
		}
	}
}

/**
 * @description {@link ImageService#delete client.images.delete()} のオプションパラメータ
 */
export type ImageDeleteParams = Record<never, never>;

/**
 * @description {@link ImageService#fromName client.images.fromName()} のオプションパラメータ
 * @property environment - Image を解決する Modal 環境名
 */
export type ImageFromNameParams = {
	environment?: string;
};

/**
 * @description {@link Image#publish Image.publish()} のオプションパラメータ
 * @property environment - Image を publish する Modal 環境名
 */
export type ImagePublishParams = {
	environment?: string;
};

/**
 * @description {@link Image#dockerfileCommands Image.dockerfileCommands()} のオプションパラメータ
 * @property env - ビルド環境に設定する環境変数
 * @property secrets - ビルド環境で環境変数として利用可能にする {@link Secret} の配列
 * @property gpu - ビルド環境の GPU 予約 (例: "A100", "T4:2", "A100-80GB:4")
 * @property forceBuild - キャッシュを無視してビルドするかどうか
 */
export type ImageDockerfileCommandsParams = {
	/**
	 * @description ビルド環境に設定する環境変数
	 */
	env?: Record<string, string>;

	/**
	 * @description ビルド環境で環境変数として利用可能にする {@link Secret} の配列
	 */
	secrets?: Secret[];

	/**
	 * @description ビルド環境の GPU 予約 (例: "A100", "T4:2", "A100-80GB:4")
	 */
	gpu?: string;

	/**
	 * @description キャッシュを無視してビルドする ('docker build --no-cache' に相当)
	 */
	forceBuild?: boolean;

	/**
	 * @description Docker build context に含める local file mapping
	 */
	contextFiles?: Record<string, LocalPathSpec>;

	/**
	 * @description Dockerfile ARG に渡す build arguments
	 */
	buildArgs?: Record<string, string>;
};

/**
 * @description Image builder の共通オプション
 */
export type ImageBuildStepParams = ImageDockerfileCommandsParams;

/**
 * @description 単一の Image レイヤーとそのビルド設定を表す
 * @property commands - Dockerfile コマンドの配列
 * @property env - 環境変数
 * @property secrets - ビルド環境で利用する Secret の配列
 * @property gpuConfig - GPU 設定
 * @property forceBuild - キャッシュ無視フラグ
 */
type Layer = {
	commands: string[];
	env?: Record<string, string>;
	secrets?: Secret[];
	gpuConfig?: GPUConfig;
	forceBuild?: boolean;
	contextFiles?: Record<string, LocalPathSpec>;
	buildArgs?: Record<string, string>;
	includeBase?: boolean;
};

/**
 * @description {@link Sandbox} の起動に使用するコンテナイメージ
 */
export class Image {
	#client: ModalClient;
	#imageId: string;
	#tag: string;
	#baseImageId: string;
	#imageRegistryConfig?: ImageRegistryConfig;
	#layers: Layer[];
	#localMountLayers: LocalMountLayer[];

	/**
	 * @internal
	 */
	constructor(
		client: ModalClient,
		imageId: string,
		tag: string,
		imageRegistryConfig?: ImageRegistryConfig,
		layers?: Layer[],
		baseImageId?: string,
		localMountLayers?: LocalMountLayer[],
	) {
		this.#client = client;
		this.#imageId = imageId;
		this.#tag = tag;
		this.#baseImageId = baseImageId || "";
		if (imageRegistryConfig !== undefined)
			this.#imageRegistryConfig = imageRegistryConfig;
		this.#layers = layers || [
			{
				commands: [],
				forceBuild: false,
			},
		];
		this.#localMountLayers = localMountLayers ?? [];
	}
	get imageId(): string {
		return this.#imageId;
	}

	/**
	 * @internal
	 */
	async mountIds(app: App): Promise<string[]> {
		const ids: string[] = [];
		for (const layer of this.#localMountLayers) {
			const files = await localMountLayerFiles(layer);
			ids.push(await createMount(this.#client.cpClient, app.appId, files));
		}
		return ids;
	}

	/**
	 * @description 任意の Dockerfile コマンドで Image を拡張する。各呼び出しは順次ビルドされる新しいレイヤーを作成する
	 * @param commands - Dockerfile コマンドの文字列配列
	 * @param params - このレイヤーのビルド設定
	 * @returns 新しい Image インスタンス
	 */
	dockerfileCommands(
		commands: string[],
		params?: ImageDockerfileCommandsParams,
	): Image {
		if (commands.length === 0) {
			return this;
		}
		if (this.#localMountLayers.length > 0) {
			throw new InvalidError(
				"Cannot add build steps after image.addLocalFile/addLocalDir with copy=false. Pass { copy: true } when adding local files if later build steps need to see them.",
			);
		}

		const newLayer: Layer = {
			commands: [...commands],
			...(params?.env !== undefined && { env: params.env }),
			...(params?.secrets !== undefined && { secrets: params.secrets }),
			...(params?.gpu !== undefined && {
				gpuConfig: parseGpuConfig(params.gpu),
			}),
			...(params?.forceBuild !== undefined && {
				forceBuild: params.forceBuild,
			}),
			...(params?.contextFiles !== undefined && {
				contextFiles: params.contextFiles,
			}),
			...(params?.buildArgs !== undefined && {
				buildArgs: params.buildArgs,
			}),
		};

		const baseImageId = this.#imageId || this.#baseImageId;
		const layers = this.#imageId === "" ? this.#layers : [];

		return new Image(
			this.#client,
			"",
			this.#tag,
			this.#imageRegistryConfig,
			[...layers, newLayer],
			baseImageId,
			this.#localMountLayers,
		);
	}

	/**
	 * @description {@link Image#dockerfileCommands} の Python 互換 alias
	 */
	dockerfile_commands(
		commands: string[],
		params?: ImageDockerfileCommandsParams,
	): Image {
		return this.dockerfileCommands(commands, params);
	}

	/**
	 * @description Debian package を apt で install する
	 * @param packages - package 名
	 * @param params - build step オプション
	 */
	aptInstall(packages: string[], params?: ImageBuildStepParams): Image {
		if (packages.length === 0) return this;
		return this.dockerfileCommands(
			[
				"RUN apt-get update",
				`RUN apt-get install -y ${packages.map(shellQuote).join(" ")}`,
			],
			params,
		);
	}

	/**
	 * @description {@link Image#aptInstall} の Python 互換 alias
	 */
	apt_install(packages: string[], params?: ImageBuildStepParams): Image {
		return this.aptInstall(packages, params);
	}

	/**
	 * @description Python package を pip で install する
	 * @param packages - package 名
	 * @param params - build step オプション
	 */
	pipInstall(
		packages: string[],
		params: ImageBuildStepParams & {
			findLinks?: string;
			indexUrl?: string;
			extraIndexUrl?: string;
			pre?: boolean;
			extraOptions?: string;
		} = {},
	): Image {
		if (packages.length === 0) return this;
		const extraArgs = [
			params.findLinks && `--find-links ${shellQuote(params.findLinks)}`,
			params.indexUrl && `--index-url ${shellQuote(params.indexUrl)}`,
			params.extraIndexUrl &&
				`--extra-index-url ${shellQuote(params.extraIndexUrl)}`,
			params.pre && "--pre",
			params.extraOptions,
		]
			.filter(Boolean)
			.join(" ");
		const suffix = extraArgs ? ` ${extraArgs}` : "";
		return this.dockerfileCommands(
			[
				`RUN python -m pip install ${packages.map(shellQuote).join(" ")}${suffix}`,
			],
			params,
		);
	}

	/**
	 * @description {@link Image#pipInstall} の Python 互換 alias
	 */
	pip_install(
		packages: string[],
		params: Parameters<Image["pipInstall"]>[1] = {},
	): Image {
		return this.pipInstall(packages, params);
	}

	/**
	 * @description private git repository を pip install する
	 */
	pipInstallPrivateRepos(
		repositories: string[],
		params: ImageBuildStepParams & {
			gitUser?: string;
			git_user?: string;
			tokenSecret?: Secret;
			findLinks?: string;
			indexUrl?: string;
			extraIndexUrl?: string;
			pre?: boolean;
			extraOptions?: string;
		} = {},
	): Image {
		if (repositories.length === 0) return this;
		const secrets = params.tokenSecret
			? [...(params.secrets ?? []), params.tokenSecret]
			: params.secrets;
		if (!secrets || secrets.length === 0) {
			throw new InvalidError(
				"No secrets provided to function. Installing private packages requires tokens to be passed via modal.Secret objects.",
			);
		}

		const user = params.gitUser ?? params.git_user;
		if (!user) {
			throw new InvalidError("pipInstallPrivateRepos requires gitUser.");
		}

		const invalidRepos: string[] = [];
		const installUrls: string[] = [];
		for (const repo of repositories) {
			const host = repo.split("/", 1)[0];
			if (host === "github.com") {
				installUrls.push(`git+https://${user}:$GITHUB_TOKEN@${repo}`);
			} else if (host === "gitlab.com") {
				installUrls.push(`git+https://${user}:$GITLAB_TOKEN@${repo}`);
			} else {
				invalidRepos.push(repo);
			}
		}
		if (invalidRepos.length > 0) {
			throw new InvalidError(
				`${invalidRepos.length} out of ${repositories.length} given repository refs are invalid. Invalid refs: ${invalidRepos.join(", ")}.`,
			);
		}

		const extraArgs = [
			params.findLinks && `--find-links ${shellQuote(params.findLinks)}`,
			params.indexUrl && `--index-url ${shellQuote(params.indexUrl)}`,
			params.extraIndexUrl &&
				`--extra-index-url ${shellQuote(params.extraIndexUrl)}`,
			params.pre && "--pre",
			params.extraOptions,
		]
			.filter(Boolean)
			.join(" ");
		const suffix = extraArgs ? ` ${extraArgs}` : "";
		const commands: string[] = [];
		if (repositories.some((repo) => repo.startsWith("github.com"))) {
			commands.push(
				"RUN bash -c \"[[ -v GITHUB_TOKEN ]] || (echo 'GITHUB_TOKEN env var not set by provided modal.Secret(s)' && exit 1)\"",
			);
		}
		if (repositories.some((repo) => repo.startsWith("gitlab.com"))) {
			commands.push(
				"RUN bash -c \"[[ -v GITLAB_TOKEN ]] || (echo 'GITLAB_TOKEN env var not set by provided modal.Secret(s)' && exit 1)\"",
			);
		}
		commands.push("RUN apt-get update && apt-get install -y git");
		for (const url of installUrls) {
			commands.push(`RUN python3 -m pip install "${url}"${suffix}`);
		}
		const {
			gitUser: _gitUser,
			git_user: _git_user,
			tokenSecret: _tokenSecret,
			findLinks: _findLinks,
			indexUrl: _indexUrl,
			extraIndexUrl: _extraIndexUrl,
			pre: _pre,
			extraOptions: _extraOptions,
			...rest
		} = params;
		return this.dockerfileCommands(commands, {
			...rest,
			secrets,
		});
	}

	/**
	 * @description {@link Image#pipInstallPrivateRepos} の Python 互換 alias
	 */
	pip_install_private_repos(
		repositories: string[],
		params: Parameters<Image["pipInstallPrivateRepos"]>[1] = {},
	): Image {
		return this.pipInstallPrivateRepos(repositories, params);
	}

	/**
	 * @description local file を Image layer に追加する
	 */
	addLocalFile(
		localPath: string,
		remotePath: string,
		params: { copy?: boolean } = {},
	): Image {
		ensureAbsoluteRemotePath(remotePath, "image.addLocalFile()");
		const finalRemotePath = remotePath.endsWith("/")
			? `${remotePath}${basename(localPath)}`
			: remotePath;
		if (params.copy === true) {
			const contextPath = posixJoin(
				"/.modal_context",
				finalRemotePath.replace(/^\/+/, ""),
			);
			return this.dockerfileCommands(
				[`COPY ${contextPath} ${finalRemotePath}`],
				{
					contextFiles: { [contextPath]: localPath },
				},
			);
		}
		return new Image(
			this.#client,
			this.#imageId,
			this.#tag,
			this.#imageRegistryConfig,
			this.#layers,
			this.#baseImageId,
			[
				...this.#localMountLayers,
				{
					localPath,
					remotePath: finalRemotePath,
					isDirectory: false,
				},
			],
		);
	}

	/**
	 * @description {@link Image#addLocalFile} の Python 互換 alias
	 */
	add_local_file(
		localPath: string,
		remotePath: string,
		params: { copy?: boolean } = {},
	): Image {
		return this.addLocalFile(localPath, remotePath, params);
	}

	/**
	 * @description local directory を Image layer に再帰的に追加する
	 */
	addLocalDir(
		localPath: string,
		remotePath: string,
		params: { copy?: boolean; ignore?: ImageIgnoreMatcher } = {},
	): Image {
		ensureAbsoluteRemotePath(remotePath, "image.addLocalDir()");
		if (params.copy === true) {
			const contextRoot = posixJoin(
				"/.modal_context",
				remotePath.replace(/^\/+/, ""),
			);
			const contextSpec: { localPath: string; ignore?: ImageIgnoreMatcher } = {
				localPath,
			};
			if (params.ignore !== undefined) contextSpec.ignore = params.ignore;
			return this.dockerfileCommands([`COPY ${contextRoot}/ ${remotePath}/`], {
				contextFiles: { [contextRoot]: contextSpec },
			});
		}
		const mountLayer: LocalMountLayer = {
			localPath,
			remotePath,
			isDirectory: true,
		};
		if (params.ignore !== undefined) mountLayer.ignore = params.ignore;
		return new Image(
			this.#client,
			this.#imageId,
			this.#tag,
			this.#imageRegistryConfig,
			this.#layers,
			this.#baseImageId,
			[...this.#localMountLayers, mountLayer],
		);
	}

	/**
	 * @description {@link Image#addLocalDir} の Python 互換 alias
	 */
	add_local_dir(
		localPath: string,
		remotePath: string,
		params: { copy?: boolean; ignore?: ImageIgnoreMatcher } = {},
	): Image {
		return this.addLocalDir(localPath, remotePath, params);
	}

	/**
	 * @description local Python module/package を `/root` 配下に追加する
	 */
	addLocalPythonSource(
		modules: string[],
		params: { copy?: boolean; ignore?: ImageIgnoreMatcher } = {},
	): Image {
		let image: Image = this;
		for (const moduleName of modules) {
			const modulePath = moduleName.replaceAll(".", path.sep);
			const packagePath = path.resolve(modulePath);
			const filePath = path.resolve(`${modulePath}.py`);
			if (existsSync(packagePath)) {
				image = image.addLocalDir(
					packagePath,
					posixJoin("/root", modulePath.replaceAll(path.sep, "/")),
					params,
				);
			} else if (existsSync(filePath)) {
				image = image.addLocalFile(
					filePath,
					posixJoin("/root", `${modulePath.replaceAll(path.sep, "/")}.py`),
					params,
				);
			} else {
				throw new InvalidError(
					`Could not find local Python module or package '${moduleName}'`,
				);
			}
		}
		return image;
	}

	/**
	 * @description {@link Image#addLocalPythonSource} の Python 互換 alias
	 */
	add_local_python_source(
		modules: string[],
		params: { copy?: boolean; ignore?: ImageIgnoreMatcher } = {},
	): Image {
		return this.addLocalPythonSource(modules, params);
	}

	/**
	 * @description requirements.txt から pip install する
	 */
	pipInstallFromRequirements(
		requirementsTxt: string,
		params: ImageBuildStepParams & {
			findLinks?: string;
			indexUrl?: string;
			extraIndexUrl?: string;
			pre?: boolean;
			extraOptions?: string;
		} = {},
	): Image {
		const extraArgs = [
			params.findLinks && `-f ${shellQuote(params.findLinks)}`,
			params.indexUrl && `--index-url ${shellQuote(params.indexUrl)}`,
			params.extraIndexUrl &&
				`--extra-index-url ${shellQuote(params.extraIndexUrl)}`,
			params.pre && "--pre",
			params.extraOptions,
		]
			.filter(Boolean)
			.join(" ");
		const suffix = extraArgs ? ` ${extraArgs}` : "";
		return this.dockerfileCommands(
			[
				"COPY /.requirements.txt /.requirements.txt",
				`RUN python -m pip install -r /.requirements.txt${suffix}`,
			],
			{
				...params,
				contextFiles: { "/.requirements.txt": requirementsTxt },
			},
		);
	}

	/**
	 * @description {@link Image#pipInstallFromRequirements} の Python 互換 alias
	 */
	pip_install_from_requirements(
		requirementsTxt: string,
		params: ImageBuildStepParams & {
			findLinks?: string;
			indexUrl?: string;
			extraIndexUrl?: string;
			pre?: boolean;
			extraOptions?: string;
		} = {},
	): Image {
		return this.pipInstallFromRequirements(requirementsTxt, params);
	}

	/**
	 * @description pyproject.toml の project dependencies を pip install する
	 */
	pipInstallFromPyproject(
		pyprojectToml: string,
		optionalDependencies: string[] = [],
		params: ImageBuildStepParams & {
			findLinks?: string;
			indexUrl?: string;
			extraIndexUrl?: string;
			pre?: boolean;
			extraOptions?: string;
		} = {},
	): Image {
		const config = parseToml(readFileSync(pyprojectToml, "utf8")) as {
			project?: {
				dependencies?: string[];
				"optional-dependencies"?: Record<string, string[]>;
			};
		};
		const dependencies = [...(config.project?.dependencies ?? [])];
		for (const group of optionalDependencies) {
			dependencies.push(
				...(config.project?.["optional-dependencies"]?.[group] ?? []),
			);
		}
		if (dependencies.length === 0) {
			throw new InvalidError(
				"No [project.dependencies] section in pyproject.toml file.",
			);
		}
		return this.pipInstall(dependencies.sort(), params);
	}

	/**
	 * @description {@link Image#pipInstallFromPyproject} の Python 互換 alias
	 */
	pip_install_from_pyproject(
		pyprojectToml: string,
		optionalDependencies: string[] = [],
		params: Parameters<Image["pipInstallFromPyproject"]>[2] = {},
	): Image {
		return this.pipInstallFromPyproject(
			pyprojectToml,
			optionalDependencies,
			params,
		);
	}

	/**
	 * @description uv pip install を使って package を install する
	 */
	uvPipInstall(
		packages: string[] = [],
		params: ImageBuildStepParams & {
			requirements?: string[];
			findLinks?: string;
			indexUrl?: string;
			extraIndexUrl?: string;
			pre?: boolean;
			extraOptions?: string;
			uvVersion?: string;
		} = {},
	): Image {
		const uvRoot = "/.uv";
		const commands = [
			params.uvVersion
				? `COPY --from=ghcr.io/astral-sh/uv:${params.uvVersion} /uv ${uvRoot}/uv`
				: `COPY --from=ghcr.io/astral-sh/uv:latest /uv ${uvRoot}/uv`,
		];
		const contextFiles: Record<string, string> = {};
		const args = ["--python $(command -v python)", "--compile-bytecode"];
		if (params.findLinks)
			args.push(`--find-links ${shellQuote(params.findLinks)}`);
		if (params.indexUrl)
			args.push(`--index-url ${shellQuote(params.indexUrl)}`);
		if (params.extraIndexUrl) {
			args.push(`--extra-index-url ${shellQuote(params.extraIndexUrl)}`);
		}
		if (params.pre) args.push("--prerelease allow");
		if (params.extraOptions) args.push(params.extraOptions);
		for (const [index, requirement] of (params.requirements ?? []).entries()) {
			const contextPath = `/.${index}_${basename(requirement)}`;
			const destPath = `${uvRoot}/${index}/${basename(requirement)}`;
			contextFiles[contextPath] = requirement;
			commands.push(`COPY ${contextPath} ${destPath}`);
			args.push(`--requirements ${destPath}`);
		}
		args.push(...packages.map(shellQuote).sort());
		if (packages.length === 0 && Object.keys(contextFiles).length === 0) {
			return this;
		}
		commands.push(`RUN ${uvRoot}/uv pip install ${args.join(" ")}`);
		return this.dockerfileCommands(commands, { ...params, contextFiles });
	}

	/**
	 * @description {@link Image#uvPipInstall} の Python 互換 alias
	 */
	uv_pip_install(
		packages: string[] = [],
		params: Parameters<Image["uvPipInstall"]>[1] = {},
	): Image {
		return this.uvPipInstall(packages, params);
	}

	/**
	 * @description Poetry pyproject から dependency を install する
	 */
	poetryInstallFromFile(
		pyprojectToml: string,
		params: ImageBuildStepParams & {
			poetryLockfile?: string;
			ignoreLockfile?: boolean;
			with?: string[];
			without?: string[];
			only?: string[];
			poetryVersion?: string | null;
			oldInstaller?: boolean;
		} = {},
	): Image {
		const contextFiles: Record<string, string> = {
			"/.pyproject.toml": pyprojectToml,
		};
		const commands: string[] = [];
		const poetryVersion = params.poetryVersion ?? "latest";
		if (poetryVersion !== null) {
			commands.push(
				`RUN python -m pip install poetry${poetryVersion === "latest" ? "" : `==${poetryVersion}`}`,
			);
		}
		if (params.oldInstaller) {
			commands.push("RUN poetry config experimental.new-installer false");
		}
		if (!params.ignoreLockfile && params.poetryLockfile) {
			contextFiles["/.poetry.lock"] = params.poetryLockfile;
			commands.push("COPY /.poetry.lock /tmp/poetry/poetry.lock");
		}
		let installCommand = "poetry install --no-root";
		if (params.with?.length)
			installCommand += ` --with ${params.with.join(",")}`;
		if (params.without?.length) {
			installCommand += ` --without ${params.without.join(",")}`;
		}
		if (params.only?.length)
			installCommand += ` --only ${params.only.join(",")}`;
		installCommand += " --compile";
		commands.push(
			"COPY /.pyproject.toml /tmp/poetry/pyproject.toml",
			"RUN cd /tmp/poetry && \\",
			"  poetry config virtualenvs.create false && \\",
			`  ${installCommand}`,
		);
		return this.dockerfileCommands(commands, { ...params, contextFiles });
	}

	/**
	 * @description {@link Image#poetryInstallFromFile} の Python 互換 alias
	 */
	poetry_install_from_file(
		pyprojectToml: string,
		params: Parameters<Image["poetryInstallFromFile"]>[1] = {},
	): Image {
		return this.poetryInstallFromFile(pyprojectToml, params);
	}

	/**
	 * @description uv sync で pyproject/uv.lock dependency を install する
	 */
	uvSync(
		projectDir = ".",
		params: ImageBuildStepParams & {
			groups?: string[];
			extras?: string[];
			frozen?: boolean;
			extraOptions?: string;
			uvVersion?: string;
		} = {},
	): Image {
		const uvRoot = "/.uv";
		const contextFiles: Record<string, string> = {
			"/.pyproject.toml": path.join(projectDir, "pyproject.toml"),
		};
		const lockPath = path.join(projectDir, "uv.lock");
		const commands = [
			params.uvVersion
				? `COPY --from=ghcr.io/astral-sh/uv:${params.uvVersion} /uv ${uvRoot}/uv`
				: `COPY --from=ghcr.io/astral-sh/uv:latest /uv ${uvRoot}/uv`,
			"COPY /.pyproject.toml /tmp/uv/pyproject.toml",
		];
		if (existsSync(lockPath)) {
			contextFiles["/.uv.lock"] = lockPath;
			commands.push("COPY /.uv.lock /tmp/uv/uv.lock");
		}
		const args = ["sync", "--compile-bytecode", "--no-dev"];
		if (params.frozen ?? true) args.push("--frozen");
		for (const group of params.groups ?? [])
			args.push("--group", shellQuote(group));
		for (const extra of params.extras ?? [])
			args.push("--extra", shellQuote(extra));
		if (params.extraOptions) args.push(params.extraOptions);
		commands.push(`RUN cd /tmp/uv && ${uvRoot}/uv ${args.join(" ")}`);
		return this.dockerfileCommands(commands, { ...params, contextFiles });
	}

	/**
	 * @description {@link Image#uvSync} の Python 互換 alias
	 */
	uv_sync(
		projectDir = ".",
		params: Parameters<Image["uvSync"]>[1] = {},
	): Image {
		return this.uvSync(projectDir, params);
	}

	/**
	 * @description micromamba install で conda package を追加する
	 */
	micromambaInstall(
		packages: string[] = [],
		params: ImageBuildStepParams & {
			specFile?: string;
			channels?: string[];
		} = {},
	): Image {
		if (packages.length === 0 && !params.specFile) return this;
		const contextFiles: Record<string, string> = {};
		const commands: string[] = [];
		const packageArgs = packages.map(shellQuote).join(" ");
		const channelArgs = (params.channels ?? [])
			.map((channel) => `-c ${shellQuote(channel)}`)
			.join(" ");
		let fileArg = "";
		if (params.specFile) {
			const remoteSpecFile = `/${basename(params.specFile)}`;
			contextFiles[remoteSpecFile] = params.specFile;
			commands.push(`COPY ${remoteSpecFile} ${remoteSpecFile}`);
			fileArg = ` -f ${remoteSpecFile} -n base`;
		}
		commands.push(
			`RUN micromamba install ${packageArgs}${fileArg}${channelArgs ? ` ${channelArgs}` : ""} --yes`,
		);
		return this.dockerfileCommands(commands, { ...params, contextFiles });
	}

	/**
	 * @description {@link Image#micromambaInstall} の Python 互換 alias
	 */
	micromamba_install(
		packages: string[] = [],
		params: Parameters<Image["micromambaInstall"]>[1] = {},
	): Image {
		return this.micromambaInstall(packages, params);
	}

	/**
	 * @description Image を任意の callback で変換する
	 */
	pipe(fn: (image: Image) => Image): Image {
		return fn(this);
	}

	/**
	 * @description build step として command を実行する
	 */
	runFunction(
		command: string | string[],
		params?: ImageBuildStepParams,
	): Image {
		return this.runCommands(asArray(command), params);
	}

	/**
	 * @description {@link Image#runFunction} の Python 互換 alias
	 */
	run_function(
		command: string | string[],
		params?: ImageBuildStepParams,
	): Image {
		return this.runFunction(command, params);
	}

	/**
	 * @description Python の Image.imports() に近い構文互換 helper
	 */
	imports<T>(callback: () => T): T {
		return callback();
	}

	/**
	 * @description shell command を RUN layer として実行する
	 * @param commands - 実行する command
	 * @param params - build step オプション
	 */
	runCommands(commands: string[], params?: ImageBuildStepParams): Image {
		if (commands.length === 0) return this;
		return this.dockerfileCommands(
			commands.map((cmd) => `RUN ${cmd}`),
			params,
		);
	}

	/**
	 * @description {@link Image#runCommands} の Python 互換 alias
	 */
	run_commands(commands: string[], params?: ImageBuildStepParams): Image {
		return this.runCommands(commands, params);
	}

	/**
	 * @description Image に ENV directive を追加する
	 * @param vars - 環境変数
	 */
	env(vars: Record<string, string>): Image {
		for (const [key, value] of Object.entries(vars)) {
			if (typeof value !== "string") {
				throw new InvalidError(`Image ENV variable ${key} must be a string.`);
			}
		}
		return this.dockerfileCommands(
			Object.entries(vars).map(
				([key, value]) => `ENV ${key}=${shellQuote(value)}`,
			),
		);
	}

	/**
	 * @description Image の WORKDIR を設定する
	 * @param path - container 内 path
	 */
	workdir(path: string): Image {
		return this.dockerfileCommands([`WORKDIR ${shellQuote(path)}`]);
	}

	/**
	 * @description Image の CMD を JSON array form で設定する
	 * @param command - argv tokens
	 */
	cmd(command: string[]): Image {
		if (!command.every((x) => typeof x === "string")) {
			throw new InvalidError("Image CMD must be a list of strings.");
		}
		return this.dockerfileCommands([`CMD ${jsonArrayCommand(command)}`]);
	}

	/**
	 * @description Image の ENTRYPOINT を JSON array form で設定する
	 * @param command - argv tokens
	 */
	entrypoint(command: string[]): Image {
		if (!command.every((x) => typeof x === "string")) {
			throw new InvalidError("Image ENTRYPOINT must be a list of strings.");
		}
		return this.dockerfileCommands([`ENTRYPOINT ${jsonArrayCommand(command)}`]);
	}

	/**
	 * @description Image の SHELL を JSON array form で設定する
	 * @param command - argv tokens
	 */
	shell(command: string[]): Image {
		if (!command.every((x) => typeof x === "string")) {
			throw new InvalidError("Image SHELL must be a list of strings.");
		}
		return this.dockerfileCommands([`SHELL ${jsonArrayCommand(command)}`]);
	}

	/**
	 * @description Modal 上で Image を即座にビルドする
	 * @param app - ビルドに使用する App
	 * @returns ビルドされた Image インスタンス
	 */
	async build(app: App): Promise<Image> {
		if (this.imageId !== "") {
			// Image ID で既にビルド済み
			return this;
		}

		this.#client.logger.debug("Building image", "app_id", app.appId);

		let baseImageId: string | undefined = this.#baseImageId || undefined;

		for (let i = 0; i < this.#layers.length; i++) {
			const layer = this.#layers[i];
			if (!layer) throw new Error(`Expected layer at index ${i}`);

			const mergedSecrets = await mergeEnvIntoSecrets(
				this.#client,
				layer.env,
				layer.secrets,
			);

			const secretIds = mergedSecrets.map((secret) => secret.secretId);
			const gpuConfig = layer.gpuConfig;
			const contextFiles = await buildContextFiles(layer.contextFiles ?? {});

			let dockerfileCommands: string[];
			let baseImages: Array<{ dockerTag: string; imageId: string }>;

			if (i === 0 && layer.includeBase === false) {
				dockerfileCommands = [...layer.commands];
				baseImages = [];
			} else if (i === 0 && baseImageId) {
				dockerfileCommands = ["FROM base", ...layer.commands];
				baseImages = [{ dockerTag: "base", imageId: baseImageId }];
			} else if (i === 0) {
				dockerfileCommands = [`FROM ${this.#tag}`, ...layer.commands];
				baseImages = [];
			} else {
				dockerfileCommands = ["FROM base", ...layer.commands];
				if (!baseImageId)
					throw new Error("Expected baseImageId from previous layer");
				baseImages = [{ dockerTag: "base", imageId: baseImageId }];
			}
			const imageRegistryConfig =
				i === 0 && !baseImageId ? this.#imageRegistryConfig : undefined;

			const resp = await this.#client.cpClient.imageGetOrCreate({
				appId: app.appId,
				image: ImageProto.create({
					dockerfileCommands,
					imageRegistryConfig,
					secretIds,
					gpuConfig,
					contextFiles,
					baseImages,
					buildArgs: layer.buildArgs ?? {},
				}),
				builderVersion: this.#client.imageBuilderVersion(),
				forceBuild: layer.forceBuild || false,
			});

			let result: GenericResult;

			if (resp.result?.status) {
				// ビルド済み
				result = resp.result;
			} else {
				// 未ビルドまたはビルド中 — 完了を待機
				let lastEntryId = "";
				let resultJoined: GenericResult | undefined;
				while (!resultJoined) {
					for await (const item of this.#client.cpClient.imageJoinStreaming({
						imageId: resp.imageId,
						timeout: 55,
						lastEntryId,
					})) {
						if (item.entryId) lastEntryId = item.entryId;
						if (item.result?.status) {
							resultJoined = item.result;
							break;
						}
						// ログ行と進捗更新は無視
					}
				}
				result = resultJoined;
			}

			if (
				result.status === GenericResult_GenericStatus.GENERIC_STATUS_FAILURE
			) {
				throw new Error(
					`Image build for ${resp.imageId} failed with the exception:\n${result.exception}`,
				);
			} else if (
				result.status === GenericResult_GenericStatus.GENERIC_STATUS_TERMINATED
			) {
				throw new Error(
					`Image build for ${resp.imageId} terminated due to external shut-down. Please try again.`,
				);
			} else if (
				result.status === GenericResult_GenericStatus.GENERIC_STATUS_TIMEOUT
			) {
				throw new Error(
					`Image build for ${resp.imageId} timed out. Please try again with a larger timeout parameter.`,
				);
			} else if (
				result.status !== GenericResult_GenericStatus.GENERIC_STATUS_SUCCESS
			) {
				throw new Error(
					`Image build for ${resp.imageId} failed with unknown status: ${result.status}`,
				);
			}

			// 次のレイヤーのベースイメージとして使用
			baseImageId = resp.imageId;
		}
		if (!baseImageId)
			throw new Error("No image ID produced after building layers");
		this.#imageId = baseImageId;
		this.#client.logger.debug("Image build completed", "image_id", baseImageId);
		return this;
	}

	/**
	 * @description 既に参照済みの Image handle を返す Python 互換 helper
	 */
	async hydrate(): Promise<Image> {
		if (this.#imageId === "") {
			throw new InvalidError(
				"Images cannot currently be hydrated on demand; build the Image by running an App that uses it.",
			);
		}
		return this;
	}

	/**
	 * @description ビルド済み Image を安定した名前とタグで publish する
	 * @param name - publish する Image 名。`name:tag` 形式も指定可能。タグ未指定時は `latest`
	 * @param params - オプションパラメータ
	 */
	async publish(name: string, params: ImagePublishParams = {}): Promise<void> {
		const tag = parseNamedImageRef(name);

		if (this.#imageId === "") {
			throw new InvalidError(
				"Cannot publish an image that has not been built yet. Call build() first.",
			);
		}

		await this.#client.cpClient.imagePublish({
			imageId: this.#imageId,
			environmentName: this.#client.environmentName(params.environment),
			isPublic: false,
			tag,
		});
	}
}
