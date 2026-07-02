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
