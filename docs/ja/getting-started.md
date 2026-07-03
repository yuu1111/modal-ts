# はじめに

## インストール

```bash
npm install modal-ts
```

## 認証

Modal の認証情報は環境変数または `~/.modal.toml` で設定します。

```bash
export MODAL_TOKEN_ID=ak-...
export MODAL_TOKEN_SECRET=as-...
```

## 基本的な使い方

```typescript
import { ModalClient } from "modal-ts";

const modal = new ModalClient();

const echo = await modal.functions.fromName("my-app", "echo");
const result = await echo.remote(["Hello world!"]);
console.log(result);
```

## サンドボックスを実行する

```typescript
import { ModalClient } from "modal-ts";

const modal = new ModalClient();

const app = await modal.apps.fromName("my-app", { createIfMissing: true });
const image = modal.images.fromRegistry("alpine:3.21");
const sb = await modal.sandboxes.create(app, image, { command: ["echo", "hi"] });

console.log(await sb.stdout.readText());
await sb.terminate();
```

