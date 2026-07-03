type ParamBag = object;

function readParam(params: ParamBag | undefined, name: string): unknown {
	return (params as Record<string, unknown> | undefined)?.[name];
}

export function aliasedValue<T>(
	params: ParamBag | undefined,
	...names: string[]
): T | undefined {
	for (const name of names) {
		if (params && name in params) return readParam(params, name) as T;
	}
	return undefined;
}

export function aliasedString(
	params: ParamBag | undefined,
	...names: string[]
): string | undefined {
	for (const name of names) {
		const value = readParam(params, name);
		if (typeof value === "string") return value;
	}
	return undefined;
}

export function aliasedBoolean(
	params: ParamBag | undefined,
	...names: string[]
): boolean | undefined {
	for (const name of names) {
		const value = readParam(params, name);
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

export function aliasedNumber(
	params: ParamBag | undefined,
	...names: string[]
): number | undefined {
	for (const name of names) {
		const value = readParam(params, name);
		if (typeof value === "number") return value;
	}
	return undefined;
}

/**
 * Reads a millisecond option or converts its seconds alias to milliseconds.
 *
 * @param params - Parameter object
 * @param msName - Millisecond parameter name
 * @param secondsName - Seconds parameter name
 * @returns Milliseconds, or undefined when no alias is present
 */
export function secondsAliasToMs(
	params: ParamBag | undefined,
	msName: string,
	secondsName: string,
): number | undefined {
	const ms =
		aliasedNumber(params, msName, `${secondsName}_ms`) ??
		aliasedNumber(params, secondsName);
	if (ms === undefined) return undefined;
	return params && (msName in params || `${secondsName}_ms` in params)
		? ms
		: ms * 1000;
}

export function environmentParam(
	params: ParamBag | undefined,
): string | undefined {
	return aliasedString(
		params,
		"environment",
		"environmentName",
		"environment_name",
	);
}
