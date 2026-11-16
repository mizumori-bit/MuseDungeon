# MuseDungeon 実装計画（実装担当への引き継ぎ）

設計: [DESIGN.md](DESIGN.md) ／ 仕様: [PROTOCOL.md](PROTOCOL.md) ／ 画像アセット: [ASSET_SPEC.md](ASSET_SPEC.md)

この文書は実装の順序と、各段階の「完了の定義」を定める。設計判断は済んでいるので、迷ったら設計書に従い、設計書が現実に合わない場合は**先に設計書を直してから**実装する。

## 0. 現状

- M0〜M7 を実装済み（2026-11-16）。起動方法と MetaMuse の接続設定は `README.md`。設計からの確定事項・差分は DESIGN.md §12。
- 改善 v2（V2-1〜V2-5: ターン契約・遠征・ホスト駆動・休憩と敵の耐久・探索密度）を実装済み（2026-11-16）。確定した設計は DESIGN.md §13、プロトコルは PROTOCOL.md。経緯は [IMPROVEMENTS_V2.md](IMPROVEMENTS_V2.md)。
- 環境: Windows 11、Node.js 22.14、npm。シェルは PowerShell。Makefile や WSL 前提の仕組みは使わない。

### 完了の確認方法

PowerShell では `npm run <script> -- --flag` の `--` を PowerShell が消すため、オプションが届かない。**PowerShell では `npm.cmd run <script> -- --flag` と書く**（または `npx tsx packages/tools/src/cli.ts <command> --flag`）。

| 項目 | コマンド |
|---|---|
| 型検査・lint（境界ルール） | `npm run typecheck` / `npm run lint` |
| テスト（決定論・畳み込み等価・漏洩・MCP 契約と turn ブロック・対等性・COOP・復旧・ゴールデンリプレイ・生成不変条件 60 シード・bot 12 ラン・遠征の一周・目標階の配置・休憩の見積もり・実ダメージ・ドライバ） | `npm test` |
| 完全版（生成 1,000 シード × 深度 1〜50、bot 100 ラン、漏洩 20 ラン、目標階の配置 300 シード） | `npm run test:full`、または `npm.cmd run gen:check -- --seeds 1000 --depth 50` と `npm.cmd run bot -- --runs 100` |
| テンポの計測（V2-5） | `npm.cmd run pacing -- --runs 100` |
| ホスト駆動（V2-3） | サーバー起動中に `npm.cmd run drive -- --new-run Bot`（内蔵ダミー）。`--token <player_token>` で既存のランを引き継ぐ |
| 記録の再実行検証 | `npm.cmd run replay:verify -- <runId>` |
| アセット | `npm run assets:checklist` / `npm.cmd run assets:check -- packages/client/public/themes/sample` |

## 1. 守るべき不変条件（レビュー観点）

1. World を書き換えるのは `shared/applyEvent` だけ。
2. `engine` に `Math.random`・`Date`・浮動小数・I/O を入れない。乱数は名前付きストリーム経由のみ。
3. プレイヤー向けの出力は必ず `projectPlayerView` を通る。MCP／WS のプレイヤー側コードが World を直接読まない。
4. `client` は `engine` を import しない。
5. AI と人間は同じ `Command`・同じ `PlayerPort` を使う。片方専用の近道を作らない。
6. コンテンツの追加にコア側の enum や switch の変更を要求しない（レジストリ＋データ）。
7. エンティティ走査は挿入順。`Object.keys` の順序や Set の偶然に依存しない。

## 2. マイルストーン

各マイルストーンは「テストが通り、下記の確認ができる」状態で区切る。M3 完了時点で MetaMuse がプレイでき、M5 完了時点で基本ループ（探索 → 観測 → 判断 → 行動 → 状態変化 → ログ → 観戦／リプレイ）が成立する。

### M0 土台

- npm workspaces、TypeScript strict、project references、vitest、ESLint（§1 の境界ルールを設定）。
- `shared`: 基本型、zod スキーマ、PRNG（`sfc32`・`cyrb128`・名前付きストリーム）、正準 JSON とハッシュ。
- 完了: `npm test` と `npm run lint` が通る。境界違反の import を書くと lint が落ちることを確認。

### M1 エンジン中核（固定マップで動く）

- World／Entity／Event 型、`applyEvent`、`step`、スケジューラ（速度・`nextActAt`・フロア時計）。
- 行動: move（バンプ攻撃・扉）、wait、pickup、drop、equip、use、throw、interact、stairs。
- FOV、`knowledge_updated`、`seenBy` 付与、戦闘、状態異常、XP、死亡。
- モンスター AI（状態機械＋ archetype 2 種以上）。
- `projectPlayerView`、`filterEventsForPlayer`。
- 完了: 手書きのテストマップ上で、決定論テスト・畳み込み等価テスト・漏洩テストが通る。

### M2 コンテンツと生成

- `content` のスキーマ・ローダ・レジストリ。DESIGN §6.6 の MVP コンテンツ。
- 生成パイプライン全段、レイアウト生成器 2 種、prefab、spawn／loot、validate と再試行、深層スケーリング。
- 未鑑定アイテム、モンスターの思い出。
- `tools`: ヘッドレスランナー、ベースライン bot（ランダム／貪欲）、フロアを ASCII で吐くシード調査 CLI。
- 完了: 生成不変条件テスト（1,000 シード × 深度 1〜50）が通る。貪欲 bot が 100 ランをクラッシュ無しで完走し、平均到達深度が出力される。

### M3 サーバーと MCP（MetaMuse がプレイできる）

- `RunSession`、`PlayerPort`、LogWriter（commands／events／keyframes／meta／summary）、クラッシュ復旧。
- MCP アダプタ（Streamable HTTP `/mcp`）と `muse-mcp-stdio` ブリッジ。PROTOCOL §2 の全ツール。
- Observation 整形（JSON＋テキスト、brief／full）、`narrate`（ja／en）、`alerts`、`valid_actions`、`shared/nav`、マクロ行動。
- `get_rules` の本文。
- 完了: MCP 契約テストが通る。MCP クライアント（MCP Inspector 等）から `new_run` → `explore`／`move` → 死亡または数階層踏破まで手動で通せる。`runs/<id>/` にログ一式が残り、`commands.jsonl` の再実行で `events.jsonl` と一致する。

### M4 ライブ観戦

- `SpectatorPort`、WS、HTTP API。
- `client`: ViewStore（スナップショット＋ `applyEvent`）、`Renderer` インターフェース、`glyph` テーマ、観戦画面（俯瞰／追従、ステータス、メッセージ、AI パネル）。
- テーマ読み込み（[ASSET_SPEC.md](ASSET_SPEC.md) の `theme.json`、解決順、`glyph` へのフォールバック）、公開カタログ、`tools` の `assets:checklist`／`assets:check`。画像そのものは別途制作されるので、検証用に数枚のダミー画像を持つ最小テーマを 1 つ用意して読み込み経路を確認する。向き・アニメーション・オートタイルの対応は M7 でもよい。
- 完了: bot または MCP でプレイ中のランをブラウザで開き、遅延なく追従表示される。追従視点で未探索領域が描かれない。画像が一部しか無いテーマでも、残りが `glyph` 表示で欠けずに描かれる。未鑑定アイテムが本当の種別の画像で描かれない。

### M5 リプレイ

- `ReplayPort`、マーカー索引、リプレイ画面（再生／停止、0.25x〜16x、1 手送り、タイムラインのシーク、マーカージャンプ、視点切替、thought 表示）。
- ゴールデンリプレイテスト。
- 完了: 終了済みランを任意の時点へシークでき、最終状態ハッシュが記録と一致する。進行中のランも巻き戻して見られる。

### M6 人間プレイと複数プレイヤー

- プレイ画面（キーボード・クリック、所持品 UI）。人間が単独でランを開始できる。
- 複数プレイヤー: `join_run`、同一フロアの手番待ち、`turnTimeoutMs`、位置交換、`say`、死亡者の観戦移行。
- 完了: 対等性テストが通る。人間 1 人でブラウザから最後まで遊べる。bot 2 体の同一ラン参加テストが通る。人間と MCP クライアントが同じランに入り、双方が行動できる。

### M7 仕上げ

- ロビー、リーダーボード、`summary.md`（冒険の記録）、`spectatorPolicy`、README（起動方法と MetaMuse 接続設定例）。

## 3. 実装上の注意

- **最初に `shared` の型と `applyEvent` を固める。** イベント種別の追加は安いが、既存イベントの意味変更は過去リプレイを壊す。変更時は `eventVersion` を上げ、旧版 reducer を残す。
- **Observation のトークン量を計測する。** bot ランで brief／full の文字数分布をテスト出力に含め、目安（PROTOCOL §3）を超えたら整形を見直す。
- **MCP の待ち合わせ**: 行動ツールは次の自分の手番まで待って返す。ソロではモンスターの処理が同期的に終わるので即時に返る。
- **ログ書き込み**は追記のみで、イベント適用と同じ順序で flush する。キーフレームは別ファイルに書き、書き終えてからリネームする。
- **テーマと名前の分離**: 表示名は content の `name.{ja,en}`、見た目は client のテーマ。engine は名前も見た目も参照しない。
- **決定論の落とし穴**: 配列の sort には必ず全順序の比較関数を渡す。経路探索の同値タイブレークを固定する。JSON の数値は安全な整数範囲に収める。

## 3.5 改善 v2（実装済み）

MVP（M0〜M7）の後の作業は [IMPROVEMENTS_V2.md](IMPROVEMENTS_V2.md) に定める。順序と完了の定義は同書 §8（V2-1 ターン契約 → V2-2 遠征 → V2-3 ホスト駆動 → V2-4 休憩と敵の耐久 → V2-5 探索密度）。完了の定義に対応するテスト:

| 段階 | 確認 |
|---|---|
| V2-1 | `server.test.ts`「turn contract」: 全ツールの応答に `turn` と末尾の `▶` 行、終了後は `awaiting: 'nothing'`。漏洩テストは `turn`・ブリーフィングも対象 |
| V2-2 | `tools.test.ts`「expeditions」: 貪欲 bot が 遠征開始 → 達成 → 帰還 → キャンプ → 次の遠征 を通し、畳み込み等価と復旧の一致も確認。目標階に守護者／遺物が必ずあり到達可能（40 シード、完全版 300 シード）。`server.test.ts` で MCP 経由の extract／撤退／キャンプ／再開 |
| V2-3 | `tools.test.ts`「host drive」: ダミーのエージェントで無人で 1 遠征が終わる。上限で中断してから再実行すると続きから進む |
| V2-4 | `tools.test.ts`「rest and enemy durability」: `rest_estimate` の手数・回復量・時間が実際の rest と一致。とどめの表示が実ダメージ。`hpSeen` が記録され推定に使われる |
| V2-5 | 生成不変条件テストが新しい寸法で通る。テンポの計測結果は DESIGN.md §13.6 |

V2-1 と V2-2 が終わったので、MetaMuse による再評価ができる。

## 4. 設計時に置いた前提（必要なら依頼者に確認）

| 前提 | 影響範囲 |
|---|---|
| MetaMuse は標準的な MCP クライアントで、Streamable HTTP か stdio のどちらかで接続できる | 両方用意するので、どちらでも可 |
| まずはローカル（127.0.0.1）で動かす。公開運用・認証は後回し | サーバーのバインド設定とトークンのみ用意 |
| 既定の表示言語は日本語（`locale` で英語に切替可） | `narrate` と content の `name` |
| ローカル MVP では俯瞰観戦を許可する | `spectatorPolicy` の既定値 |
