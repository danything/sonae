# sonae で作業する AI へ

文章 (docs・コメント・画面の文言・コミット・PR) は、denpa と同じ決まり ([danything/denpa の docs/writing.md](https://github.com/danything/denpa/blob/main/docs/writing.md)) に従って書きます。

## 作業の前に読むもの

触る所に合わせて、先に読んでください。

| 触る所                         | 読むもの                                                                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| どこでも                       | [docs/design.md](docs/design.md) (作り・情報源・通知の条件・テスト・載せ方)                                                                                                                                                             |
| 画面 (components・routes・CSS) | [docs/ui.md](docs/ui.md)・[docs/map.md](docs/map.md) と、denpa の [design.md](https://github.com/danything/denpa/blob/main/docs/design.md)・[screens.md](https://github.com/danything/denpa/blob/main/docs/screens.md) (見た目の決まり) |
| Web Push・Webhook              | [docs/push.md](docs/push.md)                                                                                                                                                                                                            |
| 立てる手順                     | [docs/install.md](docs/install.md) と `install-*.md`、[docs/entra.md](docs/entra.md)・[docs/cwa.md](docs/cwa.md)・[charts/sonae/values.yaml](charts/sonae/values.yaml)                                                                  |
| リリース                       | [docs/design.md](docs/design.md) の 8 章「家のクラスタへの載せ方」にある「リリースの前に」。**出す前に毎回、全体を読み直して矛盾と圧縮を点検する**                                                                                      |

Zero Quake のコードは読みません (README は可)。sonae は一から書いています ([README](README.md))。

## 整形

整形 (`bun fmt`) は、変えたファイルだけに掛けます。ファイルを渡さずに走らせると、リポジトリ全体を整形します。`.claude/worktrees` にあるほかの作業ツリーまで整形します (前に 2 回、そうなった)。

- 変えたファイルの一覧を先に作ってから、その一覧を渡して整形する
- **一覧が空なら、整形を走らせない**
- bun を動かすコンテナには git が無いので、一覧はホストの git で作る
- 新しく足したファイル (まだ追跡していないもの) は `git diff` に出ないので、足してから (`git add`) 一覧を作る。消したファイルは外す (`--diff-filter=d`)
- 一覧は変数に入れず、NUL 区切り (`git diff -z`) のまま `xargs -0 -r` に渡す。`-r` は、一覧が空なら何も走らせない。改行や空白を含むファイル名でも壊れない
- 一覧を `sh -c "... bun fmt $files"` のように文字列に埋め込まない。改行のあとのファイル名を、コンテナの中のシェルがコマンドとして走らせる (前に 2 回、そうなった)

```sh
# 新しく足したファイルは、先に git add <ファイル> しておく (.claude は無視していないので、git add -A は作業ツリーまで足す)
export MSYS_NO_PATHCONV=1
git diff -z --name-only --diff-filter=d origin/main -- '*.ts' '*.svelte' '*.md' '*.json' '*.css' '*.yaml' |
  xargs -0 -r wslc run --rm -v "D:/danything/sonae:/w" -w /w oven/bun:1.4.5 bun fmt
```

コンテナの中で `sh -c` を使うときは、スクリプトを単引用符で囲み、ファイル名は `"$@"` で受けます。`sh -c` の次の `sh` は `$0` になる名前で、ファイル名は `$1` から入ります。

```sh
export MSYS_NO_PATHCONV=1
git diff -z --name-only --diff-filter=d origin/main -- '*.ts' '*.svelte' '*.md' '*.json' '*.css' '*.yaml' |
  xargs -0 -r wslc run --rm -v "D:/danything/sonae:/w" -w /w oven/bun:1.4.5 sh -c 'bun fmt "$@"' sh
```
