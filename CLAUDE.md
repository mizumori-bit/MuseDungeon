# MuseDungeon

AI エージェント（MetaMuse 等）が MCP 経由でプレイすることを主目的としたローグライク。人間も同じ世界に 2D 画面で参加・観戦できる。

## 最初に読むもの

1. `docs/DESIGN.md` — アーキテクチャと設計判断
2. `docs/PROTOCOL.md` — MCP ツール、Observation、イベント、WS／HTTP の仕様
3. `docs/IMPLEMENTATION_PLAN.md` — マイルストーンと完了の定義
4. `docs/ASSET_SPEC.md` — 画像アセットの技術仕様（画像は別途制作。クライアント実装時に読む）
5. `docs/IMPROVEMENTS_V2.md` — AI プレイヤーの実プレイ評価を受けた改善設計（ターン契約、遠征、休憩、敵の耐久、探索密度）。実装済み（確定した内容は DESIGN.md §13）
6. `docs/IMPROVEMENTS_V3.md` — 2 回目の評価（`docs/feedback/`）を受けた改善設計（観測の修正、戦利品と確定、守護者・遺物、ビルド、発見、振り返り、記録）。V3-1・V3-2・V3-2R（§14）・V3-2R2（§18。実装メモは §19、DESIGN.md §16）は実装済み。§14 は §1・§2・§10・§11 を上書きし、§18 は §14 の一部（点の式と §14.6 の目安）を上書きする。V3-2R2 の後の AI 評価は実施済み（§19.1）。V3-2R3（§20。実装メモは §21、DESIGN.md §17）も実装済みで、§20 は §18 の一部を上書きする。V3-2R3a（§22）も実装済みで、§22 は §20.5・§20.7 の目安の一部を上書きする。V3-2R3b（§23: bot の退き方の訂正と測り直し、階段へ退く見込みの表示、守護者の持ち場。実装メモは §21、DESIGN.md §17.7）も実装済みで、§23.1 は §22.2 の bot の方針の一部を取り消す。**次に実装するのは V3-4（ビルド）、その後 AI 評価**。順序と評価の時期は §20.7・§23.4。確認事項は §16 ですべて決定済み（会心のルール・物語の枠・継承・プロフィールの方式）。実装したら DESIGN.md・PROTOCOL.md に反映する

## 破ってはいけない不変条件

- World State を書き換えるのは `packages/shared` の `applyEvent` だけ。ルール（`packages/engine`）はイベントを発行する。
- `engine` は決定論的: `Math.random`・`Date`・浮動小数・I/O 禁止。乱数は名前付きストリームのみ。
- プレイヤー（AI・人間とも）への出力は必ず `projectPlayerView` を通す。未探索領域・視界外の情報・シードを渡さない。
- AI と人間は同じ `Command` と `PlayerPort` を使う。どちらかを特別扱いしない。
- `client` は `engine` を import しない。見た目はテーマ、ロジックはエンジン。
- 敵・アイテム・バイオーム等の追加は、データ（`packages/content/data`）とレジストリ登録で行う。

## 環境

Windows 11 / PowerShell / Node.js 22 / npm workspaces。Makefile・WSL に依存しない。

設計と実装が食い違う場合は、先に `docs/` を更新してから実装する。
