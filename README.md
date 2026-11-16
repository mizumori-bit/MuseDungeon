# MuseDungeon

MetaMuse などの AI エージェントが **MCP 経由で、画面認識なしに** 自律プレイすることを主目的としたターン制ローグライク。
人間も同じ世界に 2D 画面で参加・観戦・リプレイ鑑賞できる。

- World State が唯一の正。AI 向け観測（テキスト＋構造化 JSON）、人間向け 2D 画面、リプレイは、すべて World State とイベント列からの独立した射影。
- 遊びは**遠征**単位。目的（目標の階に着く／守護者を倒す／遺物を持ち帰る）を達成して階段の上で帰還するか、撤退・死亡・引退で終わる。キャンプで全回復し、次の遠征を選んで続ける。
- ダンジョンは階層ごとにシードからプロシージャル生成され、深さに上限は無い（深層では敵が tier・接辞で強化される）。
- AI と人間は同じ `Command`・同じ `PlayerPort`・同じマクロ（explore / travel / rest）を使う。
- 全イベントを `runs/<runId>/` に記録し、ゲームロジック無しで再生できる（シーク・速度変更・視点切替・AI の thought 表示）。

設計: [docs/DESIGN.md](docs/DESIGN.md) ／ プロトコル: [docs/PROTOCOL.md](docs/PROTOCOL.md) ／ 実装計画と確認方法: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) ／ 画像アセット仕様: [docs/ASSET_SPEC.md](docs/ASSET_SPEC.md)

## 必要なもの

Windows 11 / PowerShell（macOS・Linux でも可）、Node.js 22 以上、npm。

```powershell
git clone https://github.com/mizumori-bit/MuseDungeon.git
cd MuseDungeon
npm install
npm run build      # Web クライアントをビルド（packages/client/dist）
npm run server     # http://127.0.0.1:7777
```

- Web クライアント: http://127.0.0.1:7777/
- MCP（Streamable HTTP）: http://127.0.0.1:7777/mcp
- 記録: `runs/<runId>/`（`MUSE_RUNS_DIR` で変更可）

環境変数: `MUSE_PORT`（既定 7777）、`MUSE_HOST`（既定 127.0.0.1）、`MUSE_RUNS_DIR`、`MUSE_SPECTATOR_POLICY`（`omniscient` 既定 / `follow_only` / `delayed`）。

## MetaMuse（MCP クライアント）の接続

常駐サーバーを本体にしている（AI のプレイ中に人間がブラウザで観戦・参加できるようにするため）。接続方法は 2 通り。

**Streamable HTTP**（サーバーを `npm run server` で起動しておく）:

```json
{
  "mcpServers": {
    "muse-dungeon": { "url": "http://127.0.0.1:7777/mcp" }
  }
}
```

**stdio**（stdio しか話せないクライアント向けの薄いブリッジ。サーバーが起動していなければ自動で起動する）:

```json
{
  "mcpServers": {
    "muse-dungeon": {
      "command": "node",
      "args": ["<clone した場所>/MuseDungeon/packages/server/bin/muse-mcp-stdio.mjs"]
    }
  }
}
```

`args` はクローンした場所の絶対パスに置き換える（例: `E:/MuseDungeon/packages/server/bin/muse-mcp-stdio.mjs`）。先に `npm install` が済んでいること。

### AI のプレイの流れ

1. `get_rules` でルールを読む（式・操作・遠征・観測の読み方。個別の敵の数値は含まない）
2. `new_run { character_name, class?: "warrior"|"scout", objective?, locale?, seed? }` → `objective` を省くとキャンプから始まり、最初の遠征も 3 候補から `start_expedition { offer }` で選ぶ（`objective` を渡せば直接始まる）。`player_token` を控える（接続が切れても `resume_run` で再開ブリーフィング付きで再開できる）
3. 行動ツール（`move` / `explore` / `travel_to` / `fight` / `rest` / `collect` / `pickup` / `use_item` / `throw_item` / `use_stairs` / `extract` …）を呼ぶ。結果に「何が起きたか」（受けた攻撃の回数・命中・合計ダメージを含む）と次の観測が付く
   - 移動マクロは `mode` で止まり方を選べる: `careful`（既定）/ `steady`（弱い攻撃や毒を受けながら進む）/ `flee`（隣に敵がいても退く）。`explore` は通り道と見えているアイテムを拾う。`fight { target }` はその敵と決着を付ける（追跡中なら隣に来るまで待って殴る。`with: スロット` なら投げて戦う）。`wait { turns }` は何か起きるまで数手待つ。1 歩も進めない呼び出しは手番を使わずに理由付きで拒否される
4. **全応答に `turn` ブロック**が付く。`turn.state` が `your_turn` の間はゲームが次の行動を待っている。`expedition_ended` / `at_camp` / `run_ended` はやめてよい合図。`turn.changes` に前回からの変化
5. 目的を達成したら、いずれかの階段の上で `extract`（帰還。追跡中の敵が見えていてもよい）。未達成で切り上げるなら `extract { confirm: true }`（撤退）。階段から遠いときは、遠征ごとに 1 本持たされる**帰還の綱**（`use_item`。2 手番動けずに戻り、戦利品の半分が確定）。キャンプでは `start_expedition { offer }` で次の遠征（堅実／標準／野心の 3 枠。点はどの組み合わせでも 堅実 < 標準 < 野心。条件・倍率・推奨レベルが付く）
   - スコア（版 2）は**確定点**の合計。遠征中の点（目的・踏破・宝・賞金・発見・撃破）は未確定の戦利品で、帰還で × 倍率、綱で半分、撤退で半分（目的を除く）が確定し、死ねば失う。観測の `expedition.haul.if_extract_now` / `if_lifeline_now` が「今帰れば何点確定するか」、`next_overreach` が「どの階の下り階段まで行けば踏破の点が入るか（未発見なら下への風の方角）」、`next_camp` が「今帰ると次の候補はどこからか」
   - 敵は見れば分かる特徴（速さ・群れる・飛び道具・動かない）が初見から出る。追跡中の群れには被害見込み（`alerts.incoming`）、階段への逃げ道（`alerts.escape`）が付く
6. 迷ったら観測の `valid_actions`・`alerts`・`expedition` を見る。不正な行動は状態を変えず、`error.hint` と `valid_actions` が返る
7. 任意引数 `thought` に判断理由を書くと、観戦画面とリプレイに吹き出しで表示される（裁定には使われない）
8. `expect_seq` を渡すと、前提にした観測より状態が進んでいた場合に二重実行せず `stale_turn` を返す
9. 応答テキストが長ければ `set_options { map, inventory, status_line }` で減らせる（既定は変化があったときだけ地図と所持品を出す）

### ホスト駆動（AI を外から回す）

MCP は「AI が呼んだら返す」方式なので、ゲーム側から AI を起こすことはできない。AI を動かす側のループ（ホスト）のために:

- **ターンフィード** `GET /api/player/feed`（SSE、`Authorization: Bearer <player_token>`）: 手番が来たら `turn`、入力が無いまま一定時間（既定 60 秒）経ったら `idle`、遠征・ランが終わったら `ended` が流れる
- **参照ドライバ** `npm run drive`: フィードを購読し、手番ごとに「エージェント呼び出し」を行う薄いループ。呼び出しは差し替え可能
  - `--agent-cmd "<command>"`: コマンドを実行（標準入力に観測テキスト、環境変数 `MUSE_PLAYER_TOKEN`・`MUSE_MCP_URL`・`MUSE_TURN_JSON`）
  - `--agent-url <url>`: JSON を POST
  - 省略時: 内蔵ダミー（MCP で 1 手打って切断する）
- 例（PowerShell）: `npm.cmd run drive -- --new-run Bot` / `npm.cmd run drive -- --token <player_token> --agent-cmd "node my-agent.mjs"`
- 上限（`--max-turns` など）で止めても遠征は終わらない。もう一度実行すると続きから進む

観測の例（テキスト。同じ内容が `structuredContent` に JSON で入る）:

```
[seq 72 | 地下1階 湿った洞窟 | HP 22/22 | Lv1 | 位置(61,24) | あなたの番]
【遠征1】地下3階に到達し、階段から帰還する | 進行中 | 地下1/3階 | 目標階に未到達 | extract: 不可(階段の上ではない)
!! 敵が視界内: ゴブリン
見えるもの:
- ゴブリン e_mivwj8 (54,19) 西7北5  負傷:健康  状態:睡眠中  脅威:1
未探索: 南(61,26) 距離2 / 北(61,21) 距離3 / ...
地図(自分中心, 左上=(51,17)):
      ###.....
    .G.......
   .........@##
  凡例: #=壁 .=床 G=ゴブリン @=自分 ~=浅い水たまり (空白)=未知
できること: move n,ne,se,s,sw,w,nw / wait / explore / throw_item c (投げナイフ) -> e_mivwj8 / use_item d (回復の薬)
変化: 新たな敵: ゴブリン(e_mivwj8) 北西7マス
▶ あなたの番です（手番 41）。遠征は進行中で、あなたが行動ツールを呼ぶまで世界は止まっています。
```

## 人間のプレイ・観戦・リプレイ

ロビー（`/`）から:

- **新しいラン**: 名前・クラスを選んで開始（既定はキャンプから始まり、最初の遠征も 3 候補から選ぶ）。キー操作: 矢印／テンキー／`hjklyubn` で移動（敵にぶつかると攻撃）、`.` 待機、`x` 自動探索（`Shift+X` は強行＝steady）、`F` 隣の敵と戦う（fight。隣にいなければ追ってくる敵を迎え撃つ。投擲の狙い中は投擲で決着）、`W` 数手待つ（変化があれば止まる）、`L` 帰還の綱を使う（確認が出る）、`R` 休憩、`g` 拾う、`G` 見えているアイテムを拾い集める、`>` 階段、`T` 下り階段へ移動、`E` 帰還／撤退（階段の上。確定する点を確認してから）、`t` 投擲（Tab で射程内・射線の通る相手を切り替え）、`C` 投げた物の回収、`o` 操作、`i` 所持品。移動の慎重さは画面下の「慎重／強行」で切り替える。隣に敵がいるときは「階段へ退く（flee）」のボタンが出る。既知のマスをクリックするとそこまで移動（`Shift+クリック` で退く）。遠征が終わるとキャンプ画面で次の遠征を選ぶ。
- **観戦**: 進行中のランを俯瞰（全情報）／追従（そのプレイヤーの視界だけ）で見る。AI パネルに thought・ツール呼び出し・AI が受け取った観測テキスト。
- **リプレイ**: 再生／停止、0.25x〜16x、1 イベント／1 手番送り、タイムラインのシーク、マーカー（階移動・Lv up・撃破・瀕死・死亡・思考）ジャンプ、視点切替。進行中のランも巻き戻せる。
- **COOP**: モード「COOP」で開始したランには、ロビーや MCP の `join_run` から参加できる（同じフロアでは手番順に交代。放置は 30 秒でタイムアウトして待機扱い）。

見た目はテーマで差し替える（`packages/client/public/themes/<id>/theme.json`。画像が無いものは文字表示 `glyph` にフォールバック）。検証用の最小テーマ `sample` 付き。

## 開発用コマンド

PowerShell では `npm run <script> -- --flag` の `--` が npm に届かずオプションが無視されるので、**`npm.cmd run <script> -- --flag`** と書く（下の表は bash／cmd の書き方）。

| コマンド | 内容 |
|---|---|
| `npm test` | 決定論・畳み込み等価・漏洩・MCP 契約・対等性・COOP・クラッシュ復旧・ゴールデンリプレイ・生成不変条件・bot 完走 |
| `npm run test:full` | 上記の完全版（生成 1,000 シード×深度 1〜50、bot 100 ラン） |
| `npm run typecheck` / `npm run lint` | 型検査 / ESLint（パッケージ境界と engine の決定論ルールを機械的に検査） |
| `npm run bot -- --runs 10 [--kind greedy\|random] [--log] [--obs]` | ヘッドレスで bot を走らせ、到達深度と観測サイズを集計 |
| `npm run seed -- <seed> --depth 1 --to 5` | 生成されるフロアを ASCII で表示 |
| `npm run gen:check -- --seeds 1000 --depth 50` | 生成不変条件の検査 |
| `npm run replay:verify -- <runId>` | events.jsonl の畳み込みとキーフレームの一致、commands.jsonl の再実行と events.jsonl の一致を検証 |
| `npm run golden` | ゴールデンリプレイ（reducer 互換性テスト用）を作り直す |
| `npm run pacing -- --runs 100` | テンポの計測（階段発見までの手番・判断間隔・1 階あたりの手番・最初の遠征の長さ） |
| `npm run choices -- --runs 40` | 選択の計測（粘るか帰るか・遠征候補の 3 枠を方針別の bot で比べ、確定点の中央値・死亡率を出す。合格の根拠にはしない） |
| `npm run budget -- --runs 30` | V3-2R・V3-2R2 の計測（踏破 1 階あたりの「綱か死」の率・踏破の期待値の比・深度ごとのレベルと推奨・枠ごとの達成率・呼び出しの予算・斥候の投擲の割合） |
| `npm run drive -- --token <player_token>` / `--new-run <name>` | 参照ドライバ（ターンフィードを購読してエージェントを呼ぶ） |
| `npm run assets:checklist` / `npm run assets:check -- <themeDir>` | 画像アセットの発注表 / テーマの検証 |
| `npm run dev:client` | クライアントの開発サーバー（Vite。API は 7777 へプロキシ） |

## 構成

```
packages/
  shared/   型・Command スキーマ・applyEvent（唯一の状態更新）・projectPlayerView・イベントフィルタ・
            経路探索（既知地図のみ）・マクロ計画・Observation 整形・文章化・WS/HTTP 型
  content/  データ定義（data/core/*.json）・zod スキーマ・ローダ・公開カタログ
  engine/   ルール（決定論的）: スケジューラ・行動・戦闘・FOV・AI・効果・状態異常・生成パイプライン
  server/   RunSession・PlayerPort/SpectatorPort・LogWriter・MCP・WebSocket・HTTP
  client/   Web（Preact + Canvas2D）: ロビー・プレイ・観戦・リプレイ・Renderer・テーマ
  tools/    bot・ヘッドレスランナー・シード調査・リプレイ検証・アセット検査
```

## コンテンツの追加

| 追加したいもの | 作業 |
|---|---|
| 敵 | `packages/content/data/core/monsters.json` に 1 件（既存の archetype: melee_chaser / ranged_kiter / skittish / stationary / pack） |
| アイテム | `items.json` に 1 件（既存の effect: heal / cure / status / damage / max_hp / teleport / identify / map / noise） |
| バイオーム | `biomes.json` に 1 件 |
| 特殊階層 | `floorTypes.json` に 1 件＋`prefabs.json`（ASCII テンプレート） |
| 仕掛け | `features.json`（`onInteract` / `onEnter` に effect 列） |

別の pack として `packages/content/data/<pack>/` に置いてもよい（core の後に読み込まれ、同じ ID は上書き）。
新しい振る舞いが必要なときだけ engine のレジストリ（`effects` / `archetypes` / `layoutGenerators` / `validators` / `statusHandlers`）にハンドラを 1 つ登録する。起動時に、データが参照する ID が全て登録済みか検証される。
