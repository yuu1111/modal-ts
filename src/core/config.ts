import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * @description .modal.toml の1プロファイル分の生データ
 */
interface RawProfile {
	server_url?: string;
	token_id?: string;
	token_secret?: string;
	environment?: string;
	imageBuilderVersion?: string;
	loglevel?: string;
	active?: boolean;
}

/**
 * @description .modal.toml ファイルの生データ表現
 */
interface Config {
	[profile: string]: RawProfile;
}

/**
 * @description `Config` と環境変数から解決された設定オブジェクト
 * @property serverUrl - Modal APIサーバーのURL
 * @property tokenId - 認証トークンID @optional
 * @property tokenSecret - 認証トークンシークレット @optional
 * @property environment - Modal環境名 @optional
 * @property imageBuilderVersion - イメージビルダーのバージョン @optional
 * @property logLevel - ログレベル @optional
 */
export interface Profile {
	serverUrl: string;
	tokenId?: string;
	tokenSecret?: string;
	environment?: string;
	imageBuilderVersion?: string;
	logLevel?: string;
}

/**
 * @description プロファイルのサーバーURLがローカルホストかどうかを判定する
 * @param profile - 判定対象のプロファイル
 * @returns ローカルホストの場合 true
 */
export function isLocalhost(profile: Profile): boolean {
	const url = new URL(profile.serverUrl);
	const hostname = url.hostname;
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "172.21.0.1"
	);
}

/**
 * @description Modal設定ファイル(.modal.toml)のパスを返す
 * @returns 設定ファイルの絶対パス(環境変数 MODAL_CONFIG_PATH が優先)
 */
export function configFilePath(): string {
	const configPath = process.env.MODAL_CONFIG_PATH;
	if (configPath) {
		return configPath;
	}
	return path.join(homedir(), ".modal.toml");
}

/**
 * @description 設定ファイルを読み込みパースする
 * @returns パースされた設定オブジェクト(ファイルが存在しない場合は空オブジェクト)
 */
function readConfigFile(): Config {
	try {
		const configPath = configFilePath();
		const configContent = readFileSync(configPath, {
			encoding: "utf-8",
		});
		return parseToml(configContent) as Config;
	} catch (err: unknown) {
		if (
			err instanceof Error &&
			"code" in err &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return {} as Config;
		}
		return {} as Config;
	}
}

/**
 * @description 起動時に同期的に読み込まれた設定データ
 *
 * CJS出力でのトップレベル await を避けるため同期読み込みを使用。
 * .modal.toml は小さく一度だけ読まれるためパフォーマンスへの影響は軽微。
 */
const config: Config = readConfigFile();

/**
 * @description 指定されたプロファイル名(または自動検出)から設定を解決する
 * @param profileName - プロファイル名(省略時はアクティブまたは "default" を使用)
 * @returns 環境変数とTOML設定をマージしたプロファイル
 */
export function getProfile(profileName?: string): Profile {
	if (!profileName) {
		for (const [name, profileData] of Object.entries(config)) {
			if (profileData.active) {
				profileName = name;
				break;
			}
		}
		// Fall back to "default" profile if no active profile found
		if (!profileName && Object.hasOwn(config, "default")) {
			profileName = "default";
		}
	}
	const profileData: RawProfile =
		(profileName && Object.hasOwn(config, profileName)
			? config[profileName]
			: undefined) ?? {};

	const tokenId = process.env.MODAL_TOKEN_ID || profileData.token_id;
	const tokenSecret =
		process.env.MODAL_TOKEN_SECRET || profileData.token_secret;
	const environment = process.env.MODAL_ENVIRONMENT || profileData.environment;
	const imageBuilderVersion =
		process.env.MODAL_IMAGE_BUILDER_VERSION || profileData.imageBuilderVersion;
	const logLevel = process.env.MODAL_LOGLEVEL || profileData.loglevel;

	const profile: Partial<Profile> = {
		serverUrl:
			process.env.MODAL_SERVER_URL ||
			profileData.server_url ||
			"https://api.modal.com:443",
		...(tokenId !== undefined && { tokenId }),
		...(tokenSecret !== undefined && { tokenSecret }),
		...(environment !== undefined && { environment }),
		...(imageBuilderVersion !== undefined && { imageBuilderVersion }),
		...(logLevel !== undefined && { logLevel }),
	};
	return profile as Profile;
}
