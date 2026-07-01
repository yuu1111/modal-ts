---
name: modal-ts-release
description: modal-ts のローカル手動 npm リリース手順。リリース、npm publish、version bump、CHANGELOG 更新、dev/next release の依頼で使う。GitHub Actions の release/publish workflow は使わない。
---

# modal-ts Release

このスキルは `modal-ts` のリリースを、ローカル checkout から安全に進めるための手順である。

## 前提

- 対象は `modal-ts` リポジトリだけ。
- `package.json` の `name` が `modal-ts` であることを確認する。
- `CHANGELOG.md` はリポジトリ root のものを使う。`docs/CHANGELOG.md` は使わない。
- GitHub Actions は CI/docs 用だけとみなす。`.github/workflows/release.yaml` や `publish.yaml` がないのは正常。
- integration tests は明示依頼がない限り実行しない。

## まず確認する

並列で確認する:

- `git status --short --branch`
- `git remote -v`
- `git branch --show-current`
- `git log -1 --oneline`
- `Get-Content package.json`
- `Get-Content CHANGELOG.md`
- `Get-ChildItem .github/workflows`

未コミット変更がある場合は、リリース対象に含める変更なのかを判断する。ユーザーがリリース作業の続行を明確に求めていて、変更内容が release bump / changelog 更新だけでない場合は、勝手に巻き込まず確認する。

## バージョンを決める

ユーザーが `patch` / `minor` / `major` / 明示バージョン / `--dev` 相当を指定していればそれを使う。指定がない場合は、変更内容と `CHANGELOG.md` を見て推測してよいが、破壊的変更や判断が曖昧なら短く確認する。

通常 release:

```sh
npm version patch --no-git-tag-version
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
```

dev / prerelease:

```sh
npm version prerelease --preid=dev --no-git-tag-version
```

既に `-dev.N` の場合は `prerelease` で進める。新しく dev 系へ入る場合は `prepatch` / `preminor` / `premajor` のどれが妥当か確認する。

## CHANGELOG を更新する

`CHANGELOG.md` の `## Unreleased` に release 内容がまとまっているか確認する。空ならリリース前に内容を追加する。

release 時は次の形に整える:

```md
## Unreleased

## 0.8.2 - 2026-07-01

- ...
```

日付は現在日付を使う。過去 release の内容は勝手に大きく書き換えない。今回の release に関係する項目だけ整理する。

## 検証する

publish 前に次を実行する:

```sh
bun ci
bun run typecheck
bun biome ci .
bun run build
bun pm pack --dry-run
npm publish --dry-run
```

コード変更を含む release では、変更範囲に対応する unit test も実行する。integration tests、Modal credential が必要なテスト、sandbox/volume/queue などの遅い実環境テストは、ユーザーが明示した場合だけ実行する。

`bun pm pack --dry-run` では少なくとも次が含まれることを確認する:

- `package.json`
- `README.md`
- `README.ja.md`
- `LICENSE`
- `CHANGELOG.md`
- `dist/`

## コミット

release bump と changelog 更新は、publish 前にまとめてコミットする。

```sh
git add package.json bun.lock CHANGELOG.md
git commit -m "chore: release v0.8.2"
```

`bun.lock` は `npm version` や依存操作で実際に変わった場合だけ含める。無関係な作業ツリー変更は混ぜない。コミット後に `git status --short` と `git log -1 --oneline` を確認し、publish 対象 commit を明確にする。

## publish 直前の安全確認

`npm publish` と tag push は戻しにくいので、ユーザーが「確認なしで publish して」と明示していない限り、直前に次を短く提示して確認を取る:

- package name
- version
- npm tag (`latest` または `next`)
- publish 対象 branch / commit
- 作成する git tag

`npm whoami` が失敗する場合は publish せず、認証が必要だと報告する。
`npm view modal-ts@<version> version` で同じ version が既に存在する場合も publish しない。

## publish と tag

通常 release:

```sh
npm publish
```

dev release:

```sh
npm publish --tag next
```

publish 後、対応する git tag を作る。関係ないタグを巻き込まないため、`git push --tags` は使わない。

```sh
git tag -a v0.8.2 -m "Release v0.8.2"
git push origin HEAD
git push origin refs/tags/v0.8.2
```

タグが既に存在する場合は上書きしない。npm に同じ version が既に存在する場合も publish しない。

## 報告

最後に次を簡潔に報告する:

- published package と version
- npm tag
- git tag
- push した branch
- 実行した検証コマンド
- 実行しなかった検証があれば理由
