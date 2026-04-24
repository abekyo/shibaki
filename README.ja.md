# Shibaki

> AI コーディングエージェントが頼んだ範囲を超えたら、別 AI が検出して止める。
> `--ask` を付けると、その瞬間に人間へ 30 秒で「続行 or 修正」を聞く CLI。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo.svg" alt="Shibaki" width="500">
  </picture>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[English README](./README.md)

AI agent (Claude Code / Cursor / Devin / Copilot) が頼んだ範囲を超えて作業した場合、
別 provider の AI critic がそれを検出する CLI ツール。`--ask` flag を付けると
scope drift 検出時に human に 30 秒の meta 質問を投げて軌道修正する。

[![asciicast](https://asciinema.org/a/xkALquNFdxsEkBdL.svg)](https://asciinema.org/a/xkALquNFdxsEkBdL)

設計思想は [docs/why-shibaki.md](./docs/why-shibaki.md) を参照。

---

## はじめに

Shibaki は [Bun](https://bun.sh) で動く。無いなら入れる:

```bash
curl -fsSL https://bun.sh/install | bash
```

環境チェックをする。引数なしで起動すると read-only な診断が走り、Bun /
Claude Code / API key 等の何が揃ってて何が足りないかをリストする:

```bash
bunx shibaki@latest
```

足りないものを揃える。Shibaki には 2 つの運用モードがあり、`LLM_PROVIDER_CRITICAL` を明示設定していない場合は**自動でどちらかを選ぶ**:

> **ゼロ設定 path (一番多いケース)** — `claude login` 済で critic 用 API key が env に無いなら、Shibaki が自動で Plan mode (opus critic) に切替。何も export 不要、発動時は stderr に 1 行告知される。demo はこの挙動に依存している。

**Plan mode** — API key 不要。Claude Code plan (または Gemini Code Assist / Codex plan) を流用:

```bash
# agent CLI を install + login
npm install -g @anthropic-ai/claude-code
claude login

# これで OK — Shibaki が自動で anthropic-cli を critic に選ぶ。
# CI / 再現性重視で明示固定したいなら:
export LLM_PROVIDER=anthropic-cli
export LLM_PROVIDER_CRITICAL=anthropic-cli
export LLM_MODEL_CRITICAL=opus
```

**API mode** — critic 用に別 provider の API key を取る (従来構成):

```bash
# agent CLI
npm install -g @anthropic-ai/claude-code
claude login

# critic 用 API key (agent とは別 provider)
# Gemini は無料枠あり: https://aistudio.google.com/apikey
export GEMINI_API_KEY=AIza...
export LLM_PROVIDER_CRITICAL=gemini
```

そのあと内蔵 demo を実行。Shibaki が fixture に意図的なバグを書き込んで
Claude に直させ、テストを回し直すところまで自動でやる:

```bash
bunx shibaki@latest demo
```

なぜ critic を main と別ルート (別 provider、または Plan mode なら別モデル) にするか:
「自分の出力を自分で擁護する」 self-critique blind spot を避けるため。
override 方法は [SECURITY.md](./SECURITY.md)。

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
  --ask \
  "tests/auth.test.ts の failing test を直して"
```

`shibaki` コマンドを使うには:

```bash
# 方法 A: bun link でグローバル登録
cd shibaki && bun link
cd /any/where && shibaki --help

# 方法 B: フルパスで呼ぶ
bun run /path/to/shibaki/bin/shibaki.ts ...
```

---

## Options (`shibaki run`)

| flag | 用途 |
|---|---|
| `--agent <cmd>` | 実作業エージェント。例: `"claude -p"` / `"aider --message-file -"` |
| `--verify <cmd>` | 完遂判定コマンド。**exit 0 が必須**。例: `"bun test"` / `"tsc --noEmit"` |
| `--ask` | scope drift 検出時に human に 1 行 meta 質問 |
| `--max-tries <n>` | 最大試行回数 (default 10) |
| `--timeout <sec>` | タスク全体タイムアウト (default 1800) |
| `--dry-run` | 受理判定だけ行い、実行しない |
| `--debug` | `.shibaki/run-<ts>.jsonl` に critic 内部ログを記録 |

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

詳細: [docs/scope.md](./docs/scope.md)

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
