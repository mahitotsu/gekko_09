# opusplan を CLAUDE.md で運用する

Claude Code の `opusplan`（計画は Opus、実行は Sonnet）を、CLAUDE.md の基準で使い分けると、Opus 単独と比べて何が得られ、何を失うかを測りました。このリポジトリには、結論、設定のサンプル、測定の結果、再現用の評価（Agent SDK）があります。

## 結論

- **仕組みは期待どおり動きます。** CLAUDE.md に「計画モードに入る基準」を書いておくと、エージェント（Sonnet）が必要なときに自分で計画モードに入ります。計画中だけ Opus が応答し、承認の後の実行は Sonnet に戻ります。画面で権限モードを plan に切り替えておく必要も、最初に入る必要もありません。質問や1か所の修正では入らず、Sonnet だけで答えます。
- **長い作業では、時間も費用も下がります。** 要件定義から報告書までを1回の依頼で作る通しの作業（invoice の auto）は、Opus 単独の 0.61 倍の時間、0.55 倍の費用でした（各3回、すべて合格）。
- **質問は安くなります。** 費用は Opus 単独より約 4〜6 割低くなります（Sonnet が答えるため）。コードを追う質問、原因・方針の判断を含む質問でも、必要な要点は落ちませんでした。ただし、Opus 単独は「ついでに別の欠陥に気づく」ことが多くありました。
- **短い作業は割高です。** 小さな文書（設計メモ、利用ガイド）では、費用が Opus 単独の約 1.6〜1.8 倍、時間が 1.0〜1.6 倍です。計画の書き出しと、切り替えのたびのキャッシュの書き直しが、Sonnet で書く分の節約を上回ります。
- **文書の質は、Opus に近づきますが並びません。** 要件定義・設計書は採点で満点でしたが、順番を入れ替えた比較では、Opus 単独の勝ちが 2、`opusplan` の勝ちが 0、残りは割れや引き分けでした。Sonnet 単独が書いた文書と比べると、要件定義では良い傾向でしたが、設計書では負ける回もありました。
- **CLAUDE.md の書き方は、サンプルのもので足ります。** 手がかり（成果物の数、資料の数）で書き直した案は、取っておいた課題でサンプルを下回りました。

### 運用の推奨

条件つきで採ります。
- 向く使い方: 質問や小さな修正が多く、ときどき長い実装や、複数の資料にまたがる作業が入る。
- 文書の質を最優先する依頼は、Opus 単独のセッションで書くほうが確実です。
- 小さな文書を続けて書く使い方では、`opusplan` は割高になります。

標本は小さく（多くが各 1〜3 回）、傾向の目安です。測定の方法、結果の表、未確認の項目は [docs/findings.md](docs/findings.md) にあります。

## 設定のサンプル

[examples/user/](examples/user/) に、ユーザー単位の設定のサンプルを置いています。

| サンプル | コピー先 | 内容 |
|---|---|---|
| [settings.json.example](examples/user/settings.json.example) | `~/.claude/settings.json` | `"model": "opusplan"` |
| [CLAUDE.md.example](examples/user/CLAUDE.md.example) | `~/.claude/CLAUDE.md` | 計画モードに入る基準（日本語） |

- **自動では適用されません。** 拡張子が `.example` で、`.claude/` の外にあるため、Claude Code が読むことはありません。
- 適用するときは、内容を確かめてから、**手でコピー**してください。`~/.claude/settings.json` や `~/.claude/CLAUDE.md` が既にある場合は、上書きせずに、必要な行を取り込んでください。
- プロジェクトだけに適用するなら、`.claude/settings.local.json` に `"model": "opusplan"`、プロジェクトの `CLAUDE.md` に同じ内容を置きます。
- VS Code 拡張では、モデルの選択画面に `opusplan` は出ませんが、`settings.json` の `model` に書けば効きます。
- 評価（[eval/run.ts](eval/run.ts)）も、同じ `CLAUDE.md.example` を読みます。サンプルを編集すれば、評価の条件も変わります。

## 再現

必要なもの: Docker（または podman）、サブスクリプションの OAuth トークン（`claude setup-token`）。トークンはリポジトリ直下の `.env`（[.env.example](.env.example) を参考）に書きます。`.env` は git に入りません。実行は、サブスクリプションの利用量を消費します。

```sh
npm install
npm test                                              # 評価の道具のユニットテスト
container/run.sh                                      # 環境を記録する（モデルの呼び出しなし）
container/run.sh npx tsx eval/run.ts --arms opus,opusplan --tasks e2-addtax-file,d1-inventory-design --reps 1
container/run.sh npx tsx eval/run.ts --arms opus,opusplan --tasks invoice/auto --reps 3
npx tsx eval/report.ts eval/results/<日時>.jsonl      # 費用・時間の集計
npx tsx eval/grade-docs.ts eval/results/<日時>.jsonl  # 文書の採点（モデルを呼ぶ）
```

- 課題は [eval/tasks.ts](eval/tasks.ts)、比較対象（arm）は `opus`・`sonnet`・`haiku`・`opusplan`。
- 結果は `eval/results/`（git に入りません）に出ます。結論の根拠にした結果は [eval/published/](eval/published/) にあります。
- 測定は Claude Code 2.1.295 / Agent SDK 0.3.295 で行いました。現在の依存は 0.3.302（Claude Code 2.1.302）で、測定のやり直しはしていません（テストと環境の記録のみ）。
- 古い SDK（0.3.295 以前）は、Sonnet 5.5 のキャッシュ読み取りを $0.20 と数え、ログの費用（`total_cost_usd`）が Sonnet で高く出ます（公式は $0.10。0.3.302 で修正）。この評価は、トークン数から公式単価で計算し直します（[eval/cost.ts](eval/cost.ts)）。

## 構成

```
examples/user/   ユーザー単位の設定のサンプル
docs/findings.md 測定の方法と結果
eval/            評価（課題、採点、費用の集計）
eval/published/  結論の根拠にした結果
container/       評価を動かすコンテナ
```

## ライセンス

MIT（[LICENSE](LICENSE)）。
