/**
 * Lightweight metadata corresponding to Python SDK decorators
 */
export type PartialFunctionMetadata = {
	kind:
		| "method"
		| "web_endpoint"
		| "fastapi_endpoint"
		| "asgi_app"
		| "wsgi_app"
		| "web_server"
		| "enter"
		| "exit"
		| "batched"
		| "concurrent";
	options: Record<string, unknown>;
};

export const partialFunctionMetadataKey = Symbol.for(
	"modal.partialFunctionMetadata",
);

type AnyFunction = (...args: unknown[]) => unknown;

export type DecoratedFunction<T extends AnyFunction> = T & {
	[partialFunctionMetadataKey]?: PartialFunctionMetadata[];
};

type DecoratorOptions = Record<string, unknown>;

export function method<T extends AnyFunction>(fn: T): T;
export function method(
	options?: DecoratorOptions,
): <T extends AnyFunction>(fn: T) => T;
export function method<T extends AnyFunction>(arg?: T | DecoratorOptions) {
	return decoratorFactory("method", arg);
}

export function webEndpoint<T extends AnyFunction>(fn: T): T;
export function webEndpoint(
	options?: DecoratorOptions,
): <T extends AnyFunction>(fn: T) => T;
export function webEndpoint<T extends AnyFunction>(arg?: T | DecoratorOptions) {
	return decoratorFactory("web_endpoint", arg);
}

export const web_endpoint = webEndpoint;

export function fastapiEndpoint<T extends AnyFunction>(fn: T): T;
export function fastapiEndpoint(
	options?: DecoratorOptions,
): <T extends AnyFunction>(fn: T) => T;
export function fastapiEndpoint<T extends AnyFunction>(
	arg?: T | DecoratorOptions,
) {
	return decoratorFactory("fastapi_endpoint", arg);
}

export const fastapi_endpoint = fastapiEndpoint;

export function asgiApp<T extends AnyFunction>(fn: T): T;
export function asgiApp(
	options?: DecoratorOptions,
): <T extends AnyFunction>(fn: T) => T;
export function asgiApp<T extends AnyFunction>(arg?: T | DecoratorOptions) {
	return decoratorFactory("asgi_app", arg);
}

export const asgi_app = asgiApp;

export function wsgiApp<T extends AnyFunction>(fn: T): T;
export function wsgiApp(
	options?: DecoratorOptions,
): <T extends AnyFunction>(fn: T) => T;
export function wsgiApp<T extends AnyFunction>(arg?: T | DecoratorOptions) {
	return decoratorFactory("wsgi_app", arg);
}

export const wsgi_app = wsgiApp;

export function webServer<T extends AnyFunction>(fn: T): T;
export function webServer(
	options?: DecoratorOptions,
): <T extends AnyFunction>(fn: T) => T;
export function webServer<T extends AnyFunction>(arg?: T | DecoratorOptions) {
	return decoratorFactory("web_server", arg);
}

export const web_server = webServer;

export const enter = decoratorFactory.bind(
	undefined,
	"enter",
) as DecoratorEntry;
export const exit = decoratorFactory.bind(undefined, "exit") as DecoratorEntry;
export const batched = decoratorFactory.bind(
	undefined,
	"batched",
) as DecoratorEntry;
export const concurrent = decoratorFactory.bind(
	undefined,
	"concurrent",
) as DecoratorEntry;

export function parameter<T>(params: { default?: T; init?: boolean } = {}): {
	default?: T;
	init: boolean;
} {
	return { ...params, init: params.init ?? true };
}

type DecoratorEntry = {
	<T extends AnyFunction>(fn: T): T;
	(options?: DecoratorOptions): <T extends AnyFunction>(fn: T) => T;
};

function decoratorFactory<T extends AnyFunction>(
	kind: PartialFunctionMetadata["kind"],
	arg?: T | DecoratorOptions,
) {
	if (typeof arg === "function") {
		return attachMetadata(arg, kind, {});
	}
	return <U extends AnyFunction>(fn: U): U =>
		attachMetadata(fn, kind, arg ?? {});
}

function attachMetadata<T extends AnyFunction>(
	fn: T,
	kind: PartialFunctionMetadata["kind"],
	options: DecoratorOptions,
): T {
	const decorated = fn as DecoratedFunction<T>;
	decorated[partialFunctionMetadataKey] = [
		...(decorated[partialFunctionMetadataKey] ?? []),
		{ kind, options },
	];
	return fn;
}
