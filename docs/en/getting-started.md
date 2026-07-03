# Getting Started

## Install

```bash
npm install modal-ts
```

## Authentication

Set Modal credentials with environment variables or `~/.modal.toml`:

```bash
export MODAL_TOKEN_ID=ak-...
export MODAL_TOKEN_SECRET=as-...
```

## Basic usage

```typescript
import { ModalClient } from "modal-ts";

const modal = new ModalClient();

const echo = await modal.functions.fromName("my-app", "echo");
const result = await echo.remote(["Hello world!"]);
console.log(result);
```

## Run a sandbox

```typescript
import { ModalClient } from "modal-ts";

const modal = new ModalClient();

const app = await modal.apps.fromName("my-app", { createIfMissing: true });
const image = modal.images.fromRegistry("alpine:3.21");
const sb = await modal.sandboxes.create(app, image, { command: ["echo", "hi"] });

console.log(await sb.stdout.readText());
await sb.terminate();
```

