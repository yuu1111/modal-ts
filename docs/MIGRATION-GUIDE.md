# Migration Guide for the beta Modal SDK for JS, v0.5.0

The Modal JS SDK went into beta with the version 0.5 release in October 2025. This release brings us closer to feature parity with the Python SDK (with notable exceptions like defining functions, Volume filesystem API, some Image building APIs, and Dicts not yet supported). It's a big step towards bringing JavaScript/TypeScript to the same high level of developer experience and stability as the Python SDK.

The beta release includes breaking changes to improve SDK ergonomics and align with general SDK best practices. While adapting requires some code changes, we believe these improvements make Modal easier to use going forward.

The main changes are:

- The SDK now exposes a central Modal Client object as the main entry point for interacting with Modal resources.
- The interface for working with Modal object instances (Functions, Sandboxes, Images, etc.) is largely the same as before, with some naming changes.
- Calling deployed Functions and classes now uses a new protocol for payload serialization which requires the deployed apps to use the Modal Python SDK 1.2 or newer.
- Internally removed the global client (and config/profile data in global scope), moving all that to the Client type.
- Consistent parameter naming: all `Options` interfaces renamed to `Params`.

## Calling deployed Modal Functions and classes

Starting with this version, invoking remote Functions and class methods through `.remote()` and similar uses a new serialization protocol that requires the referenced modal Apps to be deployed using the Modal Python SDK 1.2 or newer. In addition, your deployed Apps need to be on the 2025.06 image builder version or newer (see https://modal.com/settings/image-config for more information) or have the `cbor2` Python package installed in their image.

## API changes

See below for a list of all changes in [JavaScript/TypeScript](#javascripttypescript). See also the updated examples in [JS](./modal-js/examples) for a sense of how the API has changed.

## JavaScript/TypeScript

Brief example of using the new API:

```ts
import { ModalClient } from "modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});
const image = modal.images.fromRegistry("alpine:3.21");
const volume = await modal.volumes.fromName("libmodal-example-volume", {
  createIfMissing: true,
});

const sb = await modal.sandboxes.create(app, image, {
  volumes: { "/mnt/volume": volume },
});
const p = await sb.exec(["cat", "/mnt/volume/message.txt"]);
console.log(`Message: ${await p.stdout.readText()}`);
await sb.terminate();

const echo = await modal.functions.fromName("libmodal-example", "echo");
console.log(await echo.remote(["Hello world!"]));
```

### Client

```ts
import { ModalClient } from "modal";
const client = new ModalClient();
// or customized:
const client = new ModalClient({ tokenId: "...", tokenSecret: "..." });
```

- `initializeClient(...)` -> `new ModalClient(...)`

### App

- `App.lookup(...)` -> `modal.apps.fromName(...)`

### Cls

- `Cls.lookup(...)` -> `modal.cls.fromName(...)`

### Function

- `Function_.lookup(...)` -> `modal.functions.fromName(...)`

### FunctionCall

- `FunctionCall.fromId(...)` -> `modal.functionCalls.fromId(...)`

### Image

- `app.imageFromRegistry(...)` -> `modal.images.fromRegistry(...)`
- `app.imageFromAwsEcr(...)` -> `modal.images.fromAwsEcr(...)`
- `app.imageFromGcpArtifactRegistry(...)` -> `modal.images.fromGcpArtifactRegistry(...)`
- `Image.fromRegistry(...)` -> `modal.images.fromRegistry(...)`
- `Image.fromAwsEcr(...)` -> `modal.images.fromAwsEcr(...)`
- `Image.fromGcpArtifactRegistry(...)` -> `modal.images.fromGcpArtifactRegistry(...)`
- `Image.fromId(...)` -> `modal.images.fromId(...)`
- `Image.delete(...)` -> `modal.images.delete(...)`

### Proxy

- `Proxy.fromName(...)` -> `modal.proxies.fromName(...)`

### Queue

- `Queue.lookup(...)` -> `modal.queues.fromName(...)`
- `Queue.fromName(...)` -> `modal.queues.fromName(...)`
- `Queue.ephemeral(...)` -> `modal.queues.ephemeral(...)`
- `Queue.delete(...)` -> `modal.queues.delete(...)`

### Sandbox

- `app.createSandbox(image, { ... })` -> `modal.sandboxes.create(app, image, { ... })`
- `Sandbox.fromId(...)` -> `modal.sandboxes.fromId(...)`
- `Sandbox.fromName(...)` -> `modal.sandboxes.fromName(...)`
- `Sandbox.list(...)` -> `modal.sandboxes.list(...)`

### Secret

- `Secret.fromName(...)` -> `modal.secrets.fromName(...)`
- `Secret.fromObject(...)` -> `modal.secrets.fromObject(...)`

### Volume

- `Volume.fromName(...)` -> `modal.volumes.fromName(...)`
- `Volume.ephemeral(...)` -> `modal.volumes.ephemeral(...)`

### Parameter Type Renames

- `ClsOptions` -> `ClsWithOptionsParams`
- `ClsConcurrencyOptions` -> `ClsWithConcurrencyParams`
- `ClsBatchingOptions` -> `ClsWithBatchingParams`
- `DeleteOptions` -> specific `*DeleteParams` types: `QueueDeleteParams`
- `EphemeralOptions` -> specific `*EphemeralParams` types: `QueueEphemeralParams`, `VolumeEphemeralParams`
- `ExecOptions` -> `SandboxExecParams`
- `UpdateAutoscalerOptions` -> `FunctionUpdateAutoscalerParams`
- `FunctionCallGetOptions` -> `FunctionCallGetParams`
- `FunctionCallCancelOptions` -> `FunctionCallCancelParams`
- `ImageDockerfileCommandsOptions` -> `ImageDockerfileCommandsParams`
- `ImageDeleteOptions` -> `ImageDeleteParams`
- `LookupOptions` -> specific `*FromNameParams` types: `AppFromNameParams`, `ClsFromNameParams`, `FunctionFromNameParams`, `QueueFromNameParams`
- `ProxyFromNameOptions` -> `ProxyFromNameParams`
- `QueueClearOptions` -> `QueueClearParams`
- `QueueGetOptions` -> `QueueGetParams` and `QueueGetManyParams`
- `QueuePutOptions` -> `QueuePutParams` and `QueuePutManyParams`
- `QueueLenOptions` -> `QueueLenParams`
- `QueueIterateOptions` -> `QueueIterateParams`
- `SandboxCreateOptions` -> `SandboxCreateParams`
- `SandboxFromNameOptions` -> `SandboxFromNameParams`
- `SandboxListOptions` -> `SandboxListParams`
- `SecretFromNameOptions` -> `SecretFromNameParams`
- `SecretFromObjectParams` -> new export (no previous equivalent)
- `VolumeFromNameOptions` -> `VolumeFromNameParams`

### Parameter Name Changes - Unit Suffixes

Parameters now include explicit unit suffixes to make the API more self-documenting and prevent confusion about units:

- `timeout` → `timeoutMs`
- `idleTimeout` → `idleTimeoutMs`
- `scaledownWindow` → `scaledownWindowMs`
- `itemPollTimeout` → `itemPollTimeoutMs`
- `partitionTtl` → `partitionTtlMs`

- `memory` → `memoryMiB`
- `memoryLimit` → `memoryLimitMiB`

