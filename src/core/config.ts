import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * @description Raw data for one .modal.toml profile
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
 * @description Raw representation of a .modal.toml file
 */
interface Config {
	[profile: string]: RawProfile;
}

/**
 * @description Settings resolved from `Config` and environment variables
 * @property serverUrl - Modal API server URL
 * @property tokenId - Auth token ID @optional
 * @property tokenSecret - Auth token secret @optional
 * @property environment - Modal environment name @optional
 * @property imageBuilderVersion - Image builder version @optional
 * @property logLevel - Log level @optional
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
 * @description Checks whether the profile server URL points to localhost
 * @param profile - Profile to check
 * @returns true when the URL points to localhost
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
 * @description Returns the Modal config file path (.modal.toml)
 * @returns Absolute config file path, preferring the MODAL_CONFIG_PATH environment variable
 */
export function configFilePath(): string {
	const configPath = process.env.MODAL_CONFIG_PATH;
	if (configPath) {
		return configPath;
	}
	return path.join(homedir(), ".modal.toml");
}

/**
 * @description Reads and parses the config file
 * @returns Parsed config object, or an empty object when the file does not exist
 */
function readConfigFile(): Config {
	try {
		const configPath = configFilePath();
		const configContent = readFileSync(configPath, {
			encoding: "utf-8",
		});
		return parseToml(configContent) as Config;
	} catch {
		return {} as Config;
	}
}

/**
 * @description Config data synchronously loaded at startup
 *
 * Synchronous loading avoids top-level await in the CJS output.
 * .modal.toml is small and read only once, so the performance impact is minor.
 */
const config: Config = readConfigFile();

/**
 * @description Resolves settings from the specified profile name or auto-detection
 * @param profileName - Profile name; when omitted, uses the active profile or "default"
 * @returns Profile merged from environment variables and TOML settings
 */
export function getProfile(profileName?: string): Profile {
	if (!profileName) {
		for (const [name, profileData] of Object.entries(config)) {
			if (profileData.active) {
				profileName = name;
				break;
			}
		}
		// Fall back to "default" when there is no active profile.
		if (!profileName && Object.hasOwn(config, "default")) {
			profileName = "default";
		}
	}
	const rawProfile: RawProfile =
		(profileName ? config[profileName] : undefined) ?? {};

	const tokenId = process.env.MODAL_TOKEN_ID || rawProfile.token_id;
	const tokenSecret = process.env.MODAL_TOKEN_SECRET || rawProfile.token_secret;
	const environment = process.env.MODAL_ENVIRONMENT || rawProfile.environment;
	const imageBuilderVersion =
		process.env.MODAL_IMAGE_BUILDER_VERSION || rawProfile.imageBuilderVersion;
	const logLevel = process.env.MODAL_LOGLEVEL || rawProfile.loglevel;

	return {
		serverUrl:
			process.env.MODAL_SERVER_URL ||
			rawProfile.server_url ||
			"https://api.modal.com:443",
		...(tokenId && { tokenId }),
		...(tokenSecret && { tokenSecret }),
		...(environment && { environment }),
		...(imageBuilderVersion && { imageBuilderVersion }),
		...(logLevel && { logLevel }),
	};
}
