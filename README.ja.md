# Shibaki

> AI コーディングエージェントが頼んだ範囲を超えたら、別 AI が検出して止める。
> `--ask-human` を付けると、その瞬間に人間へ 30 秒で「続行 or 修正」を聞く CLI。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo.svg" alt="Shibaki" width="500">
  </picture>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[English README](./README.md)

AI エージェントに「失敗してるテストを 1 つ直して」と頼んだとする。
返ってくるのは — テスト修正 **＋** リファクタ **＋** 新しい防御的コード
**＋** ヘルパクラス **＋** 全部に JSDoc。
テストは通る。コードレビューも通る。**でも頼んだのはそれじゃない。**

これが **process addiction**（プロセス中毒）— エージェントが「ユーザーが言ったこと」ではなく
「より良いコード」を最適化対象にしてしまい、元のゴールを見失う現象。
既存ツール（linter / test runner / code review bot）はこれを検知できない。
**コードは技術的にはより良くなっている**から。

Shibaki は AI critic loop に **goal alignment（ゴール整合性）軸** を追加する。
別 provider の AI critic が drift を検出し、`--ask-human` を付ければ
人間に 30 秒のメタ質問を投げて軌道修正する。

[![asciicast](https://asciinema.org/a/xkALquNFdxsEkBdL.svg)](https://asciinema.org/a/xkALquNFdxsEkBdL)

設計思想は [docs/why-shibaki.md](./docs/why-shibaki.md) を参照。

---

## 動き方

タスクと「これが exit 0 になれば完了」のシェルコマンドを渡すと、2 つの AI が
作業を往復させる — 作業役 AI がコードを編集し、別 provider の審査役 AI が
チート / 脱線をチェック。verify が通るか試行予算を使い切るまで続く。
`--ask-human` を付けると脱線検出時に人間に 30 秒のメタ質問が入り、回答が次の試行に
注入される。

```
        ┌──────────────────────────────────────────────┐
        │  あなた:                                     │
        │   ・タスク (例: 「失敗テストを直して」)      │
        │   ・「これが通れば完了」のシェルコマンド     │
        │     (例: bun test)                           │
        └─────────────────────┬────────────────────────┘
                              │
   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━┷━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ┃    ループ (最大 N 回, デフォルト 10 回)                   ┃
   ┃                                                           ┃
   ┃     ┌────────────────┐                                    ┃
   ┃     │ 作業役 AI が   │ ◄── 前回の審査役の指摘             ┃
   ┃     │ コードを編集   │     (+ ある場合は人間の一言)       ┃
   ┃     └────────┬───────┘                                    ┃
   ┃              │ 変更内容                                   ┃
   ┃              ▼                                            ┃
   ┃     ┌────────────────────┐                                ┃
   ┃     │ シェルコマンド実行 │                                ┃
   ┃     │ → exit 0?          │                                ┃
   ┃     └────────┬───────────┘                                ┃
   ┃              │                                            ┃
   ┃              ▼                                            ┃
   ┃     ┌────────────────────────┐                            ┃
   ┃     │ 審査役 AI が判定       │                            ┃
   ┃     │ 「本当にやった？」     │                            ┃
   ┃     └─┬──────────┬───────┬──┘                             ┃
   ┃       │承認       │却下   │「脱線」と判定                 ┃
   ┃       │           │       │ + --ask-human フラグ ON       ┃
   ┃       │           │       ▼                               ┃
   ┃       │           │  ┌─────────────────────────┐          ┃
   ┃       │           │  │ 人間に 1 行で確認        │         ┃
   ┃       │           │  │ (30 秒、無回答なら継続)  │         ┃
   ┃       │           │  └────────────┬────────────┘          ┃
   ┃       │           │               │                       ┃
   ┃       │           └───────────────┤ 指摘 (+ 人間の一言)   ┃
   ┃       │                           │  を作業役に渡して     ┃
   ┃       │                           │  次の試行へ           ┃
   ┃       │                           │                       ┃
   ┗━━━━━━━│═══════════════════════════│═══════════════════════┛
           ▼                           ▼
        ✓ 完了                    N 回使い切ったら ✗ 失敗
```

- **承認** = verify が exit 0 で、審査役もチート / 脱線を見つけなかった場合。
- **却下** = 審査役がチート（test skip、`@ts-ignore` で型エラー黙殺、verify を
  通すための test file 改ざん 等）を検出。指摘を作業役に渡して次の試行へ。
- **「脱線」と判定** = 作業役が頼まれた範囲を超えて作業した場合。`--ask-human` 無しなら
  ログに残るだけ、`--ask-human` 有りなら人間に 30 秒の確認が走る。

---

## Scope

### 受理するタスク
- failing test を直す (`--verify "bun test ..."`)
- 型エラーを消す (`--verify "tsc --noEmit"`)
- lint 違反を直す (`--verify "eslint ..."`)
- ビルドを通す (`--verify "bun run build"`)
- 任意のスクリプトの exit 0 を保証する

### 受理しないタスク (`--verify` 必須で断る)
- 「コードを綺麗にして」等の曖昧タスク
- リファクタ (挙動不変の担保が困難)
- UI 文言 / 命名等の主観タスク

> **25 秒で動作を見る**: [bench/verify-bypass/](./bench/verify-bypass/) — exit
> code だけを信じるループでは見逃される test 削除 bypass を、shibaki の critic
> が捕まえる再現可能なデモ。

詳細: [docs/ja/scope.md](./docs/ja/scope.md)

---

## はじめに

3 ステップ。**API key 不要**。

```bash
# 1. Claude Code (login 済みならスキップ)
npm install -g @anthropic-ai/claude-code && claude login

# 2. Bun (install 済みならスキップ)
curl -fsSL https://bun.sh/install | bash

# 3. demo を走らせる
bunx shibaki-cli@latest demo
```

demo は小さな fixture に対して Claude を走らせ、AI 同士の対話をリアルタイム
で表示する：各試行ごとに `✓ critic approves` か `✗ critic slaps` が出て、
verdict / attack angles / evidence / 1 行 insight を見せる — 実タスクで
critic loop が出力する内容そのもの。Shibaki が PATH 上の `claude` を
自動検出して opus tier を critic に割り当てる — env 設定も API key も
要らない。

> **クロスプロバイダ原則についての注意。** Plan mode では agent と critic が
> 両方 Claude（sonnet と opus の tier 違い）— **同 provider・別モデル**。
> これは Shibaki の本来の「異 provider 強制」原則の緩和版です。完全な
> クロスプロバイダ強制（本格運用 / CI 用途で推奨）が必要なら、下の **API
> mode** を使ってください。

<details>
<summary>診断、明示固定、API mode (cross-provider)、グローバル install</summary>

### 診断

引数なしで起動すると read-only な診断が走り、Bun / Claude Code / API key 等の
何が揃ってて何が足りないかをリストする:

```bash
bunx shibaki-cli@latest
```

### Plan mode — 明示固定（CI / 再現性）

上の自動検出は便利だが CI では非決定的。明示的に pin する:

```bash
export LLM_PROVIDER=anthropic-cli
export LLM_PROVIDER_CRITICAL=anthropic-cli
export LLM_MODEL_CRITICAL=opus
```

### API mode — 別 provider critic（完全クロスプロバイダ）

agent は Claude のまま、critic を別 provider に。これが Shibaki の本来想定する
**構造的クロスプロバイダ**モード。

```bash
# critic 用 API key (agent とは別 provider)
# Gemini は無料枠あり: https://aistudio.google.com/apikey
export GEMINI_API_KEY=AIza...
export LLM_PROVIDER_CRITICAL=gemini
```

他のサポート critic provider: OpenAI (`OPENAI_API_KEY`), Anthropic API
(`ANTHROPIC_API_KEY`)。

### グローバル install (任意)

`bunx` prefix なしで `shibaki` を直接呼びたい場合:

```bash
bun add -g shibaki-cli
# clone 済みなら:
cd shibaki && bun link
```

### なぜ critic を別 provider にするか

「自分の出力を自分で擁護する」 self-critique blind spot を避けるため。
override 方法（`SHIBAKI_ALLOW_SAME_PROVIDER` 等）は [SECURITY.md](./SECURITY.md)。

</details>

---

## Usage

```bash
# 基本: failing test を直すタスクを走らせる
shibaki run \
  --agent "claude -p" \
  --verify "bun test tests/auth.test.ts" \
  "tests/auth.test.ts の failing test を直して"

# scope drift 検出時に human に 30 秒質問する
shibaki run \
  --agent "claude -p" \
  --verify "bun test tests/auth.test.ts" \
  --ask-human \
  "tests/auth.test.ts の failing test を直して"
```

---

## Options (`shibaki run`)

| flag | 用途 |
|---|---|
| `--agent <cmd>` | 実作業エージェント。例: `"claude -p"` / `"aider --message-file -"` |
| `--verify <cmd>` | 完遂判定コマンド。**exit 0 が必須**。例: `"bun test"` / `"tsc --noEmit"` |
| `--ask-human` | scope drift 検出時に human に 1 行 meta 質問 (alias: `--ask`) |
| `--max-tries <n>` | 最大試行回数 (default 10) |
| `--timeout <sec>` | タスク全体タイムアウト (default 1800) |
| `--dry-run` | 受理判定だけ行い、実行しない |
| `--debug` | `~/.shibaki/logs/<project>-<ts>.jsonl` に critic 内部ログを記録 |

---

## Subcommand: `shibaki audit-publish`

OSS push / npm publish の **直前に 1 回** 走らせる leak detector。
critic loop とは独立した deterministic layer。

```bash
shibaki audit-publish .

# gitleaks 併用版 (推奨)
brew install gitleaks
./scripts/audit-publish.sh .
```

検出対象:
- 既知 secret pattern (OpenAI / Anthropic / GitHub / AWS / Stripe 等の API key, PEM key, JWT)
- ユーザー禁止語 (`.shibaki/sensitive-strings.txt` の各行)
- git commit message / author / committer 内の上記

詳細: [SECURITY.md](./SECURITY.md)

---

## Configuration (運用モード)

### Plan mode — API key 不要

ローカル CLI (login 済) を main と critic の両方に使う。
blind-spot 緩和は **モデル階層** で行う (例: main=sonnet, critic=opus)。

| モード | main agent | critic | 必要な env |
|---|---|---|---|
| **Claude Code plan** (実機検証済) | `claude -p --model sonnet` | `anthropic-cli` (opus) | `LLM_PROVIDER=anthropic-cli`, `LLM_PROVIDER_CRITICAL=anthropic-cli`, `LLM_MODEL_CRITICAL=opus` |
| Gemini Code Assist (experimental) | `gemini` | `gemini-cli` | `LLM_PROVIDER=gemini-cli`, `LLM_PROVIDER_CRITICAL=gemini-cli` |
| Codex plan (experimental) | `codex` | `codex-cli` | `LLM_PROVIDER=codex-cli`, `LLM_PROVIDER_CRITICAL=codex-cli` |

> **Experimental の注記**: `gemini-cli` と `codex-cli` は特定の flag 形式 (`gemini -p --model X` / `codex exec --model X --skip-git-repo-check`) を前提にしている。CLI バージョンで flag 体系が変わるケースがあるため、呼び出し失敗時はベンダ CLI のバージョン調整 or shell script wrapper を作って `GEMINI_CLI_BIN` / `CODEX_CLI_BIN` で差し替えてほしい。`anthropic-cli` (claude) が実機検証済の path。

Plan mode では同 family の main/critic は自動許容される (モデルを変えて blind spot を
緩和する前提)。CLI bin 名が違う場合は `CLAUDE_CLI_BIN` / `GEMINI_CLI_BIN` /
`CODEX_CLI_BIN` で差し替え可能。

### API mode — critic 用 API key あり

| モード | main agent | critic | 必要な API key |
|---|---|---|---|
| **Gemini critic (おすすめ)** | Claude Code plan (`claude -p`) | Gemini API | `GEMINI_API_KEY` + `LLM_PROVIDER_CRITICAL=gemini` |
| OpenAI critic | Claude Code plan | OpenAI API | `OPENAI_API_KEY` |
| Anthropic critic | Claude Code plan | Anthropic API | `ANTHROPIC_API_KEY` (plan とは別契約) |
| Full-API | Anthropic API | OpenAI / Gemini API | 両方 |

API mode では main provider と critic provider が同一 family の場合に起動時拒否
(`SHIBAKI_ALLOW_SAME_PROVIDER=1` で opt-out)。

---

## Documentation

英語版が docs/ 配下、日本語版が docs/ja/ 配下にあります。

**[はじめに](#はじめに) より深く知りたいなら [docs/ja/ux-scenarios.md](./docs/ja/ux-scenarios.md)** — Shibaki を実際に走らせた時の体験を、エンドツーエンドで具体的にトレースしています。

**コンセプト** (なぜ Shibaki が要るのか、何を約束するか)
- [docs/ja/why-shibaki.md](./docs/ja/why-shibaki.md) — 設計思想
- [docs/ja/one-loop-contract.md](./docs/ja/one-loop-contract.md) — ユーザーとの契約
- [docs/ja/scope.md](./docs/ja/scope.md) — 受理 / 拒否の境界

**リファレンス** (内部に何が埋め込まれているか、どう評価されているか)
- [docs/ja/critic-patterns.md](./docs/ja/critic-patterns.md) — critic が encode している 30 手の pattern (field data)
- [docs/ja/self-verification.md](./docs/ja/self-verification.md) — 自己検証 (率直な実測評価)
- [SECURITY.md](./SECURITY.md) — security model + safety override 環境変数

**運用** (実戦で動かすために)
- [docs/ja/dogfood.md](./docs/ja/dogfood.md) — 自己テスト手順
- [CONTRIBUTING.md](./CONTRIBUTING.md) — コントリビューションガイド (言語ポリシー / リリース手順)

---

## License

MIT — see [LICENSE](./LICENSE).

Built by [Opportunity Inc.](https://www.opport.jp/) — contact: [info@opport.jp](mailto:info@opport.jp)
