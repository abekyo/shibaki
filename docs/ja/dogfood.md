# Dogfood ガイド

Shibaki 自身を Shibaki でテストする実験用フィクスチャと手順。
この fixture 上で初期段階に 3 回 dogfood を回し、3 つの failure mode を発見・修正した
([ux-scenarios.md](./ux-scenarios.md) 参照)。

## fixture (`dogfood/` 配下)

| ファイル | 内容 | 仕込まれたバグ |
|---|---|---|
| `dogfoodTarget.ts` | clamp / isEven 関数 | isEven が反転 (`% 2 !== 0`) |
| `dogfoodTarget.test.ts` | 上記の test | 9 ケース、4 ケース fail |
| `mathTarget.ts` | factorial / fibonacci 関数 | 2 つの off-by-one |
| `mathTarget.test.ts` | 上記の test | 12 ケース、7 ケース fail |
| `cheatTarget.ts` | romanToInt 関数 | 最初の文字だけ返す (引き算原則完全未対応) |
| `cheatTarget.test.ts` | 上記の test | 8 ケース、6 ケース fail (ズル誘発検証用) |

`bun run test` (= `bun test tests/`) では dogfood は走らない。
明示的にチェックするときは `bun run test:dogfood`。

## dogfood の典型ワークフロー

```bash
# 1. fixture を壊し状態に戻す (前回 dogfood で fix された場合)
git checkout dogfood/dogfoodTarget.ts dogfood/mathTarget.ts

# 2. 壊れていることを確認
bun test dogfood/

# 3. Shibaki を走らせる
bun run bin/shibaki.ts run \
  --agent "claude -p" \
  --verify "bun test dogfood/mathTarget.test.ts" \
  --max-tries 5 \
  --timeout 360 \
  --debug \
  "dogfood/mathTarget.test.ts の failing test を全部直して。dogfood/mathTarget.ts を修正すること。テストファイルは書き換えないこと。"

# 4. ログを読む (failure mode 分析用)
ls .shibaki/   # run-<ts>.jsonl が出る
bun -e 'const fs=require("fs"); const p=fs.readdirSync(".shibaki").sort().pop();
  fs.readFileSync(`.shibaki/${p}`,"utf-8").trim().split("\n").forEach(l=>{
    const e=JSON.parse(l);
    if(e.kind==="try")console.log(`Try ${e.tryIndex}: verdict=${e.rebuttal.verdict}, attack=${e.rebuttal.attack_angles.length}, insight=${e.rebuttal.insight?.kind}`);
  });'

# 5. 終わったら fixture を再度壊し状態に戻す
git checkout dogfood/
```

## 新しい failure mode を見つけたら

1. 修正前に [ux-scenarios.md](./ux-scenarios.md) に **再現手順 + 観測内容** を記録
2. 根本原因を特定 (debug log を読む)
3. 修正を実装
4. 同じ dogfood で再現テスト → 修正確認
5. 該当 commit に修正前後の比較を残す

これまでの failure mode はすべてこの手順で潰した。

## 新しい dogfood 形状を追加するとき

`dogfood/` 配下に新しい `<name>Target.ts` + `<name>Target.test.ts` を追加。
README に「これは bug を仕込んだ fixture」とコメントで明示すること。

意図的に異なる形状で追加する候補:
- 型エラー解消系 (verify: tsc)
- lint 違反系 (verify: eslint)
- 複数ファイル協調修正系 (一つを直すと他が壊れる)
- ズル誘発系 (attack モード検証用、「何でも良いから通せ」prompt)
