# Python SDK parity notes

This note tracks the remaining Python SDK parity decisions after the local
deploy/from_local work.

## Added compatibility surface

- `Function_.from_local()` / `Function_.fromLocal()` and `Cls.from_local()` /
  `Cls.fromLocal()` now create deployable local JavaScript/TypeScript runtimes.
- Local deploy supports inline handlers, file entrypoints, `sourceDir`, TypeScript
  transpilation, and opt-in `bundle: true` via esbuild.
- Python-style static helpers were added for resource handles where they can
  safely delegate to the default client:
  - `Image.from_id`, `Image.from_name`, `Image.from_registry`,
    `Image.from_scratch`, `Image.debian_slim`, `Image.from_dockerfile`,
    `Image.from_aws_ecr`, `Image.from_gcp_artifact_registry`, `Image.micromamba`
  - `Sandbox.create`, `Sandbox.from_id`, `Sandbox.from_name`, `Sandbox.list`
  - `Queue.ephemeral`, `Dict.ephemeral`, `Volume.ephemeral`, `Volume.rename`
  - `NetworkFileSystem.ephemeral`, `NetworkFileSystem.create_deployed`,
    `NetworkFileSystem.delete`
  - `Secret.update`
  - `SidecarContainer.name`, `SidecarContainer.object_id`
- Workspace settings gained a non-breaking manager:
  - `workspace.settings()` remains the existing method.
  - `workspace.settingsManager.list()/set()/validSettings()` and
    `workspace.settings_manager` provide the Python manager-style operations
    without changing the existing `settings()` method into a property.

## Intentionally not added yet

- `Function.app`
  - Python can expose this because function handles retain app context.
  - The TypeScript `Function_` handle currently stores function identity and
    handle metadata, but not a reliable `App` handle.
  - Adding a placeholder would be misleading; doing this correctly requires
    carrying app context through deploy/fromName/hydration paths.

- Callable `Cls(...)`
  - Python can make a `Cls` object callable and return an instance object.
  - TypeScript users currently call `cls.instance(...)`.
  - Emulating direct call syntax would require returning Proxy/function-backed
    objects instead of ordinary class instances, which is a larger API design
    change.

- `VolumeBatchUpload.resolve`
  - This is tied to Python's async context manager implementation.
  - The TypeScript upload helper has a different shape; exposing `resolve()`
    directly would not map cleanly to the existing public API.

## Current recommendation

Keep the remaining items as intentional non-parity until there is a concrete
use case that justifies a breaking or structural API change. Prefer adding
well-typed TypeScript-native affordances over name-only compatibility shims.
