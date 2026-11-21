# MuseDungeon 設計書

- 版: 1.0（設計完了・実装引き渡し用）
- 日付: 2026-11-15
- 関連文書: [PROTOCOL.md](PROTOCOL.md)（MCPツール／観測／イベント／通信の仕様）、[ASSET_SPEC.md](ASSET_SPEC.md)（画像アセットの仕様）、[IMPROVEMENTS_V2.md](IMPROVEMENTS_V2.md)（実プレイ評価を受けた改善設計。§13 に反映済み）、[IMPROVEMENTS_V3.md](IMPROVEMENTS_V3.md)（2 回目の評価を受けた改善設計。未実装）、[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)（実装順序と受け入れ基準）

---

## 1. コンセプト

**MuseDungeon** は、MetaMuse などの AI エージェントが MCP 経由で自律的にプレイすることを第一目的とした、ターン制ローグライクである。

設計の中心は次の一文に尽きる。

> **World State が唯一の正。AI向け観測・人間向け2D画面・リプレイは、すべて World State（とそこから出るイベント列）からの「射影」であり、互いに依存しない。**

### 1.1 設計原則（優先順）

| # | 原則 | 具体的な意味 |
|---|---|---|
| P1 | エージェントファースト | 画面認識なし。構造化データ＋簡潔なテキストだけで完全にプレイできる。1ターンの観測は数百トークンに収まる |
| P2 | サーバー権威・情報隠蔽 | 裁定はすべてエンジン。プレイヤーが知り得ない情報は、AIにも人間プレイヤーにも**構造的に**届かない |
| P3 | 決定論 | 同じシード＋同じコマンド列 → 同じイベント列。乱数・時刻・浮動小数をルールに持ち込まない |
| P4 | イベントが唯一の状態変更経路 | ルールは「イベントを発行」し、状態はルールを含まない reducer だけが書き換える。よってログは定義上完全で、リプレイはゲームロジック不要 |
| P5 | 参加者の対等性 | AI・人間は同じ Command、同じ PlayerView、同じマクロ行動を使う。`controller.kind` は表示用メタデータでしかない |
| P6 | データ駆動の拡張性 | 敵・アイテム・バイオーム・階層タイプ・部屋テンプレートは「データ1件追加＋必要なら小さなハンドラ登録」で増やせる |
| P7 | 描画の分離 | クライアントは「種別ID＋状態」だけ受け取り、見た目はテーマが決める。グラフィック全面差し替え可能 |

### 1.2 参考プロジェクトから採ったもの／採らなかったもの

| 参考 | 採用した長所 | 独自にした点 |
|---|---|---|
| mcp-dungeon | ルールブックを MCP 内で提供 (`get_rules`)、不正行動は状態を変えず「回復可能なエラー＋可能な行動」を返す、シードを AI に隠す、ログ監査 | 手書きの部屋グラフではなくタイルベースのプロシージャル生成。単一共有状態ではなくセッション／プレイヤー単位 |
| grokhack | `summary`・`hints`・`valid_actions`・脅威度を付けた観測、再開トークン、人間と AI の同居 | 観測にフロア全タイルを載せない（知識ベース射影）。巨大な単一 world ファイルにしない。MMO 機能は対象外 |
| koalabuttz/roguelike | ルールを持つ core と多数のフロントエンドの分離、`auto_explore`／`pathfind_to`／`look_at` 等の高水準行動、シード共有、ヘッドレス実行とゴールデンリプレイ | 観戦を「最新フレームのファイル書き出し」ではなくイベントストリームに。コンテンツ追加にコード上の enum 追加を要求しない |
| Hengband | データ定義ファイル＋スキーマ、深度／レア度による出現割当、エゴ（接辞）、Vault テンプレート、モンスターの思い出、未鑑定アイテム、プレイ記録、速度ベースの時間 | 規模は最小限。町・荒野・種族×職業×性格の組み合わせは持たない |

いずれの作品の名称・キャラクター・マップ・テキスト・コードも流用しない。

---

## 2. 全体アーキテクチャ

```
                        ┌──────────────────────────────────────────┐
                        │              RunSession (1ラン)            │
   Command              │                                          │
 ┌────────┐  act()      │  ┌────────┐ events ┌─────────┐           │
 │ MCP    ├────────────►│  │ Engine ├───────►│ reducer ├─► World   │
 │ (AI)   │◄────────────┤  │ (rules)│        │(no rule)│   State   │
 └────────┘ Observation │  └───▲────┘        └─────────┘     │     │
 ┌────────┐  command    │      │ reads                        │     │
 │ WS     ├────────────►│      └──────────────────────────────┘     │
 │ (人間) │◄────────────┤                                          │
 └────────┘ PlayerView  │   events ──► LogWriter ──► runs/<id>/    │
 ┌────────┐             │   events ──► SpectatorHub                │
 │ WS     │◄────────────┤                                          │
 │ (観戦) │ event stream└──────────────────────────────────────────┘
 └────────┘
```

### 2.1 三つの射影

| 射影 | 入力 | 生成関数（置き場所） | 消費者 |
|---|---|---|---|
| **PlayerView** | World State + playerId | `projectPlayerView(world, playerId)`（shared・ルール無し・純粋なフィルタ） | AI（Observation に整形）／人間プレイヤー（2D描画）／追従観戦 |
| **DirectorView** | World State 全体 | reducer で畳み込んだ World そのもの（`rng` と `seed` を除去） | 俯瞰観戦・リプレイ |
| **Event Log** | エンジンが発行したイベント列 | LogWriter が追記 | リプレイ、監査、クラッシュ復旧、統計 |

重要な帰結:

- **AI の Observation と人間の画面は同じ `PlayerView` から作る。** これにより「AI だけ／人間だけが知っている情報」は構造上発生しない（P2・P5）。
- **ライブ観戦クライアント＝リプレイクライアント。** どちらも「スナップショット＋イベント列を reducer で畳む」だけで、違いはイベントの供給元（WebSocket の末尾追従か、ファイルか）のみ。
  - ライブ観戦は、届いた出来事を 1 手（同じ命令 `cause` のまとまり）ずつ間を置いて見せる（AI のマクロは 1 回の呼び出しで何十歩も一度に進み、数ミリ秒おきに 1 歩ずつ届くため）。間は届いた時点でたまっている手をおよそ 2.5 秒で見せ終える長さ（1 手 25〜150 ミリ秒）で、AI の応答の待ち時間で追いつく。見る側だけの遅れで、AI の進みは変えない（2026-11-18）。
- テキストマップを画像化しているのではない。ASCII 地図も 2D タイルも、同じ構造化データからの別々のレンダリングである。

### 2.2 技術スタック

| 項目 | 選定 | 理由 |
|---|---|---|
| 言語 | TypeScript（strict）/ Node.js 22 | エンジン・サーバー・ブラウザで型と reducer を共有できる。Windows でそのまま動く。実行は `tsx`（ビルド不要）、型検査はルートの `tsc --noEmit` |
| モノレポ | npm workspaces | 追加ツール不要 |
| MCP | `@modelcontextprotocol/sdk`（Streamable HTTP ＋ stdio ブリッジ） | MetaMuse の接続方式がどちらでも対応 |
| スキーマ | zod | コンテンツ定義・Command・Event・MCP 入力の検証を一元化 |
| 通信 | `ws`（WebSocket）＋ Node 標準 http | 依存最小 |
| クライアント | Vite + TypeScript + Canvas 2D（UIパネルは Preact） | MVP は簡素。`Renderer` インターフェースの裏を後で PixiJS 等に差し替え可能 |
| テスト | vitest | 決定論・漏洩・生成不変条件のプロパティテスト |

### 2.3 パッケージ構成と依存方向

```
packages/
  shared/    型, zodスキーマ, applyEvent(reducer), projectPlayerView, filterEvents,
             nav(既知地図上の経路探索), narrate(イベント→文章), observation整形
  content/   データ定義(JSON) + スキーマ + ローダ + 効果/AI/生成器のID一覧
  engine/    ルール: scheduler, actions, combat, fov, monster AI, effects, generation
  server/    RunSession, ポート(Player/Spectator/Replay), MCPアダプタ, WS, HTTP, LogWriter
  client/    Web: play / spectate / replay。Renderer + Theme
  tools/     headless runner, ベースラインbot, replay検証, シード調査CLI
```

依存は一方向: `shared ← content ← engine ← server`、`shared ← client`、`tools → engine/server`。

**強制する境界（ESLint の `no-restricted-imports` / `no-restricted-globals` / `no-restricted-properties` で機械的に守る。`eslint.config.js`）:**

1. `client` は `engine` を import できない（描画とロジックの分離）。
2. `shared` はルールを持たない。乱数・ダメージ計算・FOV 計算は置かない。
3. `engine` は I/O・`Date`・`Math.random`・浮動小数演算をしない（ESLint `no-restricted-globals` / `no-restricted-properties`）。
4. `server/mcp` と `server/ws` のプレイヤー向けコードは `PlayerPort` 以外から World に触れない。

---

## 3. World State

プレーンな JSON 直列化可能データ。クラスやメソッドは持たせない。

```ts
World {
  meta:    { runId, contentVersion, engineVersion, mode: 'solo'|'coop', createdSeq }
  secret:  { seed: string, rng: Record<StreamName, RngState>,
             appearances: Record<string, string> }                // 外部射影から必ず除去
  seq:     number                         // 最後に適用したイベントの通番
  status:  'active' | 'ended'
  floors:  Record<FloorKey, Floor>        // FloorKey = `${branch}:${depth}` 例 "main:3"
  entities:Record<EntityId, Entity>
  players: Record<PlayerId, PlayerRecord>
}

Floor {
  key, branch, depth, biome, floorType, width, height
  time: number                 // このフロアのローカル時刻
  terrain: number[]            // width*height。content の terrain 表への index
  regions: Region[]            // 生成時の部屋/領域メタ(タグ付き)。AI観測には出さない
}

Entity {                       // ECS-lite: 任意のコンポーネント袋
  id: EntityId                 // 不透明ID "e_x7k2m9"（連番にしない＝出現数を漏らさない）
  kind: string                 // content ID 例 "core:goblin"
  pos?:  { floor: FloorKey, x, y }
  actor?:{ speed, nextActAt, faction, ai?: { archetype, state, targetPos?, params } }
  stats?:{ hp, maxHp, acc, eva, might, armor, sight }
  inv?:  { items: EntityId[], capacity }
  equip?:{ weapon?, armor?, accessory? }
  item?: { qty, affixes: string[], heldBy?: EntityId }
  status?: { id, turnsLeft, power }[]
  trap?: { revealedTo: PlayerId[] }
  player?: PlayerId
  level?: { level, xp }
  scale?: { tier, affixes: string[] }    // 深層スケーリング（§6.5）
}

PlayerRecord {
  id, name, controller: { kind: 'agent'|'human', label }, entityId, state: 'alive'|'dead'|'left'
  knowledge: {
    floors: Record<FloorKey, { seen: number[] /*記憶した地形,0=未知*/, remembered: RememberedEntity[] }>
    visible: number[]                    // 現在視界内のセル index（現在フロア）
    identified: string[]                 // 鑑定済みのアイテム kind
                                         // 未鑑定名の対応表(kind→"赤い薬")は secret 側に持つ
    monsterMemory: Record<string, MonsterMemory>
    notes: string[]
  }
}
```

ポイント:

- **プレイヤーの知識（記憶した地図・現在の視界・鑑定状況）も World State の一部。** FOV 計算はエンジンが行い、結果を `knowledge_updated` イベントで書き込む。だから `projectPlayerView` はルール無しのフィルタで済み、リプレイでも「その時点でそのプレイヤーに何が見えていたか」を再現できる。
- 座標は各フロア左上原点、x は東へ、y は南へ増える。方向は 8 方向 `n ne e se s sw w nw`。
- 反復順は決定的でなければならない。エンティティの走査は必ず「挿入順（=生成 seq 順）」で行う。

---

## 4. エンジン

### 4.1 コマンド → イベント → 状態

```ts
// engine
function step(world: Readonly<World>, cmd: Command, content: Content): StepResult
// StepResult = { ok: true, events: Event[] } | { ok: false, error: ActionError }

// shared（ルール無し）
function applyEvent(world: World, ev: Event): void
```

- エンジン内部では「イベントを発行 → 即 `applyEvent`」を繰り返す。**`applyEvent` 以外で World を書き換えるコードは禁止。**
- 各イベントは**結果の値（after 値）を持つ**。例: `damaged { target, amount, hpAfter }`。reducer は `hp = hpAfter` と代入するだけで、計算をしない。
- 不正なコマンドはイベントを出さず、時間も消費しない。`ActionError { code, message, hint }` を返す。
- 検証テスト: 任意の時点で `fold(keyframe, events) の正準ハッシュ == ライブ World の正準ハッシュ`。

### 4.2 時間（速度ベース・フロア単位の時計）

- 各アクターは `speed`（標準 100）と `nextActAt` を持つ。行動コスト `cost`（標準 100）に対して `nextActAt += cost * 100 / speed`（整数除算）。
- 各フロアが独立した `time` を持つ。スケジューラは、プレイヤーがいるフロアごとに「`nextActAt` 最小（同値は挿入順）のアクター」を次の行動者とする。
  - モンスターなら AI が即決して進む。
  - プレイヤーならそのプレイヤーのコマンドを待つ。
- **プレイヤーがいないフロアは凍結**（時間が進まない）。別フロアにいるプレイヤー同士は互いを待たない。フロア移動時は到着側の `floor.time` に `nextActAt` を合わせる。
- 同一フロアに複数プレイヤーがいる場合（COOP）は `nextActAt` 順に待つ。`turnTimeoutMs`（ソロ既定: 無制限、COOP 既定: 30 秒）を過ぎたら、サーバーが `wait` を `source: 'timeout'` として投入する。タイムアウトも通常のコマンドとして記録されるので決定論は保たれる。
- 壁時計時刻はログのメタ情報としてのみ記録し、ルールには一切入れない。

### 4.3 行動

基本行動（すべて 1 コマンド = そのアクターの 1 手番）:

| Command | 内容 |
|---|---|
| `move {dir}` | 移動。敵対者がいれば近接攻撃（バンプ攻撃）、閉じた扉なら開ける |
| `wait` | 1 手番待機 |
| `pickup {item?}` | 足元のアイテムを拾う |
| `drop {slot, qty?}` | 落とす |
| `equip {slot}` / `unequip {slot}` | 装備の着脱 |
| `use {slot, target?}` | 薬・巻物・杖などを使う |
| `throw {slot, target}` | 投げる（射線判定あり） |
| `interact {dir?}` | 扉の開閉、泉・祭壇などの地物を操作 |
| `stairs` | 足元の階段を使う |
| `extract {confirm?}` | 遠征を終える（階段の上で。達成なら帰還、未達成なら confirm で撤退）。§13 |
| `start_expedition {offer}` | キャンプで次の遠征を始める（手番に関係しない）。§13 |

マクロ行動（サーバー側で基本行動の列に展開。**AI も人間も同じものを使う**）:

| Command | 展開と中断条件 |
|---|---|
| `explore` | 既知地図上で最寄りの未探索フロンティアへ進む。新しい敵対者が視界に入る／被ダメージ／新しいアイテムや階段を発見／フロンティア無し、で中断 |
| `travel {to}` | 既知地図上の経路で座標・既知の階段・記憶した対象へ移動。中断条件は同上＋到着 |
| `rest {untilHp?, maxTurns?}` | HP 全快（かつ毒が抜ける）、指定の HP・手数、または中断まで `wait` を繰り返す |

- マクロは 1 回の呼び出しにつき最大 `balance.macro.stepLimit`（200）手、`rest` は `balance.rest.maxTurns`（400）手。各手は `source: 'macro'` の通常コマンドとして記録される。
- マクロの結果には実績（歩いた手数・経過したフロア時間・休憩の HP 回復量）を付ける。
- 経路探索は `shared/nav` にあり、**プレイヤーの既知地図だけ**を入力とする（未知セルは通行不可扱い）。

### 4.4 戦闘（MVP）

整数のみ。式は `get_rules` で AI に公開する（個々のモンスターの数値は公開しない）。

- 命中: `d20 + acc >= 10 + eva`。出目 20 は必中かつクリティカル（ダメージダイス 2 倍）、出目 1 は必ず外れ。
- ダメージ: `武器ダイス + might - armor`、最低 1。
- 状態異常（MVP）: 毒・加速・減速・睡眠。手番開始時に処理する。
- 経験値とレベルアップ。HP は手番経過で緩やかに自然回復する。追跡中の敵が見えない状態での `wait` は休息で、回復が速い（§13.4）。
- 表示するダメージは実際に減った HP（とどめの超過分を含まない）。
- 永久死。遠征の終了ごととラン終了時にサマリー（達成した遠征・到達深度・手数・撃破数・死因・装備）を出力する。
- 休憩し放題への圧力として、フロア滞在時間に応じた徘徊モンスターの湧きを入れる（空腹度は MVP に入れない）。

### 4.5 モンスター AI

- 状態機械: `asleep → unaware → hunting → (見失い) searching → unaware`。モンスターも自分の `sight` と FOV でしかプレイヤーを認識せず、見失ったら最後に見た位置へ向かう。
- 行動様式は `archetype` ID で選ぶ: `melee_chaser`, `ranged_kiter`, `skittish`（低 HP で逃走）, `stationary`, `pack`。パラメータはデータ側。
- 騒音: 戦闘や扉の開閉は `noise` を出し、範囲内の睡眠／未認識モンスターを起こし得る。

### 4.6 視界と知覚

- 対称シャドウキャスティング、標準半径 8。
- エンジンは各イベントに `seenBy: PlayerId[] | 'all'` を付ける（発行時点の視界・聴覚から計算）。これにより、イベントのプレイヤー別フィルタリングは shared 側でルール無しに行える。
- 見えていないエンティティへの参照は、プレイヤー向けに渡す時点で `null` に置換し、文章化では「何か」になる。

---

## 5. 情報隠蔽

「漏らさない努力」ではなく「漏れる経路が無い構造」にする。

| 隠す情報 | 手段 |
|---|---|
| 未探索の地形 | `PlayerView.memory` は `knowledge.floors[..].seen` のみ。Floor.terrain はプレイヤー向け経路に乗らない |
| 視界外のモンスター・アイテム | `projectPlayerView` は `knowledge.visible` 内のエンティティだけを列挙。記憶したアイテム等は「最後に見た情報」として別枠 |
| モンスターの正確な HP・能力値 | HP は 4 段階のバケット。能力は「モンスターの思い出」に蓄積した観測済み情報のみ |
| 未鑑定アイテムの正体 | ランごとに外見名をシャッフル。使うか鑑定するまで kind を出さない |
| 罠 | 発見したプレイヤーにのみ見える |
| シード・乱数状態 | `world.secret` に隔離。ラン終了まで全外部経路から除去。終了後はサマリーで公開（シード共有用） |
| 出現総数などの副次情報 | エンティティ ID は連番にしない不透明 ID |
| 生成メタ（region タグ等） | プレイヤー向けに出さない |

**漏洩テスト（必須）**: ランダムなプレイを多数回回し、各手番の Observation JSON に (a) 未知セルの地形、(b) 視界外エンティティの ID・座標、(c) `secret` 配下の値、(d) 未鑑定 kind、が一切含まれないことをプロパティテストで検証する。

**観戦による漏洩**: 俯瞰観戦は全情報が見える。ローカル MVP では許可するが、サーバー設定 `spectatorPolicy: 'omniscient' | 'follow_only' | 'delayed'` を最初から用意する（公開運用やベンチマーク時は `follow_only`）。

---

## 6. プロシージャル生成

### 6.1 シードと乱数ストリーム

- PRNG は `sfc32`（32bit 整数演算のみ）。シード文字列からのハッシュは `cyrb128`。
- `floorSeed = hash(runSeed, branch, depth)`。さらに**用途別の名前付きサブストリーム**に分ける: `layout`, `prefab`, `monsters`, `items`, `features`, `objective`（遠征の守護者・遺物）。実行時の戦闘などは `runtime` ストリーム。遠征の候補は `hash(runSeed, 'expedition', 通番)` から作る（状態を持たない）。
- 効果: アイテム表を増やしても地形が変わらない。フロア N の地形は、そこまでの行動に依存せず同一シードなら常に同じ。
- 深度に上限は無い。フロアは初めて入った時に生成し、ラン中は状態を保持する（MVP ではメモリ保持。将来はキーフレーム形式で退避）。

### 6.2 生成パイプライン

```
selectFloorType → selectBiome → (pacing) → layout → prefab配置 → 階段/接続 → populate → (遠征の目的) → validate
```

各段は**レジストリから ID で選ばれるプラグイン**で、データ定義の重みと深度条件で抽選される。

| 段 | レジストリ | MVP の中身 |
|---|---|---|
| floorType | `floorTypes` | `standard`, `cavern`, `vault_floor`（宝物庫階）, `sanctuary`（敵無しの休憩階） |
| biome | `biomes` | `stone_halls`, `damp_caves`, `overgrown_ruins`。地形パレット・レイアウト重み・出現タグ補正・環境地物を持つ |
| layout | `layoutGenerators` | `rooms_corridors`（BSP）, `cellular_cave`（セルオートマトン＋連結化） |
| prefab | `prefabs` | ASCII テンプレート＋凡例のデータ定義（Vault・祭壇部屋など）。回転／反転あり |
| populate | `spawnTables` | 深度・レア度・タグによる割当。低確率で深層の敵が混ざる |
| 遠征の目的 | （生成段） | 遠征の目標階でだけ、守護者・遺物を入口から離れた到達可能なセルに置く（`objective` ストリームのみ使用） |
| validate | `validators` | 上り下り階段が相互到達可能、開始地点が安全、床面積の下限、到着地点から下り階段までの歩行距離（`stairs_path`） 等 |

- validate に失敗したら `attempt` を増やして同じ段からやり直す（`hash(floorSeed, attempt)`、決定的）。8 回失敗したら必ず成功する単純レイアウトにフォールバックする。
- フロアの寸法・階段距離・密度は floorType の `pacing`（深度帯ごと）で決まる（§13.5）。帯が無い floorType は `size`（既定 64×40）と `per1000`。

### 6.3 コンテンツ定義

`packages/content/data/<pack>/` に JSON で置き、zod スキーマで起動時に検証する。ID は `pack:name`（例 `core:goblin`）。

```jsonc
// monsters.json の 1 件
{
  "id": "core:goblin",
  "name": { "ja": "ゴブリン", "en": "goblin" },
  "tags": ["humanoid", "cave"],
  "depth": { "min": 1, "peak": 3 }, "rarity": 1,
  "stats": { "hp": "2d4+2", "acc": 2, "eva": 1, "might": 0, "armor": 0, "sight": 7 },
  "speed": 100, "attack": { "dice": "1d6" },
  "ai": { "archetype": "melee_chaser", "fleeBelowHpPct": 25 },
  "xp": 4, "drops": [{ "table": "core:common_loot", "chancePct": 20 }]
}
```

```jsonc
// items.json の 1 件。効果は合成可能な小さな DSL
{
  "id": "core:potion_healing", "category": "potion", "unidentified": true,
  "name": { "ja": "回復の薬", "en": "potion of healing" },
  "depth": { "min": 1 }, "rarity": 1, "stack": true,
  "onUse": [{ "effect": "heal", "amount": "2d8+4" }, { "effect": "cure", "status": "poison" }]
}
```

定義ファイル: `terrain`, `monsters`, `items`, `appearances`（未鑑定アイテムの外見 ID と表示名）, `affixes`（`target: monster | item | guardian`）, `statuses`, `biomes`, `floorTypes`（`pacing` を含む）, `prefabs`, `spawnTables`, `lootTables`, `classes`, `features`（泉・祭壇などの操作可能な地物）, `balance`（調整値。§13.6）。

- **効果（effect）・AI archetype・layout generator・validator** はコード側のハンドラをレジストリに登録し、データからは ID で参照する。新しい効果が要る時だけコードを足す。
- 見た目（グリフ・色・スプライト）はコンテンツに書かない。`client/themes/<theme>/` が kind ID → 見た目の対応表を持つ（P7）。

### 6.4 拡張手順（実装後の目標体験）

| 追加したいもの | 必要な作業 |
|---|---|
| 新しい敵 | `monsters.json` に 1 件。既存 archetype で足りなければ AI ハンドラを 1 つ登録。テーマに見た目を 1 行 |
| 新しいアイテム | `items.json` に 1 件。既存 effect の組み合わせで足りなければ effect ハンドラを 1 つ |
| 新しいバイオーム | `biomes.json` に 1 件（＋必要なら terrain を追加） |
| 特殊階層 | `floorTypes.json` に 1 件＋ prefab。特殊ルールが要るなら生成段を 1 つ登録 |
| イベント的な仕掛け | `features.json` に操作可能な地物として定義（`onInteract` に effect 列） |

### 6.5 無限深度のスケーリング

有限のコンテンツで無限に潜れるようにする。

- 定義済みの最深帯（monsters の `depth.peak` の最大値）を超えた深度では、出現時に `tier = floor((depth - 定義最深) / 5) + 1` を付与し、HP（+50%/tier）・命中（+2/tier）・威力（+1/tier）・回避と装甲（+1/2tier）を整数演算で上げる。種の抽選は定義最深の深度で行う。
- モンスター接辞（例: 「俊敏な」「古の」）とアイテム接辞（エゴ）を深度に応じて付与する。接辞もデータ定義。
- スコア = 到達深度×perDepth + 撃破×perKill + レベル×perLevel + 達成した遠征の基礎点（係数は `balance.json`）。記録の並び順は「達成した遠征の数」を主軸にする。

---

## 6.6 MVP コンテンツ量（意図的に小さく）

| 種別 | 数 |
|---|---|
| クラス（初期装備セット） | 2（戦士・斥候） |
| モンスター | 8（archetype を全種使う） |
| アイテム | 16 前後（武器 4・防具 3・薬 4・巻物 3・投擲 2） |
| 接辞 | モンスター 3・アイテム 3 |
| バイオーム | 3 |
| floorType | 4 |
| prefab | 6 |

---

## 7. サーバー

### 7.1 プロセス構成

- **`muse-server`（常駐）**: HTTP ＋ WebSocket ＋ MCP（Streamable HTTP、`/mcp`）。既定で `127.0.0.1:7777` にのみバインドする。
- **`muse-mcp-stdio`（薄いブリッジ）**: stdio しか話せない MCP クライアント向け。中身は `/mcp` への中継のみで、ゲーム状態は持たない。サーバーが起動していなければ起動する。

常駐サーバーを本体にする理由は、AI のプレイ中に人間がブラウザで観戦・参加できる必要があるため（stdio の子プロセスに状態を持たせると観戦者が繋げない）。

> 前提: MetaMuse は標準的な MCP クライアント（Streamable HTTP または stdio）として接続できるものとする。どちらでも動くよう両方を用意する。

### 7.2 RunSession とポート

1 ラン = 1 `RunSession`（World、スケジューラループ、コマンド待ち行列、LogWriter、購読者ハブ）。サーバーは複数ランを同時に持てる。

| ポート | 提供 | 利用者 |
|---|---|---|
| `PlayerPort` | `view()`, `submit(command)`, `waitForTurn()`, 無料情報照会（look / recall / map）。**PlayerView 経由の情報しか返さない** | MCP アダプタ、人間用 WS |
| `SpectatorPort` | スナップショット（`secret` 除去）＋イベント購読。書き込み不可 | 観戦 WS |
| `ReplayPort` | 終了済み／進行中ランのログ配信 | HTTP |

- 参加時にプレイヤートークンを発行する。再接続・再開はトークンで行う（MCP 接続が切れてもランは残る）。
- 1 MCP 接続 = 1 プレイヤー。
- クラッシュ復旧: 最新キーフレームを読み、それ以降の `commands.jsonl` を再実行し、`events.jsonl` とハッシュ照合する。

### 7.3 マルチプレイヤー（アーキテクチャは最初から、機能は段階的に）

- World は最初から複数のプレイヤーエンティティを持てる。エンジン・スケジューラ・射影・ログは単数を仮定しない。
- MVP で保証する範囲: ソロ開始（AI または人間）。加えて「2 体の bot が同一ランに参加して両方が行動できる」ことを自動テストで保証する。
- COOP の基本ルール（設計確定・実装は M6）: プレイヤー同士は味方（同士討ち無し、すれ違いは位置交換）。各自が独立して階段を使える。死亡者は観戦に回り、全員死亡でラン終了。アイテム共有は「落として拾う」。`say` でチャット。

---

## 8. ログとリプレイ

### 8.1 ファイル構成

```
runs/<runId>/
  meta.json         ラン情報、バージョン、参加者（シードは終了時に追記）
  commands.jsonl    受理した全コマンド（入力の記録。決定論的再実行・監査用）
  events.jsonl      全イベント（状態変化の記録。リプレイはこれだけで再生可能）
  keyframes/<seq>.json   { seq, cseq, world }（500 seq ごと＋参加・フロア移動・終了時）。HTTP では進行中は secret を除去して配信
  tokens.json       再開用プレイヤートークン（サーバー専用。HTTP では配信しない）
  summary.json / summary.md   終了時の成績と「冒険の記録」
```

二本立ての理由:

- **events.jsonl** は自己完結した状態変化の列で、**ゲームロジック無しで再生できる**。バランス調整やコンテンツ更新の後でも、古いリプレイはそのまま見られる。
- **commands.jsonl** は「同じバージョンで再実行すれば同じイベントになる」ことの検証（決定論テスト、不正監査、クラッシュ復旧）に使う。

### 8.2 再生

- シーク: 目標 seq 以下で最大のキーフレームを読み、そこからイベントを畳む。
- 速度: 0.25x〜16x、一時停止、1 イベント／1 手番送り。イベントに記録した壁時計時刻を使えば「実時間ペース」再生もできる。
- ジャンプ: フロア移動・レベルアップ・撃破・瀕死・死亡などのイベント種別を索引化し、タイムライン上にマーカー表示する。
- 視点: 俯瞰（全情報）／特定プレイヤー視点（`projectPlayerView` を適用）を切替。
- **AI の思考表示**: 行動ツールの任意引数 `thought`（短文）を `thought` イベントとして記録し、観戦・リプレイで吹き出し表示する。ゲームには一切影響しない。「AI が見た Observation テキスト」も同じ PlayerView から再生成して並べて表示できる。

---

## 9. クライアント（人間向け 2D）

### 9.1 構造

```
EventSource（Live WS / Replay File）
   → ViewStore（スナップショット＋applyEvent。engine 非依存）
   → [俯瞰: World そのまま] or [追従: projectPlayerView]
   → Renderer（interface）  ← Theme（kind ID → 見た目）
   → Canvas
```

人間プレイヤーのプレイ画面だけは、サーバーが送る `PlayerView` フレーム＋フィルタ済みイベントを受け取る（生のイベント列は渡さない）。

```ts
interface Renderer {
  mount(canvas: HTMLCanvasElement, theme: Theme): void
  draw(scene: Scene): void          // Scene = 表示対象のセル・エンティティ・視界/記憶の区別
  animate(events: ViewEvent[]): Promise<void>   // 移動補間、ダメージ表示など
}
```

- 画像アセットの技術仕様（セルサイズ、レイヤー、向き、アニメーション、アセット ID とコンテンツ ID の対応、テーママニフェスト）は [ASSET_SPEC.md](ASSET_SPEC.md) に定める。画像は別途制作し、テーマとして差し込む。
- MVP テーマ `glyph`: 色付きタイル＋文字／簡易アイコン。画像アセット無し。画像テーマで未提供のアセットはこれにフォールバックする。
- 向きやアニメーションの進行は見た目専用の状態で、クライアントがイベントから導出する。World State には含めない。
- 後で `Renderer` 実装とテーマを差し替えるだけでスプライト化・WebGL 化できる。ゲームロジック側の変更は不要。

### 9.2 画面

| モード | 内容 |
|---|---|
| ロビー | 進行中のラン一覧、リプレイ一覧、新規ラン開始（人間） |
| プレイ | 地図、ステータス、所持品、メッセージ。キーボード操作（移動 8 方向、`x` 自動探索、クリックで travel、など AI と同じ Command を送る） |
| 観戦 | 地図（俯瞰／追従切替）、パーティ状況、メッセージ、**AI パネル**（直近の thought、直近のツール呼び出し、AI が受け取った観測テキスト） |
| リプレイ | 観戦画面＋タイムライン、速度、マーカージャンプ、視点切替 |

---

## 10. テスト戦略

| 種別 | 内容 |
|---|---|
| 決定論 | 同一シード＋同一コマンド列 → イベント列のハッシュ一致（OS・実行回をまたいで） |
| 畳み込み等価 | `fold(events)` と ライブ World の正準ハッシュ一致 |
| 漏洩 | §5 のプロパティテスト |
| 生成不変条件 | シード 1,000 個 × 深度 1〜50 で validate 全通過、階段到達可能、生成時間の上限 |
| 完走 | ベースライン bot がクラッシュ無しで 100 ラン完走。平均到達深度を記録（バランスの回帰検出） |
| MCP 契約 | 全ツールの入出力スキーマ、エラーコード、stale ターン検出 |
| ゴールデンリプレイ | 保存済みログが現行 reducer で再生でき、最終状態ハッシュが一致 |
| 対等性 | 同じ状況で MCP 経由と WS 経由の PlayerView が一致 |

---

## 11. MVP 範囲外（設計上の受け皿だけ用意）

- 空腹度、魔法体系、店・町、複数ダンジョン分岐（`branch` フィールドは用意済み）
- 自動拾い・銘（inscription）ルール
- ラン間のメタ進行、オンラインランキング
- 認証・公開サーバー運用（トークンと `spectatorPolicy` は用意済み）
- スプライト／アニメーション／サウンド（`Renderer`・`Theme` で差し替え可能）
- フロアの退避と大規模ランの省メモリ化

---

## 12. 実装メモ（v1.0 からの確定事項・差分）

実装時に決めた細部。ここに書いたものが正。

### 12.1 World / イベント
- エンティティは `sid`（生成時の seq）を持ち、走査は sid 順。`Object.keys` の順序に依存しない。
- 追加フィールド: `Entity.base`（装備前の基本能力）、`actor.turns`・`actor.dormant`（睡眠中モンスターはスケジューラに載らない）、`Floor.entry / stairs / currentActor / nextWanderAt / rules`、`World.playerOrder / endReason`、`RunMeta.terrainTable / eventVersion / options`、`Knowledge.met`、`PlayerRecord.classId / locale / joinedSeq / stats`。
- **乱数状態も applyEvent 経由で変える。** step の最後に、使ったストリームの状態を内部イベント `rng_advanced` で確定させる。これで「World を書き換えるのは applyEvent だけ」と「fold(events) == ライブ World（secret 含む）」が厳密に成り立つ。プレイヤーには渡さず、観戦・HTTP には中身を空にして渡す（seq の連続性だけ残す）。
- アイテムの出し入れなど複数エンティティの変化を伴うイベントは、汎用の after 値 `put`（置換・追加するエンティティ全体）と `del` を持てる。reducer は代入するだけ。
- 地形 index はランごとに `meta.terrainTable` で固定する（コンテンツ更新後も古いリプレイが読める）。index 0 は常に `core:unknown`（記憶地図の未知）。
- フロア時刻 `floor.time` はプレイヤーの手番開始（`turn_began`）で更新する。

### 12.2 情報隠蔽
- 複数の主体を持つイベント（攻撃・被弾・死亡・投擲・移動・扉）は、プレイヤーごとに見えていない主体のフィールドを `masks` で伏せる（ID・種別・位置 `from/to` とも）。`filterEventsForPlayer` は `masks` を適用し、`seenBy/masks/put/del` を除去し、他者の HP の after 値を消す。
- 観戦用の World は `stripSecret` を通す。`seed` と `rng` は除去し、`appearances`（未鑑定の外見表）は残す（追従視点を観戦側で再射影するため。俯瞰観戦は全情報を見る前提）。`follow_only` では World を送らず PlayerView だけを送る。

### 12.3 ルール値（MVP。v2 で `balance.json` へ移した）
- レベルアップ: 次のレベルに必要な累計 XP = `15 × Lv²`。
- 自然回復: 回復の蓄積値を手番ごとに +1（休息なら +restMultiplier）し、`max(3, 9 - floor(Lv/2))` に達するごとに HP+1（§13.4）。
- 徘徊モンスター: フロア時刻が `nextWanderAt` を過ぎたら、視界外かつプレイヤーから 12 マス以上離れた所に 1 体（覚醒済みが 30 体未満のとき）。次は 4000〜6000 時間単位後。聖域（sanctuary）では湧かない。
- 深層の敵が混ざる確率は spawnTable の `oodChancePct`、深度差は `min(oodDepth, depth)`。
- 睡眠中モンスターは、プレイヤーの手番ごとに、そのモンスターがプレイヤーを視認できれば一定確率（斥候は stealth で低下）で起きる。騒音でも起きる。

### 12.4 サーバー
- 行動ツールは次の自分の手番まで待って返る（COOP で 20 秒を超えたら `waiting_others`）。マクロは 1 手ごとに直列化キューへ投入するので、COOP では他プレイヤーの手と交互に進む。
- COOP の手番タイムアウトは、同じフロアに他の生存プレイヤーがいるときだけ働く。
- 起動は `node packages/server/bin/muse-server.mjs`（tsx を API で登録するランチャー。作業ディレクトリに依存しない）。stdio ブリッジも同様に `bin/muse-mcp-stdio.mjs`。

---

## 13. 改善 v2（遠征・ターン契約・休憩・敵の耐久・探索密度）

経緯と評価の受け止めは [IMPROVEMENTS_V2.md](IMPROVEMENTS_V2.md)。ここには実装で確定した設計を書く。プロトコルの詳細は [PROTOCOL.md](PROTOCOL.md) §1.2・§2.1.1・§3・§5・§8.1。

### 13.1 ターン契約
- 全応答（プレイヤーが束縛されたもの）に `turn` ブロックとテキスト末尾の `▶` 行を付ける（`shared/turn.ts`）。`state` と `awaiting` は事実の通知で、提案は書かない。
- `changes` は PlayerView と観測だけから作る差分（`turnSnapshot` → `diffChanges`）。基準はサーバーがプレイヤーごとに持つ（RunSession のメモリ上。復旧直後の最初の応答は差分なし）。人間向け UI も同じ関数で計算する。
- `observe` は待たない。待つのは `wait_for_turn`。

### 13.2 遠征
- 構造: ラン（無限・永久死）の中に遠征（目的 → 帰還／撤退／死亡／引退）が並び、間にキャンプ（時間が進まない幕間）が入る。
- World: `expeditions: Expedition[]`（通番・目的・基礎点・状態・開始／終了 seq・終了理由・参加者・開始時の成績・守護者／遺物の ID・進捗・extract 済みの記録・結果）と `camp`（次の遠征の候補）。プレイヤーの状態に `at_camp`（盤面から外れている）と `extractPos`（再開地点）。どれも任意フィールドで、v1 のログはそのまま畳み込める。
- 目的: `reach_depth`（目標の階に誰かが着く）、`slay_guardian`（守護者のエンティティが消える）、`retrieve_relic`（遺物を参加者が持つ。手放せば未達成に戻る）、`endless`。目標深度は生成済みの最深階＋`aheadMin`〜`aheadMax`（最初は `firstTargetDepth`）なので、目標階は必ず未生成。目標階の生成時に `objective` ストリームで守護者・遺物を置く。
- 守護者: その深度の通常モンスター（深層の敵の混入抽選は使わない。動かない・逃げ回る archetype は除く）に `target: guardian` の接辞を付けたもの。遺物 `core:relic` は効果を持たない専用アイテムで、通常の生成では出ない。観測では `role` で分かる（居場所は教えない）。
- 進捗は各 step の終わりに engine が World から計算し、変化があれば `objective_progress`（俯瞰専用）と `objective_completed` を出す。
- `extract`: 階段（上り・下り）の上で、追跡中の敵（逃走中を除く）が見えていないこと。達成していれば帰還、未達成なら `confirm` 付きで撤退。プレイヤーを盤面から外し（全回復・状態異常解除）、`at_camp` にする。盤面に誰も残らなければ遠征を終える（`expedition_ended`）。キャンプに誰かいれば次の候補 3 つを出す（`expedition_offered`）。
- 死亡・引退でも盤面に誰も残らなければ遠征を終える（`died` / `retired`）。キャンプにも盤面にも誰もいなければランを終える。
- `start_expedition`: キャンプの全員を各自の `extractPos` に戻して始める（フロアの時刻はそのまま）。`new_run` は参加の直後に `start_expedition`（`source: 'system'`）を流して最初の遠征を始める（commands.jsonl に残るので再実行で再現できる）。
- COOP: 目的はパーティで共有。各自が `extract` し、盤面に誰も残らなくなった時点で、達成のうえで帰還した人が 1 人以上いれば `completed`。達成の基礎点は達成で帰還した人の成績に入る。途中参加者は参加者一覧に入らない（成績の差分に含めない）。
- 記録: `expedition_ended` に途中経過の `RunSummary`（シード無し）を入れ、サーバーは遠征の終了ごとに `summary.json/md` を書き直す（キャンプで止めても記録が残る）。`summary.md` は遠征ごとの節を持つ。リプレイ索引には遠征の開始・目的達成・終了のマーカーと `expeditions` を入れる。

### 13.3 ホスト駆動
- ターンフィード `GET /api/player/feed`（SSE）: `turn`（手番が来た。マクロ展開中は送らない）、`idle`（`idleNoticeMs` ごと）、`ended`（遠征／ラン）。
- 参照ドライバ `tools/drive.ts`（`npm run drive`）: フィードを購読し、エージェント呼び出しを差し替え可能にする（コマンド実行：標準入力に観測テキスト、環境変数 `MUSE_PLAYER_TOKEN`・`MUSE_MCP_URL`・`MUSE_TURN_JSON`／HTTP POST／内蔵ダミー）。行動は選ばない。上限（手番数・実時間・連続エラー・idle の再送回数）で中断し、遠征は進行中のまま残る。
- 再開ブリーフィング: `resume_run` に遠征の目的と進捗・現在地・直近の節目（最大 10 件）・メモを付ける。
- MCP のリソース購読通知は実装していない（任意項目。必要になったら `muse://player/turn` を追加する）。
- MetaMuse 用の呼び出し設定は未確定（依頼者に確認する）。コマンド実行か HTTP POST のどちらでも繋げる。

### 13.4 休憩
- 回復の蓄積値 `actor.regen`: 手番の終わりに +1（休息なら +`restMultiplier`）、回復間隔に達するごとに 1 HP。満タンなら 0。値は `actor_scheduled.regenAfter` に after 値として記録する。
- 休息 = 追跡中の敵（逃走中を除く）が見えない状態での `wait`。`rest` の各手も同じ。
- 観測の `self.rest_estimate` は engine と同じ関数（`regenInterval`・`regenStep`、shared/catalog.ts）と `self.regen` で数える。徘徊の目安は公開ルールの湧き間隔から `floor(time/intervalMax)〜ceil(time/intervalMin)`。次に湧く正確な時刻は出さない。
- 初期値で Lv1 の戦士（HP 30）が半分から全快するのに 45 手番。徘徊の湧き間隔（4000〜6000）に対して「おおよそ 1 回湧くかどうか」。

### 13.5 敵の耐久の学習
- `damaged.dealt`（実ダメージ）を文章と「与えた最大ダメージ」に使う。`amount` は出目どおり（脅威の見積もりに使う「受けた最大ダメージ」は出目どおり）。
- `knowledge.damageSeen[個体]`: 見ていたプレイヤーの、その個体への累計実ダメージ（`damaged.seenTotals` の after 値）。個体が死んだら消す。
- 目の前で倒れた個体は `died.maxHp` で最大 HP が分かり、思い出の `hpSeen {min,max,samples}` に入る（守護者は除く）。
- `hp_left_est` は `hpSeen`・4 段階表示・`damage_seen` から計算する（`hpLeftEstimate`）。
- 逃走中（`fleeing`）: 追跡中で、HP が種族データの `fleeBelowHpPct` を下回っている敵。逃げ回る手負いの敵が extract と休息を永久に妨げないようにするための区別（実装で追加。HP 4 段階と同程度の公開情報）。

### 13.6 探索密度と調整値
- `floorTypes.pacing`: 深度帯ごとの `size`・`stairsPath`（到着地点から下り階段までの歩行距離。範囲内のセルに下り階段を置き、`stairs_path` validator で確かめる）・`monsters`／`items`／`traps` の `per1000`。設計書の例の `features` は、通常の生成で密度を持つ地物が罠だけなので `traps` とした。
- 現在の値（standard）: 深度 1〜2 は 38×22・階段距離 12〜34・敵 9／アイテム 11／罠 2（per1000）、3〜6 は 44×27・15〜44、7 以上は 54×32・18〜64。cavern は深度 1〜2 だけ 40×24（敵 10／アイテム 10）で、ほかは同じ。
- 計測（`npx tsx packages/tools/src/cli.ts pacing --runs 100`、貪欲 bot）: 階段発見までの手番の中央値は深度 1〜2 で 45（目安 60）、3〜6 で 87（目安 90）、7 以上で 182。判断間隔（マクロ 1 回の平均手数）5.2（目安 20 以下）。1 階あたり 225 手番。最初の遠征は中央値 340 手番・行動の呼び出し 105 回で、100 ラン中 92 ランが達成。
- `balance.json`（core:balance）: 回復・休息の倍率・休憩の上限・マクロの上限・徘徊・スコア係数・遠征の目標深度の幅と基礎点・遺物を守護者が守る確率。`get_rules` の数値は公開カタログの `rules` から生成する。
- 生成が変わったのでコンテンツのバージョンが変わる（旧リプレイはイベントから再生するので影響しない）。v1 で進行中だったランは、復旧時の再実行が一致しない（ログはそのまま再生できる）。

## 14. 改善 v3（V3-1 観測の修正・V3-2 戦利品と確定）

経緯は [IMPROVEMENTS_V3.md](IMPROVEMENTS_V3.md)、評価は [feedback/AI_PLAYTEST_2026-11-16.md](feedback/AI_PLAYTEST_2026-11-16.md)。ここには実装で確定した設計を書く。プロトコルの詳細は [PROTOCOL.md](PROTOCOL.md) §1.2・§2・§3・§4・§5・§8。V3-3 以降は未実装。

### 14.1 観測と操作の修正（V3-1）
- 投擲: engine の `shotClear`（投擲と同じ `line` で、途中の地形と行動者を見る）を知覚の時点で計算し、`knowledge_updated.shotsAfter` に after 値で残す。観測の `shot` はそれを読むだけ。ID 指定で経路が通らなければ `no_line_of_sight`（状態を変えない）。結果は `item_thrown.outcome` の 5 通りで、どれも落下地点とともに文章になる。
- 投げた物には `item.thrownBy` を付け、投げた本人がそのマスに入ると拾う（`item_picked_up.auto`。手番を追加しない。所持品が一杯なら拾わない）。`collect` マクロは既知の自分の物を近い順に回る。
- `changes`: `killed` / `died_seen` は知覚したイベント（`died`・`attack`）で区別する。`new_hostile` は「このランで初めて見た個体」で、判定に使う「初めて見た seq」は `knowledge_updated.metAtAfter`（engine が `seq + 1` を入れ、reducer は代入だけ。reducer で計算すると旧ログの畳み込みが変わるため）。それ以外の再出現は `reappeared`。
- マクロの停止: 初見の個体・追跡中で現れた既知の個体・追跡への変化・被攻撃（外れも）・被弾。逃走中の個体では止まらない。`rest` は敵が視界に入ると止まる。
- `outcome` の被害合計: 行動から次の手番までのイベントのうち自分が対象の `attack`・`damaged`・`healed` から数える（`PlayerPort.act`）。知覚ログ（文章のある出来事）は通常の命中の `attack` を持たないので使わない。HP の前後と、間の回復を添える。
- マクロは攻撃しない（次のマスに敵がいれば `blocked`）。隣に起きている敵（逃走中を除く）がいれば動かない（`hostile_adjacent`）。
- 姿の見えない攻撃者は `fromDir`（被害者にだけ渡す）で方向だけを文章にする。射撃の最長距離は、見ていた者の思い出（`rangeMax`）にだけ入る。
- 推定残り HP は記録が `balance.estimate.minSamples`（3）体未満の間は上限を出さない。
- 地図: 種族ごとに一意の `glyph`（content で検証）、上 2 行の x 目盛りと行頭の y 目盛り、フロア外のクリップ。同じセルの同種のアイテムは 1 行にまとめる。
- 文章: 接辞名を含むアイテム名、射撃の動詞の統一、`look`・`recall` に体力の記録と推定、キャンプ専用のテキスト、`get_rules classes`、観測の `self.speed`。
- 応答の量: `set_options`（地図 auto／所持品 on_change／▶ 行 short が既定）。サーバーがプレイヤーごとに前回の応答（既知セル数・所持品の要約・状態）を持ち、変化が無い欄を省く。`structuredContent` は省かない。

### 14.2 戦利品と確定点（V3-2）
- スコア版 2: ランのスコア = 確定点（`player.stats.banked`）の合計。払い戻しは帰還 = 戦利品 × 倍率、撤退 = (戦利品 − 目的) × `withdrawPct`%、死亡・引退 = 0（`stats.lost` に記録）。式は `shared/catalog.ts` の `haulTotal`・`payoutOf`・`overreachPoints`・`nextOverreach` で、engine と観測が同じ関数を使う（観測の `if_extract_now` = 実際の払い戻し、をテストで確かめる）。`RunSummary.scoreVersion: 2`。記録の一覧は版ごとに並べ、版 1 の記録は別の表として残す。
- 戦利品のうち、賞金・発見・撃破は遠征に共有の `expedition.haul` として積む（`haul_changed`。各 step の終わりに、その step のイベント（`died`・`item_identified`）から `accrueHaul` が数える。種族の発見は、思い出の撃破数からその step で倒した数を引いて 0 のとき 1 回）。目的・深追い・宝は World から公開の式で毎回計算する（深追いは `progress.maxDepth`、宝は所持品の `item.value`）。
- 宝: 分類 `treasure`、`value {dice, mult, perDepthPct}` は生成時に振って `item.value` に入れる（同じシードなら同じ）。初期 6 種。出どころは通常の床（loot の重み 6）・宝物庫（15）・守護者の確定ドロップ（`core:treasure_loot`）・条件 `crowded` の追加分。`extract` で換金し、所持品から消す（`objective_progress.extractedAfter[].treasure`）。
- 守護者の賞金 = `guardianBounty.base + perDepth × 深度`（生成時に `bounty`）。
- 目的達成後の圧力: `slay_guardian`・`retrieve_relic` の達成後は徘徊の湧き間隔 × `afterObjective.wanderIntervalPct`（50%）。遺物を拾うと、その階の眠っている・気づいていない敵が起きて遺物の場所へ向かう。どちらも公開ルールで、`changes` の文章で知らせる。
- 候補の 3 枠: `balance.expedition.slots` の `aheadMin/Max`（生成済みの最深階からの幅）・`traitsMin/Max`・`pointsPct`。最初の遠征は `firstTargetDepth` から（野心は 1 階深い）。候補は `expedition|通番` のシードから作るので再現する。
- 条件 `expeditionTraits`（`data/core/expeditionTraits.json`）: `monstersPct`・`itemsPct`・`treasurePct`・`wanderIntervalPct`・`sightDelta`・`noWander`・`noFountain` と倍率・危険度。目標階までに生成する階に効く（`GenMods`、徘徊は scheduler、視界は stats）。`elite`（名前付きの強敵）は V3-5 の名前付きの敵と一緒に入れる（未実装）。`treasurePct` は 150 で宝 1 個、以後 50 ごとに 1 個を追加で置く。
- 危険度 = clamp(3 + 推奨レベル(目標深度) − レベル + 条件の危険度, 1, 5)、推奨レベル = 1 + floor(深度 × `recommendedLevel.mul` / `div`)。
- 計測（`npm run choices -- --runs 40`、貪欲 bot。深追いの方針は「HP 60% 未満になったらその場で帰る」）:

| 比べたもの | 方針ごとの確定点の中央値 | 最良/最悪 | 遠征あたりの死亡率 |
|---|---|---|---|
| 粘るか帰るか（標準枠） | 即帰還 6250／1 階深追い 5261／2 階深追い 6034 | 1.19 | 37%／46%／54% |
| 遠征候補（即帰還） | 堅実 5968／標準 6250／野心 5922 | 1.06 | 28%／37%／53% |

  目安（どれも他の 0.8〜1.25 倍、野心の死亡率が明確に高い）に入る（評価で見つかった不具合を直した後の値）。ただし AI プレイヤーの評価では、2 体とも「最初の深追いは着いた階段ですぐ帰れるのでほぼ無料、迷わない」と答えた。bot の比が目安に入ることは、選択が本当に割れていることの証明にはならない。調整した値: `overreachFirst` 600→1000、`overreachStep` 300→500、`slots.safe.pointsPct` 70→80、`slots.ambitious.pointsPct` 130→150。ランは死亡か 1500 行動まで続けるので、ランの死亡率はどの方針も 90% 前後になる（比べるのは遠征あたりの死亡率）。中央値は 40 ランでもぶれがある（±10% 程度）。

## 15. 見直し V3-2R（V3-2 後の評価を受けて）

設計は [IMPROVEMENTS_V3.md](IMPROVEMENTS_V3.md) §14〜§16（§14 は §1・§2・§10・§11 を上書き）、評価は [feedback/AI_PLAYTEST_V3-2_warrior_2026-11-16.md](feedback/AI_PLAYTEST_V3-2_warrior_2026-11-16.md)・[…_scout_…](feedback/AI_PLAYTEST_V3-2_scout_2026-11-16.md)。ここには実装で確定した設計を書く。会心と経験値のルールを変えたので `engineVersion` は 0.3.0（旧ログの再生には影響しない。進行中のランの再実行は一致しない）。

### 15.1 踏破とキャンプ
- 深追いの点は「踏破」: 目標より深い階の下り階段に参加者が立ったときに入る（`progress.crossedDepth`。engine が各 step の終わりに位置と地形から計算）。着いただけでは入らない。`next_overreach` は `{ depth, points, at: 'stairs_down', path_len }`、`next_camp` は `nextCampOf`（生成済みの最深階 + 堅実の幅、推奨レベル）。下限が変わると `changes` の `next_camp`。
- 係数: `overreachFirst` 600・`overreachStep` 300（目的の基礎点の最小 1600 ≥ 踏破 2 階分 1500）。
- 候補: 堅実 +1・標準 +2・野心 +3〜4（重ならない）。目的の種類は枠ごとに別（最初は 到達・守護者・遺物、以後は `expedition|通番` のシードで並べ替え）。最初の候補は 堅実 地下2階・標準と野心 地下3階（`firstTargetDepth`）。危険度の 5 段階は廃止し、`offerGap` で推奨レベル・差・条件の危険度を出す。推奨レベルは `recommendedLevelByDepth`（bot の実測の中央値。表より深い階は直近 4 階の傾きで外挿）。
- `new_run` は `objective` を省くとキャンプから始まる（参加コマンドの `atCamp`。engine の `joinPlayer` が盤面から外して `at_camp` にし、再開地点を入口にする）。ターンフィードは最初の候補選びを `turn` として送る（`ended` ではない）。

### 15.2 呼び出しを資源として
- 原則「1 回の呼び出しは 1 つの判断」。`RunSession.runMacro` は実行前に `macroNext` を一度試し、最初の判断が停止なら手番を使わずに `macroStopError` を返す（0 歩の呼び出しを作らない）。
- 移動マクロの `mode`（careful / steady / flee）と `hpFloor`。careful の停止は「初見の種族」（個体ではない。`knownKinds` = 思い出のある種族 + マクロ中に見た種族）、自分に届く追跡中の敵（動かない種族は隣接時だけ）、被攻撃、毒以外の被弾、状態異常、HP 50%・25% の線、階段の発見（explore）。アイテムの発見では止まらない。
- 拾得: explore（既定）と、アイテムを目的地にした travel は、足元の拾える品を `pickup` の 1 手番で拾う。explore はフロンティアに加えて拾える品の位置も行き先にする。拾わない物: 遺物（拾うと階が起きる）、鑑定済みの有害品。一杯なら拾わない。`collect { what: 'items' }`。
- `fight { target, hpFloor }`: 隣の相手への近接攻撃を繰り返す（相手が隣にいることが条件。§3.1 の予備動作は V3-3 で停止条件に足す）。
- 未見の区画: 知識に `mapped`（地形だけ知ったセル）を持ち、地図の巻物が追加し、視界に入ると外す（`knowledge_updated.mappedAdd/mappedDel`）。フロンティアは「見たセル」と「見ていないセル（未知 + mapped）」の境界。
- 気配: 目標階にいる参加者に、未討伐の守護者か未入手の遺物の 8 方向とチェビシェフ距離 10 以内か（`knowledge.sense`、`senseAfter`）。
- 応答の整理: 記憶のアイテムは近い 3 件（戦闘中 0 件。遺物は戦闘中以外常に出す）、投擲の候補は対象が同じ品目をまとめる、遠征と戦利品と気配は 1 行、休めないときは休憩の見積もりを出さない、結果の文に入れた出来事は「直前の出来事」に重ねない。

### 15.3 判断に要る数字
- 自分の持ち物の性能（`itemStats`・`itemStatsText`）: 武器のダイス・命中、防具の装甲・回避、投擲物のダイス・射程・命中。接辞（品物の接辞だけ。`catalog.affixes[].itemMods`）込み。敵の接辞の値は出さない。
- 射程: `shots` は投げられる持ち物ごとに clear / blocked / out_of_range（観測が `line` と同じチェビシェフ距離と公開の射程で計算）。ID 指定の射程外は engine が `out_of_range` で拒否。
- 脅威: その種族から攻撃を受けた記録が無ければ `null`。`worst_hit` = 思い出の受けた最大ダメージ。`lethal_range` は追跡中（逃走中を除く）の敵の `worst_hit` が今の HP 以上。
- 会心: ダイスの最大値 + 威力（投擲・射撃は威力なし）、装甲無視（`diceMax`）。会心で乱数を消費しない。
- 推定残り HP: 上限を使うのは記録 5 体以上（`estimate.minSamples`）。文は「記録どおりなら残り 6〜8（記録 3 体: 体力 8〜8）」。

### 15.4 成長と装備
- 経験値: 新しい深度に初めて着く（`xp.perNewDepth` × 深度）、目的の達成（`xp.perObjective` × 目標深度、盤面にいる参加者）。レベルアップの文に上がった能力値（`level_up.gains`）。
- 回復の薬の稀少度を 1 → 2。重い鎧の痛みは V3-4。

### 15.5 §14.7 の修正
- 戦闘の文の接辞（`attack`・`damaged`・`died`・`item_thrown` に接辞の配列。見えていない側は射影で伏せる）。
- MCP の引数の形が合わないとき（`use_item` の `target` など）もゲームのエラー形式。`use_item { targetSlot }`。鑑定の既定はスロット順で最初の未鑑定品（使った巻物の種類を除く。乱数を使わない）。
- 逃走中の敵は休息を妨げない（valid_actions の距離の条件を外した）。
- 視界から消えた敵: 最後に見た位置と、外へ出た一歩の向き（射影で `entity_moved.dirOut`。行き先は伏せたまま）。
- V3-2R の AI 評価で見つかった不具合を直した: 毒で倒した敵は毒を与えた者の撃破（`StatusInst.source`。賞金・撃破点・経験値）／rest は毒の継続ダメージで止まらない／同じ状態異常の延長・掛け直しではマクロを止めない／見えている敵が追跡に変わった停止は `hostile_alerted`／追っていた相手を見失った停止は `target_gone`／目的地のアイテムを拾った travel は `arrived`／collect の回収数は実際に拾った数／被害の要約で攻撃と毒などのダメージを分ける／方角は 8 方向に丸める（`compassDir`。表示と気配）／「再び見えた」は前の応答で報告した個体だけ／動かない敵は隣接していなければ valid_actions の rest も「不可」にしない／状態異常の文に接辞付きの名前／達成して持ち帰った遺物は帰還で納める（所持品から外す）。

### 15.6 計測（§14.6 の 1・2。`npm run budget -- --runs 30`、貪欲 bot）
bot は fight・steady・explore の拾得・気配を使う。方針は「即帰還」と「3 階まで踏破（途中で引き返さない）」の 2 つ × 30 ラン。

| 測るもの | 結果 | 目安 |
|---|---|---|
| 踏破 1 階あたりの死亡率（1 / 2 / 3 階目） | 0%（21 回）/ 0%（15 回）/ 0%（9 回） | 最初の 1 階で 8% 以上・階ごとに上がる: **未達** |
| 踏破の期待値 ÷ 即帰還の期待値 | 1.19（判断 11 回） | 0.9〜1.3 |
| 深度ごとのレベル − 推奨 | 全深度で ±1 以内（表は同じ計測の中央値） | ±1 |
| 0 歩で終わったマクロ | 0（6116 回中） | 0 |
| 5 歩未満で止まった移動マクロ（敵へ近づく travel を除く） | 19% | 20% 以下 |
| 敵 1 体あたりの呼び出し（中央値） | 1 | 3 以下 |
| アイテム 1 個あたりの呼び出し | 0.01 | 0.5 以下 |
| 最初の遠征を帰還まで終える呼び出し（中央値、即帰還） | 65 | 60 以下: **未達** |

- 踏破の死亡率: bot は踏破の前に休んで全快し、一対一の戦いを `fight` で処理するので、目標より 1〜3 階深い階を横切っても死ななかった（bot の死は守護者戦など目的の前に集中する）。目的達成後の圧力（湧き間隔 50% → 30%）や経験値を減らしても 0% のままだったので、係数では動かさず、AI プレイヤーの評価（§14.6 の 3）で判断の重さを確かめる。
- 敵へ近づく travel は 5 歩未満が自然なので、移動マクロの割合から外して別に出す（約 400 回、うち 5 歩未満 89%）。
- 調整した値: `xp.perNewDepth` 4・`perObjective` 8、`recommendedLevelByDepth` [1, 2, 2, 4, 4, 5, 6, 7]、回復の薬の稀少度 2、目的達成後の湧き間隔 50%（据え置き）。

## 16. 見直し 2 V3-2R2（V3-2R 後の評価を受けて）

設計は [IMPROVEMENTS_V3.md](IMPROVEMENTS_V3.md) §18（§14.1 の点の式・§14.3 の候補の式・§14.6 の目安の一部を上書き）、評価は [feedback/AI_PLAYTEST_V3-2R_warrior_2026-11-16.md](feedback/AI_PLAYTEST_V3-2R_warrior_2026-11-16.md)・[…_scout_…](feedback/AI_PLAYTEST_V3-2R_scout_2026-11-16.md)。転移・守護者の選び方・群れの数で乱数の使い方が、候補と踏破で点の式が変わったので `engineVersion` は 0.4.0。

### 16.1 退却（§18.1）
- `extract` は階段の上なら追跡中の敵が見えていてもできる（`extractError` から追跡中の判定を外した。休息の判定 `huntingInView` はそのまま）。観測の `extract_blocked_by` から `hostile_hunting` を外した。
- 帰還の綱 `core:lifeline`（品物の `bound: true` = 捨てる・投げることができず、所持数に数えない。分類 `lifeline` は戦利品の表に無いので坑の中には出ない）。`startExpedition` が参加者の所持数を 1 本にそろえる（`item_issued` イベント。余りは消し、無ければ足す）。使うと効果 `recall` が状態 `core:recall`（ハンドラ `recall` = 行動不能 + 切れたときの `expire`）を `lifeline.turns` 手番付ける。プレイヤーの手番の開始で行動不能のまま進み（`beginPlayerTurn` の既存の仕組み）、切れると `lifelineReturn` → `doExtract(..., lifeline: true)`。1 回の `use` の中で `advance` が最後まで進めるので、ソロでは 1 回の呼び出しでキャンプに着く（COOP では他の人の手番を挟む）。
- 払い戻し: `payoutOf(..., lifeline)` = (戦利品 − 未達成なら目的) × `lifeline.pct`%（倍率なし）。`extracted[].lifeline`、遠征の終了理由 `lifeline`（達成済みでも「達成した遠征」の数には入れない）、`player_state.reason: 'lifeline'`。持っている遺物は達成扱いなら納める。
- 転移: 着地点は全セルを走査して「元の位置から `teleport.minDistance` 以上、かつ追跡中の敵（プレイヤーの転移）／プレイヤーの視界（敵の転移）から見えない」→「距離だけ」→「通れる全て」の順に候補を作り、`runtime` で 1 つ選ぶ。
- 逃げ道: 自分に届く追跡中の敵が見えていて既知の階段に辿り着けるとき `alerts.escape { stairs, path_len, faster }`（階段の上では出さない）。

### 16.2 危険の表示（§18.2）
- 見れば分かる特徴: `visible.monsters[].speed`（自分の今の実効の速さとの比較。`EntityView.speed` = 個体の素の速さを状態異常の倍率で補正）と `traits`（種族の公開タグの pack / ranged / stationary）。体力・威力・回避・弱点は伏せたまま。
- 群れ: 自分に届く追跡中の敵が 2 体以上なら `alerts.incoming { hunting, worst_sum, unrecorded, hp }`（`multiple_enemies` を置き換え）。`lethal_range` は単体の `worst_hit` か、記録のある追跡中の敵の合計が HP 以上。
- 命中の記録: 思い出に `hitsByYou { melee, thrown }`・`hitsOnYou`（[命中, 回数]）。engine の `recordHit` が近接・投擲・射撃のたびに、相手が見えているときだけ更新する。観測の `hits` と文（「あなたの命中 近接1/6・相手の命中 3/5」）。
- 「不明（初見）」は撃破が無く、遭遇した個体の数がいま見えている数以下の種族だけ（`first_seen`）。ほかは「不明（被弾の記録なし）」。
- 浅い階の群れ: 生成の群れの数を `min(種族の上限, 深度 + 1)`。

### 16.3 キャンプの候補と踏破（§18.3・§18.4）
- 候補の点 `offerPoints(rules, slot, type, guarded, targetDepth)` = 枠の基礎点（`slots.*.base` 1600 / 2400 / 3600）× 種類の係数（`typePct`）× 深さの係数（`depthPct` 100 + 5 × 目標深度 %）。`points`・`pointsPct`・`pointsPerExtraDepth` は廃止。野心は +3 固定。推奨レベルの表は [1, 2, 2, 3, 4, 5, 6, 7]（隣の差 1 以下）。
- 踏破の点 `overreachStepPoints` = 目的の点（倍率をかける前）× (`overreachPct.first` 25 + `step` 10 × (n − 1))%、下限 600 + 300 × (n − 1)。
- 下への風・探索の進み具合: engine の `floorHintFor` が知識に `floorHint { floor, draft, explored }` を書く（`knowledge_updated.hintAfter`。変化したときだけ）。draft は今いる階の下り階段を 1 つも見ていない間の、最寄りの下り階段への 8 方向。explored は通れるマス（扉を含む）のうち自分の目で見た割合（地図の巻物だけで知ったセルは除く）を 40・65・90% で 4 段階。数え直しは新しく見たセルがあるときだけ。観測は `self.floor.draft / explored / hint_text`、`next_overreach.dir`、`next_camp_after_crossing`、`if_lifeline_now`。

### 16.4 呼び出し（§18.5）
- `fight { target, with?, hpFloor? }`: 近接は隣なら殴り、追跡中で届かない相手は `FIGHT_WAIT_MAX`（10）手番まで待つ。一度殴り合った後に離れた相手は、追跡中で 2 マス以内なら 2 手番まで待つ。`with` はそのスロットの品を `throw`（ID 指定）で投げ、射程と射線が通らない間は待つ。品の種類が開始時と変わった・尽きたら `out_of_ammo`。眠っている・気付いていない相手を待つことになるなら `target_not_hunting`、動かない相手を待つなら `target_not_approaching`（どちらも開始前なら手番を使わずに拒否）。
- `wait { turns }`（2〜10）は `RunSession` がマクロとして展開する（種類 `wait`）。新しく見えた敵・新しく隣に来た起きている敵・攻撃・毒以外の被害・状態異常で止まる。
- careful と steady は、その階の下り階段を初めて見たら `stairs_seen`（flee は止まらない）。rest は、このマクロの間に一度見た個体が逃げながら出入りしても止まらない。
- 経路: `buildNavGrid` が見えている動かない敵の 8 近傍を `hazard`（罠と同じ。strict で避け、道が無ければ actors で通る）にする。
- 自分が投げた物は `visible.items` で 1 行（本数・最寄りの位置・全 ID）。`valid_actions` の fight と steady に既定の hp_floor の実数、帰還の綱の行に手番・確定点・群れの被害見込み。

### 16.5 守護者と不変条件（§18.6・§18.7）
- 守護者: 階の候補（生成表のタグ・深度の重み > 0）から、動かない・逃げ回る行動様式と `vermin` を除き、経験値の降順の上位半分から `objective` ストリームで 1 体。体力は `max(下限, 通常の式)`（下限 `guardian.minHpBase` 10 + `minHpPerDepth` 3 × 深度。設計の初期値 16 + 4 × 深度から計測で下げた。§16.6。`SpawnSpec.minHp`）。守護者の接辞の体力は +100%（+150% から下げた）。
- 守護者が倒れた変化は `guardian_slain`（優先順の先頭。`changesLine` はほかの変化と別の行にして先に出す）。
- 視界外の毒: 射影で、自分が対象でない `via: 'poison'` の `damaged` は対象が伏せられていれば落とす。`died` は見ていない者に `id`・`pos`・`maxHp` に加えて `kind`・`affixes` も伏せ、文章は「あなたの毒で何かが倒れた」。撃破数・賞金・経験値は入る。思い出の種族の撃破数と「初めて倒した種族」の発見には数えない（種族を知らないので）。戦利品の理由にも種族を書かない（`bounty`）。

### 16.6 計測（§18.8。`npm run budget -- --runs 20`、貪欲 bot）
bot は投擲を `fight { with }`（3 マス以上離れた相手だけ）で、HP 30% 未満で群れか `lethal_range` なら階段の上で extract・遠ければ綱を使う。方針は「即帰還」「3 階まで踏破」× 20 ラン、枠ごとに「その枠だけを選ぶ」× 20 ラン（最大 4 遠征。その枠の遠征だけを数える）、斥候 × 20 ラン。

| 測るもの | 結果（最終） | 1 回前の計測 | 目安 |
|---|---|---|---|
| 踏破 1 階目が綱か死で終わる率 | 7.7%（13 回中 綱 1） | 18.2%（11 回中 綱 2） | 10〜25%: 回数が少なく揺れる |
| 踏破の期待値 ÷ 即帰還の期待値（綱の 50% を含む） | 1.17（判断 12 回） | 1.1 | 0.9〜1.3 |
| 堅実の達成率 | 74%（78 遠征。死亡 6・綱 14） | 78% | 90% 以上: **未達** |
| 標準の達成率 | 38%（60 遠征。死亡 13・綱 21・撤退 2） | 43% | 60〜85%: **未達** |
| 野心の達成率 | 30%（57 遠征。死亡 17・綱 23） | 36% | 30〜60% |
| 深度ごとのレベル − 推奨 | ±1 以内 | ±1 以内 | ±1 |
| 0 歩で終わったマクロ | 0（6490 回中） | 0 | 0 |
| 5 歩未満で止まった移動マクロ | 19.2% | 23% | 20% 以下 |
| 敵 1 体あたり・アイテム 1 個あたりの呼び出し | 1・0.02 | 1・0.02 | 3 以下・0.5 以下 |
| 最初の遠征の呼び出し（中央値） | 56（達成 6 ラン） | 67 | 60 以下 |
| 斥候の bot の呼び出しに投擲が占める割合 | 13.3% | 34%（2 マス先の相手にも投擲の fight を呼んでいた） | 30% 以下 |

- **枠の達成率**: 堅実・標準の不足は、ほとんどが守護者と遺物の目的（目的が到達なら堅実で 27/27 など全て達成）。死因の多くは守護者戦で、射撃して距離を取る種族（ゴブリンの投石兵）と、経験値の上位半分から選ぶようにした守護者が bot には重い。§18.8 の手段は効かなかった: 条件の数（標準 0〜1 → 0、野心 1〜2 → 1）を変えても達成率は変わらず（45%・32% のまま）、推奨レベルに届いた枠だけを選ぶ bot では標準と野心がほとんど選ばれない（標準の目標は最深 +2 なので、自然に育てば推奨より 1〜2 低い。表をどう変えても bot の強さは変わらない）。条件の数は戻した。
- **守護者の体力**（§18.9 で動かしてよい係数）: 下限を 16 + 4 × 深度 → 10 + 3 × 深度、守護者の接辞の体力を +150% → +100% にした（地下3階の守護者の体力の中央値 28 → 約 19。堅実 71% → 82%、標準 42% → 45%、野心 24% → 31%。いずれも 12 ラン）。これ以上下げると「守護者の特別感」（評価の指摘 6）と衝突するので、設計の判断に回す。
- 踏破の死亡は 0 で、綱が「死」の代わりになっている（綱か死の率の中身はすべて綱）。
- 調整した値: `guardian` { 10, 3 }、守護者の接辞 `hpPct` 100、推奨レベルの表 [1, 2, 2, 3, 4, 5, 6, 7]。

### 16.7 AI 評価で見つかった不具合の修正（IMPROVEMENTS_V3 §19.1）
- 射線の対称: 投擲と敵の射撃は同じ経路 `shotLine`（from→to の直線か、to→from の直線を逆にたどったもののうち、途中が通行可能で他のアクターがいない方）を使う。観測の `shots`・engine の拒否・実際の飛び方・敵の `clearShot` が一致し、向きで射線が変わらない。
- `valid_actions` の投擲の fight は隣にいない相手だけ。逃走中の敵に「あなたを攻撃中」を付けない。帰還の綱の行は、追跡中の敵がいるか HP が半分以下のときだけ説明を付ける（それ以外は名前と確定点だけ）。
- `travel_to` の目的地に指定したアイテムは、有害品・遺物でも拾う（explore と collect は今までどおり拾わない）。
- 休憩の見積もりは毒の残り（手番の開始で `power` ずつ）を数え、毒が抜けるまでの最低 HP（`rest_estimate.lowest_hp`）を出す。
- 結果の文の倍率は帰還（達成）のときだけ。撤退は「目的を除いて 50%」、綱は「50%」（どちらも倍率なし）。
- `turn.changes`: 報告済みの個体とアイテムは階・遠征をまたいで引き継ぐ（後の遠征で「新たな敵」にしない・同じアイテムの「見つけた」を繰り返さない。自分が投げた物のまとめ行の全 ID を数える）。
- 次の候補の文は「地下N階へ降りると地下X階以上」（次の候補は新しい階に着いた時点で深くなる。`next_camp_after_crossing` の意味は「次の踏破の階へ降りた場合」）。
- 行動結果の HP の前後: レベルアップで増えた最大 HP は「回復」ではなく「レベルアップ +N」。
- 守護者は命中の記録に含めない（体力の記録と同じ。受けた最大の一撃には含める）。
- 文言: `blocked` は「既知の経路が敵にふさがれている」、ルールの new_run の既定（省くとキャンプから）。

## 17. 見直し 3 V3-2R3（V3-2R2 後の評価を受けて）

設計は [IMPROVEMENTS_V3.md](IMPROVEMENTS_V3.md) §20（§18 の一部を上書き）、実装メモは同書 §21。到達の条件・候補の基準・点の式・経験値が変わったので `engineVersion` は 0.5.0。

### 17.1 目的と枠（§20.1）
- 到達（`reach_depth`、表示は「地下 N 階を踏破する」）の達成は「目標階以上の下り階段に参加者が立った」（`computeProgress`。着いただけでは達成しない）。帰還はその下り階段の上でできる。踏破の点は今までどおり目標より深い階の下り階段で入る。
- 守護者の格は枠で決まる（`guardianRankOf`: 堅実 1・標準 2・野心 3、枠の無い遠征は 2）。種族は `guardianCandidates`（生成表のタグと深度の重み、vermin と動かない・逃げ回る型を除く。格 1 は経験値の下位半分で射撃して距離を取る型も除く、格 2・3 は上位半分）から選ぶ。体力の上乗せと下限は `balance.guardian.ranks`（格 1: +50%・6 + 2 × 深度、格 2: +100%・10 + 3 × 深度、格 3: +150%・同）。守護者の接辞の体力は 0（上乗せは格で付ける。`SpawnSpec.hpBonusPct`）。堅実の遺物は無防備。
- 候補を作るときに守護者の種族を決め（`pickGuardianKind`。階の種類と地形は深度とシードから決まるので生成時と同じ候補）、`offer.guardianKind`（射影で伏せる）と `offer.guardian { rank, traits }`（公開: fast / slow / ranged / large / armored）に持たせる。遠征は `guardianKind` / `guardianRank` を引き継ぎ、生成時（`placementFor`）に使う。
- 種類の係数: 到達 100・守護者 110・遺物 110・守護者付きの遺物 125。

### 17.2 次の候補の基準（§20.2）
- 目標の深さは `campDepthOf(world)`（目的を達成して戻った——綱を含む——遠征の目標深度の最大）から数える: `max(最初の候補の深さ, campDepth + 幅)`。踏破で先まで降りても深くならない。観測の `next_camp` は 1 通り（`next_camp_after_crossing` は廃止）。PlayerView に `campDepth`。
- 目標階の下り階段にすでに立った（下の階が生成済み）なら、その枠に踏破型は出さず守護者か遺物に替える。目標階が生成済みなら、遠征の開始時に守護者・遺物を置く（`placeOnExistingFloor`: 生成時と同じ規則。入口から歩いて遠い側の半分、乱数は `expedition|通番|place`）。
- 撃破の経験値 = 個体の経験値 × (100 + `xp.killDepthPct` 15 × (深度 − 1))%。

### 17.3 帰還の綱・戦う前に読む（§20.3・§20.4）
- 綱は即時（`lifeline.turns` 0。効果 `recall` がその場で `lifelineReturn`）。1 以上にすれば従来の行動不能の状態で動く。
- 見れば分かる特徴に体格（種族データの `size`。小柄・大柄を出す）と重装（素の装甲 3 以上。カタログは真偽だけ）。
- `worst_turn` = `worst_hit` × 自分の 1 手番に相手が行動する回数（`attacksPerTurn`: 速さの比の切り上げ）。`incoming`・`lethal_range` はこれで計算し、合計の 2 倍が HP 以上なら `lethal_2turns`。共有の `danger.ts`（観測とマクロで同じ式）。
- fight は、次の手番に届く追跡中の敵（隣・飛び道具）の `worst_turn` の合計を受けると `hp_floor` を割るなら止まる（`hp_risk`。始める前なら手番を使わずに拒否）。被弾の記録の無い種族から初めて被弾したら一度止まる（`first_hit`）。`hp_floor` ちょうども止まる（steady・flee も）。
- 通りの記録（`dmgByYou`）、守護者の記録の分離（思い出のキー `guardian|種族`。体力・命中・最大の一撃・撃破。`recall` は「守護者の記録」を別に出す。守護者の撃破は「初めて倒した種族」の発見に数えない）。
- 隣に起きている追跡中の敵がいるとき、薬・巻物の valid_actions に「使う間に隣の敵が行動する」。

### 17.4 戦う・探す理由と小さな直し（§20.5・§20.6）
- 撃破の点 = 種族の経験値 × `haul.killPerXp` 6 × 深さの係数（`depthPct`）、接辞付きは × `killAffixPct` 150%（`killPoints`）。`perKill` は廃止。大柄な種族と接辞付きの個体は宝を必ず落とす（宝の価値は今までどおり深さで増える）。
- `explore { toward: 'draft' }`: 下への風の方角と隣り合う方角のフロンティアを優先する（無ければ全体）。
- 帰還する階段の extract に「次の遠征はこの階段から始まる」。同じか劣る装備（装備中の品と同じ種類で、接辞が装備中の品の接辞に含まれる）は explore・collect で拾わず、equip も出さない（travel_to で目的地に指定すれば拾う）。2 回目以降の遠征の開始の説明は 1 行（`briefingShort`）。steady・flee は、次のマスをふさぐ逃走中の敵を攻撃して進む。

### 17.5 計測（§20.7。`npm run budget -- --runs 20`、貪欲 bot）
方針: 即帰還・3 階まで踏破・直行（各 20 ラン、最大 4 遠征）、枠ごとに「その枠だけを選ぶ」（各 20 ラン、最大 4 遠征、その枠の遠征だけを数える）、斥候 20 ラン。bot は HP 30% 未満で `lethal_range` なら階段の上で extract・遠ければ綱、fight が被弾前の停止で断られたら 1 発だけ殴る。

| 測るもの | 結果 | 目安 |
|---|---|---|
| 堅実の達成率 | 51.5%（68 遠征。死亡 2・綱 27） | 85% 以上: **未達** |
| 標準の達成率 | 30.9%（68 遠征。死亡 2・綱 33・撤退 9） | 55〜80%: **未達** |
| 野心の達成率 | 20.4%（54 遠征。死亡 4・綱 27・撤退 6） | 30〜60%: **未達** |
| 種類ごとの差（堅実 / 標準 / 野心） | 18 / 36 / 44 ポイント（到達が最も高く、守護者が最も低い） | 15 以内: **未達** |
| 全部と戦う bot の「目的と踏破を除いた割合」 | 39.3% | 25〜40% |
| 直行 bot の同じ割合 | 22.5% | 10% 以下: **未達** |
| 1 呼び出しあたりの確定点の比（直行 ÷ 全部と戦う） | 0.81（直前の計測は 0.83・0.71） | 0.8〜1.25 |
| 直行 bot がキャンプに戻ったとき、堅実の枠の推奨との差が +1 以下 | 100%（57 回） | 80% 以上 |
| 踏破 1 階目が綱か死で終わる率 | 30%（10 回中 綱 3） | 10〜25%: 回数が少なく揺れる（別の計測で 25%） |
| 踏破の期待値の比 | 0.98 | 0.9〜1.3 |
| 深度ごとのレベル − 推奨 | ±1 以内 | ±1 |
| 0 歩のマクロ・5 歩未満の移動マクロ・敵／アイテムあたりの呼び出し・最初の遠征の呼び出し・斥候の投擲 | 0・18.4%・1・0.01・53・4.2% | すべて目安内 |

- **枠の達成率**: 失敗のほとんどは死ではなく綱による撤退（目標階を横切る途中で HP 30% 未満かつ「1 手で倒されうる」になる）。到達は目標階の下り階段まで横切る必要ができたので、堅実の到達は V3-2R2 の 100% から 54% に下がった。守護者の体力を格ごとに一段下げても（格 1 +25%・格 2 +50% と下限 8 + 2 × 深度・格 3 +100%）達成率はほとんど動かなかった（堅実 51.5% のまま、標準 26.5%）。浅い階では体力の下限が上乗せより効き、守護者の硬さが主因ではない。守護者の体力は設計の初期値に戻した。
- **推奨レベルの表**: 2 方針の中央値の平均は 1, 2, 2, 4, 4〜5, 6, 6〜7（深度 1〜7）。隣の差 1 以下（§18.3）の制約のもとで今の表 [1, 2, 2, 3, 4, 5, 6, 7] と全深度で ±1 以内なので据え置いた。
- **直行 bot の割合**: 直行でも追ってくる敵とは戦い、通り道の宝も拾うので 20% 台になる。直行 bot の 1 呼び出しあたりの確定点は全部と戦う bot の 0.7〜0.8 倍で、「戦う方が得」に寄っている。
- 調整した値: `haul.killPerXp` 6 → 4（全部と戦う bot の割合が 44.7% だったため）。ほかは設計の初期値。

### 17.6 V3-2R3a（IMPROVEMENTS_V3 §22）: 再開の規則と射撃する敵
`engineVersion` は 0.6.0（再開の規則が変わった）。
- 遠征の参加者ごとに、この遠征を始めた地点を `start[pid].pos` に持つ（キャンプからなら再開する階段、盤面にいればその場）。綱で戻ると `extractPos` はこの地点になる（綱を使った地点ではない）。最初の遠征で綱を使えば地下 1 階の入口。
- 遠征の開始時に、キャンプから再開する階を落ち着かせる（`settleFloor`。参加者が盤面に戻る前）: その階の敵は追跡をやめて「気づいていない」に戻り（眠っている者はそのまま）、体力が全快する。再開するマスが見える敵（視界の半径と視線）は、再開するマスから `teleport.minDistance` 以上離れ、そこから見えないマスへ動かす（無ければ最も遠いマス）。乱数は `expedition|通番|settle`。どの帰り方（帰還・撤退・綱）の後も同じ。
- 文: extract に「次の遠征はこの階段から始まる。階の敵は追跡をやめて全快する」、綱に「次の遠征はこの遠征を始めた階段から」。
- 射撃する敵（`ranged`）: valid_actions で `fight` の待ち受けを勧めず、「travel_to <id>（近づく（寄られると下がり、下がる間は撃たない）／視線を切る）」を出す。`get_rules` の特徴の説明にも書く。
- 測り直し（枠ごとに 40 ラン、ほかは 20 ラン）: 堅実 55.1%・標準 35.6%・野心 30.3%（死亡 19・25・24、綱 9・6・4、撤退 18・17・11）。全部と戦う bot の点の割合 44.2%・直行 31.7%（差 12.5）、1 呼び出しあたりの比 1.12、最初の遠征の呼び出し 59、5 歩未満の移動マクロ 20.6%。bot は HP 30% 未満で 1 手で倒されうると、階段を知っていれば先に flee で退き（綱の前に）、退いた先でも危なければ綱を使う。§22.3 に従い、ここで bot に合わせた調整は止めた。この bot の方針（綱の前に階段へ退く）は §17.7 で取り消し、この数字は基準として使わない。

### 17.7 V3-2R3b（IMPROVEMENTS_V3 §23）: 守護者の持ち場と、階段へ退く見込み
`engineVersion` は 0.7.0（守護者の動きが変わった）。
- 守護者は置かれたマスを持ち場（エンティティの `home`。守護者付きの遺物では遺物の隣）として持つ。気づいていない間は持ち場から `balance.guardian.leash`（3）マス以内だけを動き、外にいれば持ち場へ向かう。追跡は他の敵と同じで、持ち場を理由にやめない。見失った直後の捜索（最後に見た位置へ向かう）も今までどおりで、捜索を終えて「気づいていない」に戻ると持ち場へ戻る。射撃して距離を取る型も同じ。
- 遠征の開始時に階を落ち着かせる（§17.6）とき、守護者は離れた場所ではなく持ち場へ戻す（ふさがっていれば範囲の中の近い空きマス）。
- 気配（`sense`）は今の位置を指す。持ち場はプレイヤーに渡さない。
- 階段への移動の候補（valid_actions）: 追跡中の敵が届くとき「階段まで N 歩。追われたままなら最悪 M の被害（HP h）」。M = N × 追跡中の敵の `worst_turn` の合計（§17.3 と同じ式。記録の無い敵がいれば「不明」）。一番近い階段でも M が HP 以上で帰還の綱を持っていれば、綱の候補を階段より前に並べる（記録の無い敵がいるときは記録のある分の M で判断）。`escape` の警告の `data` にも `worst_if_chased` と `hp` を載せ、人間の画面の「階段へ退く」ボタンに同じ見込みを出す。
- bot は「HP 30% 未満で 1 手で倒されうるとき、階段の上なら extract、そうでなければ綱」に戻した。
- 測り直し（枠ごとに 40 ラン、ほかは 20 ラン）: 堅実 57.1%・標準 35.4%・野心 20%（死亡 4・9・7、綱 44・50・52、撤退 1・1・6）。3 枠とも目安外で、失敗の大半は目標階を横切る途中の綱。種類ごとの差 17・10・24 ポイント。全部と戦う bot の点の割合 40%・直行 25%（差 15）、1 呼び出しあたりの比 0.81、キャンプでの推奨との差 100%、5 歩未満の移動マクロ 18%、最初の遠征の呼び出し 57、踏破 1 階目の「綱か死」27.3%（試み 11 回）。§23.1 に従い、bot に合わせた調整はここで止めて V3-4 へ進む。

## 18. ビルド V3-4（IMPROVEMENTS_V3 §4・§14.5）

設計は [IMPROVEMENTS_V3.md](IMPROVEMENTS_V3.md) §4（§11 の完了の定義、§10 の「特技」「投擲と近接」）と §14.5 の装備の痛み、実装メモは同書 §24。成長・戦闘・生成が変わったので `engineVersion` は 0.8.0、新しいイベントがあるので `eventVersion` は 3。

### 18.1 特技（§4.1）
- レベルごとの固定成長は最大 HP だけ（戦士 +6・斥候 +4）。命中・威力・回避の自動成長（`accEvery` など）は廃止した。
- レベルが上がるたびに特技を 1 つ選ぶ。候補は 3 つ（`balance.perks.options`）で、共通の表と職業の 2 系統（戦士: 前衛・不屈、斥候: 射手・影）から、状態を持たないハッシュ（`seed|perk|プレイヤー|レベル`）で引く。取った特技（段階の上限）と前提を満たさないものは除く。引いた候補は `perk_offered` の after 値として World に入る（観測はシードを使えないため）。
- 選ぶのは手番を消費しないコマンド `choose_perk { option }`。自分の手番でなくても、キャンプでも選べ、選ぶまで進行は止まらない。保留が重なれば古い順に選び、後の候補は前を選んだ後に引く（同じ特技が 2 度出ないように）。
- 特技はデータ（`perks.json`）: 能力値の修正（`mods`。取った時点で基本値に入る）、能動技の習得（`ability`）、条件付きの効果（`hooks`。エンジンが名前で読む: `brace`・`last_stand`・`poison_resist`・`intimidate`・`throw_cost`・`collect_adjacent`・`ambush`）。
- 共通: 頑健（最大 HP +5）・精密（命中 +1）・剛力（威力 +1）・身軽（回避 +1）は 3 段まで、荷運び（所持枠 +4）は 1 段。各職業は Lv1 から能動技の特技を 1 つ持つ（戦士: 強打、斥候: 狙い撃ち）。

### 18.2 能動技（§4.2）
- `ability { id, target?, slot? }`（MCP `use_ability`）。資源は無く、再使用までの手番（`cooldown`）だけで管理する。使った手番に `readyAt = 手番数 + 1 + cooldown` を記録し、観測の `cooldown_left = readyAt − 手番数`。立て直しだけは遠征ごとに 1 回。
- 強打（隣の敵に近接、当たれば 1 手番の朦朧。8）・なぎ払い（隣の敵すべてに近接。6）・立て直し（最大 HP の 25% を回復。遠征に 1 回）・狙い撃ち（投擲、命中 +4、気づいていない・眠っている相手には会心。5）・身をかわす（その方向へ 2 マスまで動き、次の自分の手番まで近接が当たらない。10）。
- 状態異常を足した: 朦朧（`incapacitate`）・身かわし（`evade`）・構え（`brace`）・怯え（`cowed`）。
- **能動技は fight に載せられる**（V3-4a。IMPROVEMENTS_V3 §25.3）: `fight { abilities: [...] }` は、並べた能動技を使える手番ごとに使う（強打は標的が隣、なぎ払いは起きている敵が隣に 2 体以上、狙い撃ちは `with` の品で射程と射線が通るとき。それ以外の手番は通常の攻撃）。立て直し・身をかわすは、いつ使うかが判断そのものなので載せられない。能動技を使うたびに呼び出しが割れて「使わない方が得」にならないようにするため。特技の選択は他の行動の引数に添えない（呼び出しを使う価値のある判断）。

### 18.3 習熟・武器の特性・重い鎧（§4.3・§4.4・§14.5）
- 習熟（`classes.proficiency`）: 戦士は投擲 −2、斥候は投擲 +2（近接は 0）。装備の「近接の命中」「投擲の命中」と合わせて命中に足す。
- 武器の特性（`weaponTraits.json` とレジストリ）: 速い（短剣。近接の手番コスト 70）、長柄（槍、新規。直線で 2 マス先を `attack` で突ける。間のマスが通れて誰もいないこと）、薙ぐ（戦斧。対象と自分の両方に隣接する敵 1 体にも当たる。別に命中を判定）、砕く（鎚矛。当たれば 20% で 1 手番の朦朧）、扱いやすい（小剣。特別な効果なし）。
- 近接攻撃のコマンド `attack { target }` を足した（隣の敵か、長柄なら 2 マス先）。`fight` も長柄なら 2 マス先から突く。
- 重い鎧: 鱗鎧は歩く手番のコスト 110・眠っている敵が起きる確率 +3%、板金鎧は 125・+6%。

### 18.4 装飾品と呪い（§4.4）
- 装飾品 6 種（指輪 3・護符 3）。すべて未鑑定で、装備すると正体が分かる。効果は得失の組（見張りの指輪: 視界 +1・回避 −1／静寂の指輪: 起こしにくさ +30・自分の音で眠りが必ず覚める／狩人の指輪: 投擲の命中 +3・近接の命中 −2／狂戦の護符: 威力 +2・装甲 −1／鉄の護符: 装甲 +2・回避 −2／命の護符: 最大 HP +8・威力 −1）。
- 呪い: 武器・防具・装飾品は生成時に `balance.curse.chancePct`（6%）で呪われる。呪いの接辞（命を削る: 最大 HP −6／足をもつれさせる: 回避 −2／目を曇らせる: 視界 −2）は見えない接辞（`item.hidden`）に入り、呪われた品は必ず良い接辞も持つ。装備するか鑑定すると見える接辞へ移る（`curse_revealed`）。呪われていなければ「確かめた」（`item.inspected`）だけが付く。呪いの効果は見えなくても効く。
- 呪われた装備は外せない（同じ場所に別の品も付けられない・捨てられない）。解呪の巻物（新規）と祭壇（全鑑定に加えて）が、所持品すべての呪いの接辞を消す。初期装備は確かめ済み。鑑定の巻物の対象は「未鑑定の種類」か「呪いの有無を確かめていない装備品」。
- `item.hidden` はプレイヤーに渡さない（PlayerView・観測・イベントのどこにも出ない。漏洩テストに足した）。観測は確かめていない装備品に `curse: 'unknown'`（「呪い?」）を付ける。

### 18.5 計測（§10。`npm run builds`・`npm run budget`）
- 特技の系統ごとの到達深度（`npm run builds -- --runs 20`。その系統を取り続ける貪欲 bot、同じシード）: 射手 平均 7.1・影 7.7（斥候）、前衛 10.5・不屈 10.7（戦士）。**目安は「同じ職業の中で、系統の最良 ÷ 最悪が 1.3 倍以内」**（IMPROVEMENTS_V3 §25.1）で、1.08 倍・1.02 倍で満たす。全系統の最良 ÷ 最悪（1.51）は職業の差で、bot の数字では直さない（AI 評価の問い 7 で判定）。
- 撃破に占める投擲の割合: 戦士 12.3%（目安 30% 以下: 満たす）、斥候 30.8%（目安 40% 以上は AI 評価の斥候の記録で判定する。§25.2）。投げナイフのダメージを 1d4+1 → 1d6+1 にし、bot は投擲の習熟が正の職業なら 2 マス先から投げるようにした（前は 21.7%）。
- 呼び出しの予算と枠（`npm run budget -- --runs 20`）: 枠の達成率は堅実 70.5%・標準 44.3%・野心 41.3%。深度ごとのレベルと推奨の差は深度 8 だけ +2（ほかは ±1）。最初の遠征の呼び出しは 68（目安 60 以下。特技を選ぶ呼び出しと強打の分が増えた）。5 歩未満で止まった移動マクロは 27%（目安 20% 以下）。全部と戦う bot と直行 bot の比較は、全部と戦う bot の呼び出しが減った（explore の往復を直したため）ことで、1 呼び出しあたりの比 0.51・点の割合の差 7.7 ポイントになり、どちらも目安を外れた。

### 18.6 AI 評価で見つかった不具合の修正（IMPROVEMENTS_V3 §27.2）
- `explore { toward: 'draft' }`: 決めた行き先は境界である間は追い続ける（風の方角は歩くたびに変わるので、方角の絞り込みでは外さない）。行き先が見えて境界でなくなったら、そのすぐ近く（3 マス以内）の境界を続けて追う（通路の先へ下がっていく境界を追う）。どちらも無いときだけ、今の方角で選び直す。
- steady・flee の移動マクロは、ほかに道が無いときだけ、逃走中の敵のマスを通れるものとして経路を引く（ふさいでいれば攻撃して進む。§17.4 の規則が 1 マス幅の通路でも効くように）。
- 移動マクロは発見済みの罠を踏まない: 罠を通る道しか無く、次のマスが罠なら止まる（`trap_ahead`。始める前なら手番を使わずに `blocked` で、ヒントに罠の方角 `move { dir }`）。踏むなら `move`。explore は、追い続ける行き先への道が罠を通るようになったら選び直す。
- 動かない敵の隣を避ける規則（§16）は、その呼び出しの間に一度見た動かない敵にも効く（見えなくなっても避け続ける。見えているマスにもういなければ忘れる）。
- `explore { toward: 'draft' }` は、風の方角の境界へ敵にふさがれた道か罠を通る道しか無ければ、ほかの行ける境界へ回る。
- 階段を見つけて止まる（`stairs_seen`）前に、足元の拾える品を 1 つ拾う（1 手番）。
- `new_run`・`resume_run` の応答は、キャンプの候補をブリーフィングに重ねない（観測の文に入る）。
- 未鑑定の指輪・首飾りにも `equip` を出す（外見の種類から装備の枠を引く）。
- 所持品の詳細は、接辞込みの性能（武器の特性は名前）とデータの説明だけ（素の性能の列は重ねない。カタログの `note`）。
- 「目標の階を踏破した」は到達の遠征だけ。遺物の遠征のブリーフィングは、守護者の有無を必ず出す。
- 文言: ルールの状態異常の一覧に、綱が即時なら「帰還中」を出さない。綱の候補は「（達成した遠征には数えない）」。自分が投げた物のまとめ行は「合計 N（最寄りのマスに M）」（`near_qty`）。直前の出来事の同じ文の繰り返しは「×N」。剛力・精密・盾の構え・回復の薬・活力の薬・鑑定の発見点の説明を、実際の効き方に合わせた。

## 19. 見直し 4 V3-4b（IMPROVEMENTS_V3 §28.1〜§28.8・§28.11）

設計は [IMPROVEMENTS_V3.md](IMPROVEMENTS_V3.md) §28、実装メモは同書 §29。点の式と休憩の規則が変わったので `engineVersion` は 0.9.0、新しいイベントがあるので `eventVersion` は 4。

### 19.1 綱と守護者（§28.1・§28.2）
- 帰還の綱で確定するのは、目的を除いた戦利品（踏破・宝・賞金・発見・撃破）× `lifeline.pct`。目的を達成済みでも同じで、目的の点は階段の上の extract でだけ確定する（`payoutOf`）。
- 綱で戻るとき持っていた遺物は失う（World から消す。`player_state.relicLost`）。倒した守護者は倒れたまま。
- 次の候補の基準（`campDepthOf`）は、階段の上で達成して帰った遠征だけで上がる（綱では上がらない）。
- 戦利品の行の「綱なら +Y」は新しい式で、遺物を持っていれば「（遺物は失う）」を添える。
- 守護者の候補の種族は、格で表の深さを変える（`balance.guardian.ranks[].tableDepth`: 格 1 は 0 で下位半分、格 2 は +1、格 3 は +2 の上位半分）。体力の上乗せと下限は今のまま。

### 19.2 休憩の上限（§28.3）
- 休憩（rest・休息の wait）と自然回復は、最大 HP の `rest.capPct`（75）% まで（`restCapHp`）。それより上は回復の薬・立て直し・泉・レベルアップ・キャンプでだけ戻る。
- rest は上限に着くと `rest_cap` で止まる（上限にいれば手番を使わずに断る）。`rest_estimate` は上限（`cap_hp`）までの見積もり。valid_actions の rest は「休憩（HP 75% の N まで）」、上限にいれば「不可: これ以上は休憩では戻らない」。

### 19.3 fight の続け方（§28.4）
- `until: 'clear'`: 標的を倒したら、隣にいる追跡中の敵（逃走中を除く。動かない敵は隣にいるときだけ）、いなければ最も近い追跡中の敵へ続け、届く追跡中の敵がいなくなれば `cleared` で終わる。標的が見えなくなったときも、届く追跡中の別の敵がいればそちらへ移る。結果の文に「倒した: N 体（名前）」。
- 新しく見えた追跡中の敵で止まるのは、被弾の記録の無い種族だけ（既定の標的 1 体でも同じ）。記録の無い種族は、出現の後の初めての被弾（`first_hit`）の対象にも入れる。
- `adjacent`（with のとき）: `stop`（既定。今までどおり）／`throw`（隣でも投げ続ける）／`melee`（隣に来たら近接に切り替える。載せた強打・なぎ払いも使う）。
- 見失ったとき: 最後に見たときに逃走中だった標的は `target_fled` で止まる。追跡中で逃げていなかった標的は `fight.lostWait`（5）手番まで待ち、それでも現れなければ `target_gone`。
- 始める時点で標的が見えないとき（PlayerPort）: 直前の応答の控え（`TurnSnapshot.hostileFleeing`）で逃走中だったなら、手番を使わずに「逃げて見えなくなった（最後に見た位置）」で断る。逃げていなかったなら `lostOk` を付けて待つ。
- 待つ手番に、標的以外の射撃（`via: ranged / thrown`）で被弾したら `shot_while_waiting` で止まる。
- valid_actions: 追跡中の敵が 2 体以上なら「fight <id> until:clear（追跡中の N 体と決着まで）」を足す。

### 19.4 階段へ退く見込み（§28.5）
- 敵ごとに「歩く間に攻撃できる回数 × 受けた最大の一撃」の合計（`chaseEstimate`）。回数は、射撃する敵が歩数、近接の敵が `切り上げ(歩数 × max(0, 敵の速さ × 歩く手番のコスト − 自分の速さ × 100) ÷ (自分の速さ × 100))`、今隣にいれば +1（`chaseAttacks`。整数で計算する）。歩く手番のコストは装備中の重い鎧の最大。
- 文は「階段まで N 歩。追われたままなら最悪 M の被害（追いつけるのは X 体・射撃 Y 体。HP h）」。綱を先に並べる判定は、記録のある敵だけの M（下限）で行う。`escape` の `worst_if_chased` も同じ式。

### 19.5 投擲と、効いた特技の知らせ（§28.6）
- 投げナイフのダメージは 1d4+1。床の投擲用の品は、山の数が `balance.loot.throwStackMin〜Max`（1〜4。前は 2〜6）、通常の宝の表の重みが 6（前は 12）。
- 条件付きの特技が効いたら `perk_triggered { actor, perk, effect, subject?, subjectKind?, amount? }`（本人だけ）を出し、変化（`turn.changes` の `perk`）に 1 行ずつ出す（同じ文は ×N）。effect: `not_woken`（忍び足。特技が無ければ起きていた目のとき。引く乱数は 1 回のまま）・`crit`（不意打ち）・`picked`（回収の手。隣のマスから拾った数）・`braced`（盾の構え）・`might`（踏みとどまる）・`poison_halved`（鉄の胃）・`cowed`（威圧）。相手が見えていなければ種族を伏せる。

### 19.6 explore と拾う物（§28.7）
- `explore { toward: 'sense' }`: 遺物・守護者の気配の方角（と隣り合う方角）の境界を優先する（`draft` と同じ仕組み。行き先を保つ規則・風の方角の境界へ行けないときほかの境界へ回る規則も同じ）。
- 拾う物の既定は `pickup: 'useful'`（explore）。`true` は今までどおり、`false` は拾わない。`useful` は、鑑定済みで接辞の無い武器・防具のうち、公開の数字が装備中の品以下のもの（防具は装甲、武器はダメージのダイスの平均。装備中の品は接辞込み。種類が違っても比べる）を拾わない（`worseEquip`）。valid_actions の equip も同じ基準で省く。collect の items も同じ。
- 敵が隣にいて explore が断られたとき（`hostile_adjacent`）のヒントは「mode: steady なら追跡中でない隣の敵を気にせず進める。mode: flee なら追跡中の敵が隣にいても進める」。

### 19.7 情報（§28.8）
- 【遠征】の見出しは、前の応答と同じ（`TurnSnapshot.expHead`）で長い形を出す応答でなければ、「【遠征N】この場で extract できる／extract は階段の上で」と戦利品の行だけにする。
- 眠っている敵と 8 マスより遠い敵の行は、命中と通りの記録・射線を省く（名前・位置・状態・脅威・体力の目安は出す）。
- 敵が目を覚ました・気づいた理由: `monster_woke { id, kind, reason: noise / sight / pack, by, ring, wasAsleep }`（その敵が見えている者だけ）を出し、変化（`woke`）に 1 行ずつ出す。自分の立てた音で起きたときは「あなたの立てた音で」、静寂の指輪の欠点（必ず起きる）が効いたときは指輪の名前を添える。遺物を拾って階が目覚めたときは、今までどおりの 1 行（個体ごとには出さない）。
- 接辞付きの個体は、種族の体力の記録（`hpSeen`）に混ぜない（守護者は守護者の記録）。
- 撃破の点の式は get_rules に書いてある（経験値 × `killPerXp` × 深さの係数、接辞付きは `killAffixPct` %）。

### 19.8 Muse の実プレイで出た不具合（§28.11）
- 聖域の階の explore の往復（Muse の 5 回）: §18.6 の修正で直っている（その盤面からいまのコードで動かし直すと、31〜130 手で下り階段を見つけて止まる）。
- collect の items は遺物を拾わない（拾うと階が目覚めるので）。知っている遺物が床にあれば、結果に「遺物は数えていない。拾うなら travel_to <id>」と添える。valid_actions の collect what:items に「遺物は除く」。
- 推定残り HP: 見えている範囲で与ダメ 0・無傷の帯なら、記録の範囲（最大 HP そのもの）を出す（「無傷の帯の下限」まで広げない）。
- とどめの文は、与えるはずだった値（会心の値）を出し、残り HP を添える（「12 ダメージを与えた（とどめ。残りは 3 だった）」）。
- 射線の非対称: 3 本のラン（Muse と評価者 2 体）の、敵の射撃 60 回すべてで、撃った敵は直前の観測の「射線が通る」側に入っていた。再現しなかったので変えていない。

## 20. 守護者の型 V3-3 の 1 段目（IMPROVEMENTS_V3 §3.1・§28.9）

設計は [IMPROVEMENTS_V3.md](IMPROVEMENTS_V3.md) §3・§28.9、実装メモは同書 §30。§28.9 の順（型と予備動作 → 遺物と加護 → 節目の大守護者 → 物語の文）の 1 段目。守護者の振る舞いが変わったので `engineVersion` は 0.10.0、新しいイベントがあるので `eventVersion` は 5。遺物と加護（§3.3）・節目（§3.2）・物語（§3.4）はまだ入っていない。

### 20.1 型・弱点・名前（データとレジストリ）
- 型は `guardianTypes.json`（称号・説明・`strongVs`（melee／thrown）・`handler`・`params`）、弱点は `guardianWeaknesses.json`（名前・説明・`handler`・`params`）、名前の音節は `guardianNames.json`。振る舞いは engine のレジストリ `guardianTypeHandlers`・`weaknessHandlers`（`guardians.ts`。登録は `guardianBehaviors.ts`）。読み込み時に、データの handler が登録されているかを検査する（`validateContentHandlers`）。
- 型（6 つ。近接に強い 3・投擲に強い 3）:
  - 呼び集める者 `summoner`（近接に強い）: HP が 75%・50%・25% を切るたびに、1 手の予兆（`summoning`）の後、その階の種族から手下を 2 体呼ぶ（隣の空いたマス。動かない種族は除く。呼ばれた手下は追跡中）。
  - 護られし者 `warded`（近接に強い）: 階に灯った護りの火（`core:ward_fire`）が 1 基でもある間、装甲 +4。火は隣で `interact` するか、投げた物が落ちると消える。
  - 荒ぶる者 `enrager`（近接に強い）: HP 50% 以下で、1 手の予兆（`enraging`）の後に速さ +30・威力 +2（戻らない）。
  - 突き進む者 `charger`（投擲に強い）: 2〜6 マスの直線上（縦・横・斜め。間に障害物と敵が無い）に相手がいると 1 手構える（`winding_up`、向き付き）。次の手番にその直線を最大 6 マス突進し、当たれば 2 倍ダメージ。外れると 1 手気絶する。
  - 潜む者 `stalker`（投擲に強い）: 眠らない。見られている間は近づかず、相手の視界の外のマスへ下がる（4 手番まで。それ以上見張られ続けたら、見えたまま寄る）。見えないマスを伝って寄り、視界の外から隣に着いた次の一撃は会心。襲った後は退いて隠れ直す。一度気づいた相手は、見失っても 12 マス以内なら居場所を追い続ける（`params.sense`）。
  - 弾く者 `deflector`（投擲に強い。§28.9 で足した）: 2 マス以上離れた相手からの投擲のダメージを半分にする（隣からは通常）。
- 弱点（4 つ。型と独立に 1 つ）: 毒に弱い（毒のダメージ 2 倍）・投擲に弱い（投擲のダメージ 2 倍）・眠りが深い（必ず眠って置かれ、気づかれる前の一撃が必ず会心）・水場で遅い（浅い水の上では行動のコストが 2 倍）。
- 格と型の数: `balance.guardian.ranks[].types`（格 1 は 0、格 2・格 3 は 1）。2 つ以上なら、近接に強い組と投擲に強い組から交互に引く（最初の組は半々）。
- 名前・型・弱点は、候補を作る時点で `Rng.fromSeed(seed|expedition|通番|guardian|枠)` から決める（`rollGuardianInfo`。状態を持たない）。名前は音節表から 2〜3 音節。表示名は「称号＋名前」（「呼び集める者ヴォルン」・"Volun the Summoner"）。
- 候補（`Offer.guardian`）に名前・称号・型、World の `Offer.guardianWeakness` に弱点（射影で消す）。遠征（`Expedition.guardianName / guardianTitle / guardianTypes / guardianWeakness`）に写し、守護者の実体（`Entity.guardian: GuardianInfo`）に置く。生成済みの目標階に置くときも同じ情報を使う。

### 20.2 予備動作（intent）
- 次の手番に大きな行動を取る敵は `AiState.intent { kind: 'winding_up' | 'summoning' | 'enraging', dir? }` を持つ（`ai_state_changed` の after 値）。見えている敵だけ `EntityView.intent` に射影する。仕組みは守護者に限らない。
- 観測: `visible.monsters[].intent { code, dir?, on_line?, text }`（`on_line`: 突進の直線（6 マス）の上に自分がいる）、alerts の `intent`。敵の行に「予備動作: …」。
- マクロ: 見えている敵が新しく予備動作を見せたら、どのマクロも `intent` で止まる（始める前から見えていた予備動作では止まらない）。
- 守護者のしたこと（呼んだ・突進した・外した・怒った）は `guardian_acted`（見えている者だけ）で、`turn.changes` の `guardian` に 1 行。

### 20.3 弱点を知る
- 弱点が効いた場面（投擲・毒のダメージが増えた、眠りで会心になった、水場で遅くなった）で、その守護者が見えている者のうちまだ知らない者に `guardian_intel { player, guardian, guardianName, weakness }`（本人だけ）。`knowledge.guardianIntel[守護者 id]` に入り、`EntityView.guardian.weakness`・観測の敵の行と `guardian.weakness`・look・遠征（`ExpeditionView.guardian.weakness`、観測の `expedition.guardian` と、守護者が生きている間の【遠征】の行「守護者「名」（弱点: 不明／…）」）に出る。`turn.changes` の `intel` に 1 行。
- 知るまでは、射影・観測・look のどこにも出ない（look は「弱点: 不明（試して確かめる）」）。漏れの試験（`v33.test.ts`）で 4 つとも確かめる。碑文（§5.1）からの手がかりは V3-5。
- 公開カタログには型と弱点の一覧（`guardianTypes`・`guardianWeaknesses`）だけを出し、get_rules topic=classes（と all）に一覧を足した。どの守護者がどの弱点かは出さない。

### 20.4 棲み処
- 目標階の生成（`placeLair`、`objective` ストリーム）で、守護者のまわり（2〜4 マスの輪の空いた床）に、型と弱点に合う地物と地形を置く（`lairPlan`）: 護られし者は護りの火 2 基、突き進む者は柱 3 本（四方が床のマスだけ。通路をふさがない）、水場で遅い弱点は浅い水 6 マス。
- 眠りが深い弱点の守護者は必ず眠って置かれる。潜む者は眠らない（`guardianAsleep`）。

### 20.5 体力の記録の文（§28 への設計の指示。節は立てない）
- 記録が `HP_RECORD_SURE`（5）体未満の間は、記録の文に「個体差あり」を添え（「体力 4〜6（3 体。個体差あり）」）、推定残り HP の上限を出さない（「記録どおりなら残り 3 以上」）。推定残り HP の文は常に「記録どおりなら」で始める。

### 20.6 bot とクライアント
- 貪欲 bot: 突進の構えの直線の上にいれば、直線から外れる一歩を打つ（前後には動かない）。護られし者が見えていて、隣に灯った護りの火があれば消す。
- クライアントの敵の欄: 守護者の「名前」・型・弱点（不明）と、予備動作の行（直線の上にいれば強調）。

### 20.7 計測（`v33.test.ts` の対戦。型ごとに、型を読まない方針と読む方針、24 シード）
| 型 | 読まない | 読む | 読む方針 |
|---|---|---|---|
| 突き進む者 | 16 勝 | 24 勝 | 構えを見たら直線から外れる |
| 護られし者 | 21 勝 | 24 勝 | 隣の護りの火を先に消す |
| 呼び集める者 | 17 勝 | 24 勝 | 開けた部屋で本体だけを殴る（読まない）／通路に陣取り、隣に来た手下から片付ける（読む） |
| 荒ぶる者 | 11 勝 | 19 勝 | 危なくなってから回復（読まない）／半分まで削る前に回復しておき、怒った後は早めに回復（読む） |
| 潜む者 | 6 勝 | 18 勝 | 壁の角の脇に立つ（読まない）／正面からしか来られない通路に陣取る（読む） |
| 弾く者 | 15 勝 | 21 勝 | 離れて投げ続ける（読まない）／寄って隣で投げる（読む） |

bot の計測（`bot --runs 10`・`npm run budget -- --runs 20`）は IMPROVEMENTS_V3 §30。型の付いた守護者で、枠の達成率は V3-4b の後（§29）と同じくらい（堅実 68%・標準 26.7%・野心 33.9%）。

## 21. 遺物と加護 V3-3 の 2 段目（IMPROVEMENTS_V3 §3.3・§28.9）

設計は IMPROVEMENTS_V3 §3.3・§28.9、実装メモは同書 §31。遺物の種類と加護が入り、新しいイベントがあるので `engineVersion` は 0.11.0、`eventVersion` は 6。

### 21.1 データ
- 加護は `boons.json`（名前・説明・`mods`（最大 HP・命中・回避・威力・装甲・視界）・`hooks`）。遺物は `items.json` の `category: relic` の品で、`boon` に加護の ID を持つ（説明は由来の 1 文）。加護を遺物と別の表にしたのは、3 段目の大守護者が加護を選ばせる（§3.2）ため。
- 遺物 7 つ: 息吹の欠片（息吹: 自然回復の間隔 −2）・狩人の欠片（狩人: 当たった投げ物が 50% で手元に戻る）・灯の欠片（灯: 視界 +1）・鎮めの欠片（鎮め: 眠っている敵が起きる確率が半分）・鋼の欠片（鋼: 装甲 +1）・俊足の欠片（俊足: 階段を使った直後の 10 手番、加速）・執念の欠片（執念: 致死のダメージを 1 遠征に 1 回、HP 1 で耐える）。§3.3 の「目利きの欠片」は、手がかり（§5.4）が V3-5 なので、そのときに足す。
- 古い遺物 `core:relic`（加護なし）は、遺物の種類を持たない遠征の予備として残す。

### 21.2 候補と配置
- retrieve_relic の候補は、作る時点で遺物を決める（`pickRelic`: `Rng.fromSeed(seed|expedition|通番|relic|枠)`。状態を持たない）。参加者（盤面とキャンプにいる者）がまだ持っていない加護の遺物から引き、すべて持っていれば全体から引いて `owned` を付ける（持ち帰っても新しい加護は付かない）。
- 候補（`Offer.relic: RelicInfo { kind, name, boon, boonName, boonDesc, owned? }`）・遠征（`Expedition.relic`）・ExpeditionView に名前と加護を出す（公開）。候補の文は「遺物「息吹の欠片」→ 加護「息吹」: 自然回復の間隔 −2」、ブリーフィングに「階段の上で持ち帰ると加護になり、ランの終わりまで残る（綱では持ち帰れない）。拾うと階の眠っている敵がすべて起きる」。
- 目標階に置く遺物はその種類（生成時の `ObjectiveSpec.relicKind`・生成済みの階に置くときも同じ）。足元の遺物の valid_actions は「pickup（遺物を拾うと階が目覚める: …）」。

### 21.3 加護が付く・残る
- 達成して階段の上で extract したとき（`doExtract` で completed かつ綱でない）、持っている遺物ごとに加護を付ける（`grantBoon`）。遺物を持っている本人に付く（COOP で他の参加者には付かない）。綱で戻ると遺物は失われ、加護も付かない（V3-4b §28.1 のまま）。
- 加護は `Entity.boons`（ランの終わりまで残る）。`mods` は取ったときに素の能力値（`base`）へ足し、能力値を作り直す（特技と同じ）。同じ加護は二重に付かない。
- `boon_granted { target, boon, source }`（本人だけ。source は遺物の種類）。文は「息吹の欠片を納め、加護「息吹」を得た（自然回復の間隔 −2）。」で、`turn.changes` の `boon`。

### 21.4 効き目（hooks）
- 息吹 `regen { interval }`: 自然回復の間隔に足す。下限（`regen.minInterval`、3）は 1 だけ下がる（最短 2 手番に 1 回）。engine と観測の休憩の見積もりは同じ式（`regenInterval(rules, level, boonHookSum(...))`）。
- 狩人 `throw_return { pct }`: 投げた物が当たったとき（割れる物を除く）pct % で手元に戻る。持っている同じ山に足すか、空いていれば元のスロットへ。`boon_triggered { effect: 'returned' }`。
- 鎮め `soothe { pct }`: 視界の中の眠っている敵が起きる確率（手番ごとの判定）に pct % を掛ける（最小 1）。自分の立てた音で眠っている敵が起きる確率も 50% → 25%。引く乱数の回数は変えない。
- 俊足 `stairs_haste { turns }`: 階段を使った直後に加速（`core:haste`）を turns 手番。`boon_triggered { effect: 'haste' }`。
- 執念 `last_stand`: プレイヤーが致死のダメージを受けたとき、その遠征でまだ使っていなければ HP 1 で残る。使った遠征の通番を `Entity.boonUsed[加護]` に記録する。`boon_triggered { effect: 'last_stand' }`。
- 灯・鋼は `mods` だけ（視界 +1・装甲 +1）。

### 21.5 観測と文
- `self.boons: { id, name, desc, used? }[]`（used: 遠征に 1 回の加護をこの遠征で使った）。盤面の文に「加護: …」（持っているときだけ）、キャンプの文に「加護: …／なし（遺物を階段の上で持ち帰ると付く）」。
- 候補の `camp.offers[].relic { kind, name, boon, boon_name, boon_desc, owned? }`。get_rules topic=classes に加護の一覧（遺物の名前付き）。
- クライアントの自分の欄に加護（使った執念は「使用済み」）。

## 22. 節目の大守護者 V3-3 の 3 段目（IMPROVEMENTS_V3 §3.2・§28.9）

設計は IMPROVEMENTS_V3 §3.2・§28.9、実装メモは同書 §32。生成と下り階段の規則が変わり、新しいイベントとコマンドがあるので `engineVersion` は 0.12.0、`eventVersion` は 7。

### 22.1 大守護者の間（階）
- 深度 5 の倍数は floorType `core:warden_hall`（`every: 5`、`priority: 10`。強制の階が重なったら priority の大きい方: 深度 30 は聖域より大守護者の間）。`rules.warden: true`・`noWander: true`。ほかの敵・アイテム・罠・プレハブは置かない。
- レイアウト `core:warden_hall`（36×17）: 左に前室（上り階段）、扉のある短い通路、右に広間（中央に大守護者、奥に下り階段）。前室から下り階段へは広間を通るしかない。階段と大守護者の場所はレイアウトの目印（`GenGrid.anchors`）で決め、目印のマスがバイオームの地形で通れなければ近い床へずらす。
- 深度 5・10・15・30 の 30 シードで、大守護者は 1 体・型 2 つ、入口から下り階段と大守護者へ歩いて届くことを確かめる（`v33warden.test.ts`）。

### 22.2 大守護者
- 名前・型・弱点は `rollWardenInfo`（`Rng.fromSeed(seed|warden|深さ)`。状態を持たない）。型は `balance.guardian.warden.types`（2）で、近接に強い組と投擲に強い組から 1 つずつ。`GuardianInfo.warden: true`。
- 種族は格 3 の表（2 つ深い階の候補の上位半分）。体力は `warden.hpPct`（+250%）・下限 `minHpBase + minHpPerDepth × 深さ`（20 + 6×深さ）、賞金は守護者の賞金 × `bountyPct`（300%）。棲み処（§20.4）は型と弱点に合わせて置く。
- 観測の敵の行は「[大守護者・賞金 N]」、`visible.monsters[].guardian.warden`。弱点は守護者と同じく、効くまで出ない。

### 22.3 封じられた下り階段
- 節目の深さで、その大守護者を倒した記録が無い間、下り階段の `stairs` は手番を使わずに `sealed` で断る（V4-0a で「その階に生きている大守護者がいる間」から改めた。判定は表示と同じ shared の `stairsSealed`。§36.1）（「下り階段は封じられている。この階の大守護者を倒すまで降りられない」）。valid_actions の use_stairs は「不可: …」。
- 封じられた下り階段に立っても、到達（reach_depth）・踏破にならない。extract（帰還・撤退）は今までどおりできる。

### 22.4 倒したとき
- `warden_slain { depth, id, guardianName, by }`（全員）。World の `milestones.cleared` に深さが入る。文は「節目の大守護者…が倒れた（地下5階）。下り階段の封印が解けた。」
- その階にいる生きているプレイヤーそれぞれに、加護の候補（持っていない加護から `boonOptions` 個。`Rng.fromSeed(seed|warden|深さ|boon|プレイヤー)`）を `boon_offered`（本人だけ）で出し、`Entity.boonChoice` に置く。
- `choose_boon { option }`（手番を消費しない。MCP ツール `choose_boon`）: 番号か加護の ID で 1 つ選ぶと加護が付く（`boon_granted`、source `warden`）。観測は `self.boon_choice`・alerts の `boon_pending`・valid_actions の `choose_boon N (名前: 説明)`。選ぶまで残る（キャンプでも選べる）。

### 22.5 次の節目
- キャンプの候補を作るとき、まだ倒していない最も浅い節目を `CampState.milestone { depth, name, title?, types }` に入れ、遠征の開始時に `Expedition.milestone` へ写す。観測は `camp.milestone`・`expedition.milestone { depth, name, types, cleared, text }`。キャンプの文と、遠征中の【遠征】の行に「次の節目: 地下5階の大守護者「…」（型: …。未踏破。倒すまでその階の下り階段は封じられている。倒すと加護を 3 つの候補から 1 つ選べる）」。
- 遠征の目標は節目の階にしない（その枠の目標を 1 つ深くし、ずらした枠の次の枠はさらに深くする）。目標が節目より深ければ、その階を通る（下り階段が封じられているので、倒さずには降りられない）。

### 22.6 bot とクライアント
- 貪欲 bot: 大守護者が見えていて HP 60% 以上なら挑む。封じられた下り階段で断られたら、降りるのをやめて探す。加護の候補は最初のものを取る。
- クライアント: 加護の候補の欄（選ぶボタン）、`choose_boon` は手番を使わないコマンドとして送る。

## 23. 物語の文 V3-3 の 4 段目（IMPROVEMENTS_V3 §3.4・§16.2・§28.9）

設計は IMPROVEMENTS_V3 §3.4・§16.2・§28.9、実装メモは同書 §33。新しいイベントがあるので `engineVersion` は 0.13.0、`eventVersion` は 8。これで V3-3 の 4 段がそろった。

- 文面はすべてデータ（`lore.json`。`kind`: `frame`（世界の枠）／`briefing`（遠征の開始の 1 文）／`guardian_slain`・`warden_slain`（倒したとき）／`relic_delivered`（遺物を納めたとき））。`when`（目的・守護者付きか・守護者の型）に合う中で、条件の多いものから `weight` で選ぶ（`pickLore`、`Rng.fromSeed(seed|lore|鍵)`。状態を持たない）。`{depth}` `{guardian}`（称号＋名前）`{relic}` `{origin}` を埋める。伏せている情報（弱点・種族）は埋めない。
- 遠征の開始: 目的・守護者付きか・守護者の型・遺物から 1 文を選び、`Expedition.story` に入れる（ExpeditionView にも）。ブリーフィングの 2 行目（長い形）か、1 行の形の末尾に出す。
- 遠征の守護者・大守護者を倒したとき、遺物を納めたとき: `story { reason, line }`（全員）。`turn.changes` の `story` に 1 行。遺物の文は、遺物の由来（アイテムの `origin`）を添える（「息吹の欠片を記録庫に納めた。記録庫の療院に残っていた、息づかいの記憶。」）。
- 遺物の説明（カタログの `desc`）は、由来の 1 文を前に付ける。
- get_rules の topic=all の先頭に、世界の枠の 1 段落（`catalog.lore.frame`）。
- §16.2 のとおり、固有名詞は守護者と遺物だけ（都・坑には名前を付けない）。物語は判断を指示しない（型の説明と同じ公開の事実だけ）。

### 23.1 V3-3 の後の AI 評価で見つかった不具合の修正（IMPROVEMENTS_V3 §34.2）
- 候補: 到達型は、遠征の記録で下り階段に立った最も深い階（踏破した深さと、達成した到達の目標）以下には出さない。目標が次の節目より深い候補に `passesWarden`（途中で倒す大守護者）を付け、文に「途中の地下N階で大守護者「…」を倒す必要がある」。条件は `excludes` で、矛盾する組み（静か × 騒がしい）を同じ候補に付けない。次の候補の下限（`nextCampOf`）は節目の階を飛ばす。
- 守護者の型の手番に順（`GuardianTypeHandler.order`）: 呼び集める・荒ぶる（0）→ 突進（1）→ 潜む者（2）。先の型が手番を使うと後の型は動かないので、毎手番動く潜む者を最後にする。
- キャンプにいる間に落ち着く階の敵は、全快に加えて状態異常を消し（`status_ticked` の空）、見ていた与ダメの累計も戻す（`healed.resetSeen`）。
- fight の迎え撃ち: 待つ手番に標的に殴られ、標的が隣にいなければ `hit_and_run`。標的が 3 手番続けて近づかなければ `target_not_approaching`（`FIGHT_NO_CLOSER_MAX`）。
- 観測: 状態の変わる地物（`afterInteract`。護りの火）も interact に出す（変わった後は出さない）。守護者は、同じ種族の通常の個体を知っていれば初見にしない。守護者には推定残り HP を出さない。封じられた階の踏破の見込みに注記。身をかわすは離れる向きをすべて 1 行（`use_ability slip <n|ne|w>`）。既知の経路で届かない階段は「travel_to stairs_down (不可: …)」。見出しに通常でない階の種類（`self.floor.floor_type_id`）。遠征の行の次の節目は短い形。
- fight until: clear の「倒した」は接辞付きの名前と守護者の呼び名。
- 移動マクロ（travel・explore・collect）は、同じ 2 マスを往復したら `no_progress` で止まる（直近 5 手の位置が A・B・A・B・A）。

## 24. 見直し 5 V3-3a（IMPROVEMENTS_V3 §35.1〜§35.8）

設計は IMPROVEMENTS_V3 §35、実装メモは同書 §36。規則と候補の作り方が変わり、新しいイベントがあるので `engineVersion` は 0.14.0、`eventVersion` は 9。

### 24.1 守護者は、相手が階を離れている間に回復する（§35.1）
- 最後のプレイヤーが階段で階を離れると、その階の守護者（大守護者を含む）に離れたときの手番数（`GuardianInfo.awaySince`）を付ける。プレイヤーが戻ったとき、離れていた手番 × `guardian.awayHealPct`（2）% を一度に回復する。
- 全快したら落ち着く（`settleGuardian`）: 状態異常を消し、追跡をやめ、持ち場へ戻り、怒り（速さ・威力）と呼んだ回数を戻し、見ていた与ダメの累計を戻す。全快しなければ位置と状態はそのまま。
- キャンプから遠征を始めるとき、すべての階の守護者を落ち着かせる（キャンプで休む間に守護者も戻る）。通常の敵は今までどおり回復しない。
- `guardian_rested { id, guardianName, full, player }`（戻ってきた本人に。変化の `guardian`）。守護者に気づかれているときの use_stairs に「階を離れている間、守護者は回復する」。

### 24.2 節目を候補に入れる（§35.2）
- 目的の種類 `slay_warden`（節目に挑む）。目的の点はその深さの格 3 の守護者と同じ式。節目が踏破済み（`milestones.cleared`）になれば達成で、どちらの階段で extract してもよい。
- 候補の目標: 未踏破の節目 M を越える目標は野心だけ。堅実・標準の目標が M 以上になるとき、標準は「節目に挑む」（地下 M 階）、堅実は M − 1 階の格 1 の守護者。野心の目標が M に当たれば M + 1。次の候補の下限（`nextCampOf`）も、未踏破の節目なら M − 1、踏破済みなら飛ばす。
- 同じ階を目標にした達成を繰り返すと、目的の基礎点に `expedition.repeatPct`（50）% を回数分掛ける（`Offer.repeatNo`。文に「この階は N 回目」）。
- 推奨レベルと危険度（`offerGap` の `extra`）: 節目に挑む = その深さ + `warden.levelBonus`（2）。節目を越える（`passesWarden`）= 目標と大守護者の大きいほう、危険度 +1。
- 大守護者の体力に上限 `warden.maxHpBase`（40）+ `maxHpPerDepth`（10）× 深さ（SpawnSpec の `maxHp`）。
- 節目に挑む候補は `Offer.warden`（名前と型）と見込み（種族は伏せ、見れば分かる特徴だけ。`wardenPreview` で生成と同じ種族を求める）。

### 24.3 外れた弱点も記録する（§35.3）
- 試しの場面（毒を与えた・投擲を当てた・気づかれる前に一撃を入れた・水場の上にいた）で、その弱点でなければ `guardian_intel { miss: true }` を出し、`knowledge.guardianTried` に入れる。同じ守護者・同じ弱点では 1 回だけ。
- `EntityView.guardian.notWeak`・観測の `guardian.not_weak`・敵の行と look に「弱点: 不明（毒ではない・投擲ではない）」（弱点の短い呼び名 `short`）。変化に「…の弱点は毒ではない」。

### 24.4 回復の薬・特技・格 1・fight（§35.4〜§35.6）
- 回復の薬は 2d8+4、ただし最大 HP の 30% を下回らない（効果 `heal` の `minPct`）。get_rules と鑑定済みの説明に式。
- Lv6 の特技の候補で、まだ一度も候補に出ていない職業の能動技（職業の系統で能動技を覚える特技）があれば、最後の 1 枠をそれに替える。出た候補は `build.offered` に記録する。
- 格 1 の守護者も型 1 つ。種族は目標の深度の表の上位半分（射撃して距離を取る型は除く）。
- fight の `first_hit` は、その被弾が最大 HP の `fight.firstHitStopPct`（15）% 以上のときだけ止まる。`fight.recordedKills`（3）体以上倒した種族は記録ありとして扱う。fight の結果に「初被弾: 名前 値」、`hp_risk` で止まったら「hp_floor を N にすれば、あと 1 回の最悪の被害（M）まで続けられる」。

### 24.5 納めた欠片が、次の番人の記憶を返す（§35.7）
- 遺物を階段の上で納めるたびに、記録庫が次の節目の大守護者の記憶を 1 つ返す（`archive_recalled { player, relic, depth, guardianName, memory, weakness?, hp?, maxHit? }`。本人だけ）。節目ごとに 1 つ目は弱点（`rollWardenInfo` の値）、2 つ目は体力と最大の一撃（`wardenPreview`: 階が無ければ生成と同じ計算で求める）、3 つ目からは無い。
- `knowledge.wardenIntel[深さ]`・`knowledge.archive`（納めた遺物）。PlayerView の `wardenIntel`・`archive`。大守護者の弱点は記憶からも分かる（EntityView に出る）。
- 文: キャンプと遠征の「次の節目」に「記録庫の記憶: 弱点 …・体力およそ N・一撃 M まで」、キャンプに「記録庫: 欠片 n/7」、遺物の候補に「納めると、記録庫が地下 N 階の番人の記憶を 1 つ返す（残り K）」、大守護者の look に体力と一撃の目安。

### 24.6 実装担当の判断（§35.8）
- 帰還の綱の valid_actions の長い説明は、遠征ごとに最初の 1 回だけ（`TurnSnapshot.lifeNo`）。以降は「キャンプへ戻る・+N 確定・追跡中の…」。
- 敵の速さの表示は、加速・減速を除いた自分の速さと比べる。
- 見送ったもの: explore の toward の理由の表示、collect の有害品の拾得、地図の x 座標の見出し（§36）。

## 25. 振り返り V3-6（IMPROVEMENTS_V3 §6・§35.9）

設計は IMPROVEMENTS_V3 §6 と §35.9、実装メモは同書 §37。助言はせず、自分のプレイを事実で振り返る材料を出す。`engineVersion` 0.14.1、`eventVersion` 10。

### 25.1 集計（`shared/expeditionStats`）
- `buildExpeditionReport` はルールを含まない純粋な関数。入力は、そのプレイヤーが知覚した出来事（`filterEventsForPlayer` を通したもの）・自分の手番の記録（自分の `actor_scheduled` の after 値。`selfTurnMarks`）・自分が送ったコマンドの記録だけ。見ていないもの（視界外の毒の削りなど）は数えない。
- 戦闘（与・被ダメージは実際に減った HP、命中と外れ、会心、撃破と近接・投擲の内訳、能動技）、道具（薬・巻物、この遠征で拾って正体の分からないままの種類、宝の確定点）、進み（手番、休憩の手番、階の数と 1 階あたり、最深、呼び出し、マクロの手の割合）、確定の内訳。
- HP の推移は、遠征の開始の記録（`Expedition.start[pid].hp / maxHp`。射影では自分の分だけ `expedition_started.expedition.self`）から追う。
- 場面（最大 8 件）: 大守護者・守護者との戦い（与・被と結末）、死の際から逃れた（HP 25% 以下から、回復せずに階段・綱・帰還・撤退）、HP の最低（最大の半分以下のときだけ。直前 3 手番の被害の出どころを添える）、最大の一撃（最大 HP の 15% 以上のときだけ）、発見、レベル。入りきらなければ前の順で優先する。
- 守護者の名前は、出来事にある名前（弱点の発見・型の動き・大守護者の撃破）、節目の階の大守護者は節目の名前、目的の守護者は倒れた直後に目的が達成された個体だけ（遠征の公開情報から）。分からないときは「守護者オークの荒くれ」と種族で書く。
- 死亡: 倒した相手（自分に付いた毒なら「自分に付いた毒で倒れた」）、直前 10 件の出来事、直近 20 手番の HP。

### 25.2 比較（§35.9）
- そのランの中の前の遠征と比べる（プロフィールは V3-7）。`vs_previous` は直前の遠征との差（確定・被ダメージ・手番・撃破・呼び出し）。`personal_best` は事実の列挙: 確定点・最深・撃破・与ダメージの自己最高（すべての遠征と）、被ダメージの最少・手番の最短・呼び出しの最少（達成した遠征どうし。綱ですぐ戻った遠征が「最少」にならないように）。
- `feats`（§7.4）は V3-7 まで出さない。

### 25.3 出し方
- 遠征が終わった行動の応答に `report`（JSON は全項目）と 12 行以内の文。キャンプにいれば、確定の行と比較の行は観測に出ているので文から省く。
- キャンプの観測に直前の遠征の比較を 2 行まで（`camp.compare`）。候補を選ぶ画面で自分の記録が目に入るように。
- `expedition`: 進行中なら途中経過（戦闘と進み）、キャンプなら直前の遠征のレポート。`review { expedition? }`: 終わった遠征のレポート、入りきらなかった場面、倒れる直前の出来事。
- サーバー（RunSession）は、プレイヤーごとにコマンドの記録（呼び出し・マクロの呼び出し・マクロの 1 手）を持ち、復元時は commands.jsonl から作り直す。終わった遠征のレポートは覚えておく。`timeout`（COOP の自動の待機）と `system`（new_run が送る最初の遠征の開始）は呼び出しに数えない。
- 人間の画面（client）にはまだ出さない（V3-7 のプロフィールと一緒に考える）。

## 26. 中層の敵 V3-5a（IMPROVEMENTS_V3 §35.10）

設計は IMPROVEMENTS_V3 §35.10、実装メモは同書 §38。`engineVersion` 0.15.0。

- 弱い種族の深さの上限（`depth.max`）: 大ネズミ 4・ジャッカル 6・ゴブリン 7・ゴブリンの投石兵 9。
- 地下 4〜14 階の 4 種（数値は §35.10 の出発点から、bot の計測で 2 か所を下げた。§38）。
  - 洞窟狼: 群れ（2〜3 体）、速い、1d6。通路に下がる・なぎ払いが答え。
  - 錆の粘体: 遅い。当たると「錆」。寄られる前に投げる、鎧に頼らない。
  - 呪い火の術者: 射程 5 の装甲を抜く射撃（1d4・命中 +1）、距離を取る、体力が低い。射線を切る、詰める、投げる。
  - 石皮の甲虫: 装甲 6、遅い。会心（装甲を無視）・強打・避けて通る。
- 仕組みは 2 つ。どちらもデータとレジストリで足した。
  - 射撃の `pierce`: 装甲と構えを無視する（会心と同じく装甲を数えない）。
  - 状態異常のハンドラ `stat_mod`: 能力値の修正を持つ状態異常。「錆」は装甲 −2、10 手番。同じ状態異常は重ならず、また当たると手番が戻るだけ。下げる修正で装甲を 0 未満にはしない。修正はダメージの計算のとき（`armorOf`）に読み、能力値そのものは書き換えない（キャンプで状態異常が消えれば元どおり）。観測の `self.defense.armor` は修正込み（`armorWithStatuses`。同じ規則）。
- 見れば分かる特徴に「錆びさせる」（`rusting`）・「装甲を抜く」（`pierce`）。種族の公開タグから、初見でも観測の敵の行と look（「見た目: …」）に出る。守護者の見込みの特徴にも出る。
- 守護者の種族の表にも入る（格 1 は今までどおり射撃して距離を取る型を除く）。
- 最も深く定義された階（洞窟トロルの最盛期 12）より深い階は、今までどおりその階の表を強化して使うので、新しい種族も 13 階より深く出る（実効の深さで上限を比べる）。

### 26.1 V3-5a の後の AI 評価で直したこと（IMPROVEMENTS_V3 §39）

`engineVersion` 0.15.1、`eventVersion` 11。テストは `packages/tools/test/v35eval.test.ts`。
- fight の hp_risk と観測の「1 手の最悪の被害」（`alerts` の incoming・lethal_range）に、隣にいる逃走中の敵も入れる（追い詰められた逃走中の敵は殴ってくる。逃走中の小悪魔に HP 23 → 7 まで殴られ、hp_floor 12 で止まらなかった）。
- マクロが状態異常で止まるのは、その呼び出しの中で初めて掛かったときだけ（切れて付き直した錆・毒では止まらない）。自分が付けた状態（盾の構えの「構え」。`source` を自分にした）と、いまの装甲では効き目の無い装甲の修正（装甲 0 での錆）でも止まらない。
- flee の既定の hp_floor（25%）は、始める時点ですでにそれ以下なら 0（一番逃げたいときに拒否された）。明示した hp_floor はそのまま。
- collect は敵が乗っている品を後回しにする（経路探しは行き先のマスの敵を通すので、いちばん近い品が敵の足元だと、ほかに届く品があっても 1 歩目でふさがれた）。足元に拾う品があれば、careful・steady の「隣に起きている敵」で止まる前に拾う。
- マクロは、鑑定済みの有害品でも投げて使える品（毒薬など）を拾う（毒に弱い守護者を倒す鍵だった。§35.8 で見送った項目）。呪いの装備などは今までどおり拾わない。
- explore toward:sense は、遺物・守護者が見えたか覚えていれば止まる（`sense_found`。最初の判断なら拒否し、travel_to を勧める）。遺物を見たまま階の反対側まで探索した。
- travel_to の品を拾って所持品の同じ品に重なったら到着（「相手が見えなくなった」と出た）。
- fight の結果の文は近接と投擲を分けて数える（adjacent: 'melee' の近接も「投げ」と数えた）。遠征レポートの命中に投擲の当たり外れを入れる（斥候の命中が近接だけで 1/8 と出た）。比較の最少・最短は「達成した遠征で」と書く。
- 状態異常が解けた・能動技を使ったの文にも守護者の印（「守護者錆の粘体」）。守護者と同じ種族の手下がいると区別できなかった。呼び集める者が 0 体呼んだときは「呼ぼうとしたが、呼べる場所が無かった」。
- キャンプへ戻ると、能動技の再使用待ちも戻る（HP と状態異常と同じ。遠征をまたいで「あと 6」が残った）。遠征に 1 回の能動技は今までどおり遠征ごとに数える。
- 封じられた下り階段（大守護者の間）の上で extract するときは、次の遠征もこの階段から始まり、上り階段へは広間を通ることを文に添える（撤退した次の遠征で、全快した大守護者のいる広間を横切った）。

## 27. 見直し 6 V3-3b（IMPROVEMENTS_V3 §40.1〜§40.7）

設計は IMPROVEMENTS_V3 §40、実装メモは同書 §41。`engineVersion` 0.16.0、`eventVersion` 12。

### 27.1 斥候の投擲を装甲に届かせる（§40.1）
- 特技「急所狙い」（射手の系統、ランク 2 まで）: 投擲は相手の装甲を 1 ランクにつき 2 無視する（フック `thrown_pierce`）。弾く者の半減はその後に掛かる。斥候には Lv4 までに一度は候補に出す（特技の `offerByLevel`。§35.4 と同じく `build.offered` で判定）。投擲に威力は乗せない。
- 狙い撃ちと不意打ちの会心は、気づいていない・眠っている相手に加えて、朦朧（行動不能の状態異常。突進を外した突き進む者の「1 手無防備」）の相手にも。戦士の通常の近接には広げない。
- 投げ槍: 戦利品の表の項目に `depthMin` を足し、`core:common_loot` に投げ槍（重み 8、地下 3 階から）を足した。
- fight の `with` は品の種類でも指せる。投げる品は手番ごとに同じ種類の品のスロットを引き直す（拾ってスロットが変わっても続く）。品が尽きたら、追跡中の敵（逃走中を除く）の隣を通らずに届く、自分が投げた同じ種類の品へ歩く（踏めば拾う）。届く品が無ければ今までどおり `out_of_ammo`。`retrieve: false` で切れる。
- 記録庫の 2 つ目の記憶に装甲（素の装甲。生成と同じ計算）。次の節目の文に「いまの持ち物で 1 回に通る目安」（近接の武器と持っている投擲物。急所狙いの分を引く。式は engine と同じ `damageRangeVs`）。

### 27.2 小悪魔と回避の高い相手（§40.2）
- 見れば分かる特徴に「回避が高い」（`evasive`、素の回避 5 以上）。観測・look・候補の見込みに出す。get_rules に境目（重装は装甲 3 以上、回避が高いは回避 5 以上）。
- 小悪魔: 回避 6 → 5、命中 4 → 3、深さ 3〜14 → 4〜10、経験値 7 → 9（速さと「傷つくと逃げる」は残す）。

### 27.3 守護者の立て直し（§40.3〜§40.5）
- 呼び集める者の手下には呼んだ守護者の印（`Entity.minionOf`）。守護者が落ち着くと（キャンプの後・全快まで回復したとき）、手下は階から去る（経験値も戦利品も残さない）。戻ったときに 1 行（`guardian_rested.dispersed`）。手下が出る場所の規則は書かない。
- 弱点「眠りが深い」の守護者は、落ち着くと持ち場で眠りに戻る。起こしにくさ +30（弱点の `params.stealthPct`。見えたときに起きる確率の計算に足す）。look に「いまは眠っている／起きている」、記録庫の記憶に「キャンプの後は眠りに戻る」。
- 守護者は、追っていない間も回復する（手番 1 つにつき最大体力の `awayHealPct` %）。休み始めは、階を離れたとき（§35.1）と、同じ階で見失って探すのをやめたとき（追跡が切れて 25 手番探した後）。計算は、次にプレイヤーが見たとき・追跡を再開したとき・階に戻ったときに、休み始めを記録したプレイヤーの手番の差で一度に。全快なら落ち着く。

### 27.4 節目の手前（§40.6）
- 繰り返しの減点に下限 `expedition.repeatMinPct`（25%）。
- 守護者が目的の候補に、一撃の目安（`guardian.maxHit`。装甲で減る前。種族のダイス + 守護者の接辞 + 深層強化。ほかの接辞は含まない）。
- 封じられた下り階段（倒していない大守護者の階）の上で終えた遠征と、帰還の綱の戻り先がそこだった遠征は、次をその階の上り階段から始める。

### 27.5 実装担当の判断（§40.7）
- valid_actions: 投擲の適性が負の職業（戦士）には投擲の fight を出さない。投擲の fight は品の種類で示す。使い切った能動技は出さない（`self.abilities` の `uses_left` で分かる）。突進の構えの直線の上にいれば、外れる向きの move に「突進の直線から外れる」。
- 移動マクロ（travel・collect・explore）の経路は、気づいていない・眠っている守護者の 2 マス以内を、ほかに道があれば通らない。
- 突進のダメージは 2 倍（テストで確かめた）。

## 28. 目標の宣言 V3-7a（IMPROVEMENTS_V3 §40.8・IDEAS §2.1）

**V3-8 で外した**（IMPROVEMENTS_V3 §53.5。§35.5）。以下は当時の記録として残す。

設計は IMPROVEMENTS_V3 §40.8、実装メモは同書 §42。World と engine は変えていない（`engineVersion`・`eventVersion` はそのまま）。

- **置き場所**: World の外（遠征レポートと同じ層）。RunSession がプレイヤーごとの目標の記録を持ち、`runs/<id>/goals.jsonl` に残す（復元時に読み直す）。`Command` ではなく、`PlayerPort.declareGoal` を AI（MCP の `declare_goal`）と人間（WS の `{ t: 'goal' }`。キャンプの画面の候補のボタン）が同じ口として使う。
- **宣言**: キャンプで、1 度に 1 つ。しなくてもよい。点・経験値・戦利品には一切影響しない。宣言し直すと前の目標は「取り下げ」。遠征中は宣言できない。
- **型**（どれも遠征レポートの値で判定する。`shared/goals` の `judgeGoal`）: 深さ（最深到達を地下 N 階に。期限 1〜3 回の遠征）・確定点（1 回の遠征で X 点以上。次の遠征）・節目（次の未踏破の節目の大守護者を倒す。1〜3 回）・余力（達成した遠征で、最も下がった HP を最大の N% 以上に保つ。次の遠征）。判定は遠征が終わるたび（`expedition_ended` を記録した直後）。
- **候補**: 自己最高に並ぶ／少し超える（+10%、深さは +1）／大きく超える（+30%、深さは +2）。確定点は 100 単位に切り上げ。余力は達成した遠征の値だけを自己最高に数える。記録が無ければ初期値。節目は「3 回以内／2 回以内／次の遠征で」。候補の外の値も宣言でき、記録には自己最高との差を添える。
- **見せる場所**: キャンプの 3 行（「目標: 未宣言」または宣言中の目標と自己最高との差、候補、「目標の記録: 宣言 n・達成 m」）。比較の行（§25.3）はここに吸収し、文には出さない。遠征中の観測と `expedition` に「目標: …（いま帰ると N。あと M）」、確定点の目標なら extract の候補の行にも差。遠征レポートに `goal`（結果と自己最高との差）と、振り返りの文に 1 行。
- **入れないもの**: 自由記述の目標、LLM による判定、達成の報酬。
- 不変条件: 候補の値は本人の遠征レポートからだけ作る。AI と人間に同じ候補を渡す（`GoalInfo`）。

### 28.1 V3-3b・V3-7a の後の AI 評価で直したこと（IMPROVEMENTS_V3 §43）

`engineVersion` 0.16.1（同じシードの候補の守護者と遺物が変わる）、`eventVersion` 12 のまま。

- **候補の守護者の接辞**: 接辞は候補を作るときに引き（`seed|guardian-affix|遠征の番号|枠`）、候補と遠征に持たせる（`guardianAffixes`。プレイヤーには渡さない）。見込みの特徴（速さ・回避・毒）と一撃の目安は接辞込みで出し、目標階に置く守護者に同じ接辞を付ける。前は置くときに引いていて、「普通の速さ」の候補が俊敏な守護者になった。
- **同じ遺物を 2 枠に出さない**: 遺物は、同じキャンプのほかの枠に出したものを避けて引く（避けると引けないときだけ重ねる）。
- **fight の待つ手番**: 標的ではない隣の敵の近接で被弾したら止まる（`hit_while_waiting`）。`until: 'clear'` なら、止まらずにその敵へ標的を替える。射撃で撃たれたときの停止（§19）と同じ形。
- **状態異常で止まる条件**: 能力値の修正だけの状態異常（錆）では止まらない（錆が付くたびに止まった）。状態は観測と変化の欄に出る。
- **explore toward**: `sense` が止まるのは、この遠征の目的の遺物・守護者だけ（階に残っていた別の守護者で止まり、続けて呼ぶと拒否された）。`draft` は、着いた境界の近くの境界を続けて追うとき、風の方角にある境界だけを追う（西の境界に着いた後、通路をたどって南東・東へ 16 歩流れた。記録した盤面でなぞり直して確かめた）。
- **観測**: 速さの倍率（「遅い×0.8」）。階段の上の敵（`known_stairs[].occupied_by`。valid_actions の階段への移動は「不可」、逃げ道の警告にも添える）。致死の警告に回復の手段。節目に挑む遠征の状況の行に、記録庫の記憶の弱点。鑑定済みの品の種類 ID（fight の `with` に渡せる）。
- **文**: 投げた物が見えない所に落ちたら「届かず、見えない所に落ちた。」。

## 29. 見直し 7 V3-3c（IMPROVEMENTS_V3 §44.1〜§44.6）

設計は IMPROVEMENTS_V3 §44、実装メモは同書 §45。`engineVersion` 0.17.0、`eventVersion` 13。

### 29.1 目的でなくなった守護者は階を去る（§44.1）

- **去る**: 遠征を始めるとき（`expedition_started` の直後、守護者が落ち着く前）、その遠征の目的ではない未討伐の守護者（大守護者を除く）は階から消える。呼んだ手下（`minionOf`）と棲み処の地物（`lairOf`。持ち主の無い古い護りの火は持ち場から 4 マス以内）も消える。その守護者に会ったことのある参加者に `guardian_departed`（「地下4階の守護者「ネミ」は棲み処を去っていた」）。記憶からも火を消す。
- **棲み処の地物の持ち主**: 生成では、地物の生成仕様に `lair` を付け、直前に置いた守護者を `lairOf` にする。生成済みの階に置くときは、その守護者を渡す。護られし者の装甲は、自分の棲み処の火（持ち主の無い古い火は階のどの守護者のものとも数える）だけで決まる。
- **再挑戦**: 候補を作るとき、守護者を倒す枠の目標の階に未討伐の守護者が残っていれば（階ごとにいちばん新しい 1 体）、新しい守護者を作らずその守護者を目的にする（名前・型・弱点・種族・接辞はその守護者のもの。格はその守護者を目的にした遠征の格）。繰り返しの減点は掛けない。`offer.rechallenge { no, guardian }`。選ばれれば遠征の `rechallengeOf` に入り、目標階に新しく置かず、開始のときに目的として記録する。外れた弱点の記録（`guardianTried`）は同じ守護者なので残る。
- **前回の戦い**: キャンプの候補の文に、本人の遠征レポートの `combat.guardian_fights` から「前回（遠征 N）は与 X・被 Y」（PlayerPort が `offerNotes` で渡す。戦っていなければ「この守護者とはまだ戦っていない」）。

### 29.2 弱点と型、大守護者（§44.2）

- 型のデータの `excludesWeaknesses`（弾く者は投擲に弱い、潜む者は眠りが深いを除く）。弱点は型を引いた後に、型が打ち消さない弱点から引く（格 1〜3 と大守護者の両方）。
- 「投擲に弱い」は 1.5 倍（`params.pct` 150。端数は切り上げなので、1 でも 2 になり弱点が分かる）。
- 大守護者の速さは `balance.guardian.warden.minSpeed`（100）を下回らない（生成仕様の `minSpeed`。格 1〜3 は種族のまま）。候補の見込みの特徴も同じ下限で出す。
- 候補の体力: 格 1〜3 は「体力はおよそ N」（種族の体力ダイスの平均 × (100 + 深層強化 + 接辞 + 格の上乗せ)%、下限は格の式。一撃の目安と同じ考え方）。大守護者は「体力 50〜90」（式の下限と上限。種族によらない）。式は `get_rules` に書いた。
- 記録庫の記憶の「通る目安」に、体力が分かっていれば「（およそ N 回の命中）」（平均の通りで割って切り上げ）。

### 29.3 特技（§44.3・§44.4）

- 鎧さばき（不屈・ランク 2・装甲 +1/ランク・`offerByLevel` 4。戦士に Lv4 までに一度は出る）、強肩（射手・ランク 3・投擲のダメージ +1/ランク。会心にも乗る）、重い一撃（前衛・ランク 3・近接の会心 +2/ランク）。剛力は投擲に乗せない（変えない）。
- 候補の引き方: 今までどおり引いた後、Lv6 の能動技と `offerByLevel` の差し替えをして、それでも 3 つとも「特技を持っている職業の系統か共通の系統の、ランクが残っている物」でなければ、差し替えていない枠（末尾から）を当てはまる物に替える（`seed|perk|プレイヤー|レベル|useful`）。

### 29.4 目標・fight・観測（§44.5・§44.6）

- 目標: キャンプの観測の目標の行は 1 行（`GoalInfo.lines`）。候補と記録は `GoalInfo.full`（`declare_goal` を引数なしで呼ぶ・`expedition`・人間の画面）。点は付けない（変えない）。
- fight: `with` に複数の品（`alsoWith`）。手番ごとに前から順に、持っていれば投げ、尽きていれば拾い直せる自分の投擲物へ向かい、それも無ければ次の品。`collectAfter`: 決着（倒した・片付いた）の後、追跡中の敵（逃走中を除く）が見えていなければ、その場で collect（careful・hp_floor 0）に切り替え、拾い終えたら決着の理由で止まる。引き撃ちのマクロは入れない（変えない）。
- 囲まれたときの hp_risk: 止まる条件は変えず、隣に 2 体以上いれば「隣に N 体いるので、この hp_floor では毎手番止まる。hp_floor を M にすれば K 手番続く」を添える（K は 3 まで）。
- 座標を狙った投擲も、射程外か経路が通らなければ手番を使わずに拒否する（方向を狙ったときは今までどおり射程の端か遮られた位置に落ちる）。
- 護りの火: 火の行に持ち主の守護者（「（護られし者ネミの棲み処）」）。同じ守護者の火を 1 基でも見ていれば（見えている・覚えている）、まだ見ていない灯っている火の方角と遠さを `expedition.ward_fires` に出す（気配と同じ形。10 マス以内なら近い）。
- 応答の長さ: 加護の行は遠征ごとに 2 回目から名前だけ（帰還の綱の説明と同じ仕組み）。遠征レポートの薬は種類ごとの内訳も出す。
- 見送ったもの: 推定残り HP を接辞の有無で分けること（記録の持ち方を変える必要がある）、通り道の階について本人が覚えていることを候補に出すこと（覚えている敵の位置を記録していない）、flee の経路が守護者の棲み処を通るときの警告（V3-3b で経路の避け方だけ入れたまま）。

## 30. 深層の敵 V3-5b（IMPROVEMENTS_V3 §44.7）

設計は IMPROVEMENTS_V3 §44.7、実装メモは同書 §46。`engineVersion` 0.18.0、`eventVersion` 14。V3-5 の残りのうち、深層の敵だけを先に入れた（特殊部屋・バイオームの仕掛け・階の異変・手がかりは後の段）。

- **種族**（データ）: 骨の射手（地下 9・12・18。2 体組。行動様式 `ranged_stand`: 隣なら殴り、射程と射線が通れば撃ち、通らなければ寄る。距離は取らない）、血吸い蝙蝠（10・13・18。3〜4 体の群れ。タグ `drain`）、大鬼（11・14・上限なし。大柄。タグ `heavy_swing`）。オークの荒くれの上限は 14。
- **血を吸う**: 近接で与えた実ダメージ（とどめの超過分を除く）の分だけ、攻撃した側が回復する（最大 HP まで。`healed.via: 'drain'`）。プレイヤーには付かない。
- **大振り**: 隣に相手がいて、前の大振りから `swingEvery`（3）手番以上たっていれば、その手番を使って構える（`intent: { kind: 'swinging', pos }`。pos は構えたときに相手がいたマス）。次の手番に、そのマスにいるプレイヤーを `swingMult`（2）倍で打つ（倍率は装甲を引いた後。突進と同じ）。いなければ空を切って 1 手朦朧（`monster_acted`）。予備動作なので fight などのマクロは構えで止まり、valid_actions は的のマスから外れる一歩に印を付ける。守護者の型の予備動作（突進など）が先で、手番を使わなければ大振り。
- **表の深さ**: `balance.monsterTableDepth`（18）を足し、`deepestDefined` は種族の peak の最大とこの値の大きいほう。地下 18 階までは種族の深さの表で選び（深層強化なし）、それより深い階だけ表を地下 18 階のものに固定して深層強化で硬くする。地下 15〜18 階に出る通常の敵は、洞窟トロル・大鬼・骨の射手・血吸い蝙蝠（ほかは上限で外れる）。
- **守護者**: 3 種とも守護者の候補に入る。格 1 は射撃する型（距離を取る型と、その場で撃つ型）を除く。
- **見れば分かる特徴**: `drain`（血を吸う）・`heavy_swing`（大振り）。look・visible.monsters・候補の見込みに出る。

## 31. 特殊部屋 V3-5c（IMPROVEMENTS_V3 §5.1）

設計は IMPROVEMENTS_V3 §5.1、実装メモは同書 §47。`engineVersion` 0.19.0、`eventVersion` 15。

- **部屋はデータ**（prefab に `name` とタグ `room`）。置き方は今までの prefab と同じ（階の種類の `prefabs.tags` に合うものを重みで）。部屋の見つけ方: 手番の終わりに、参加者の視界に、まだ見つけていない部屋の矩形の中の通れるマス（か格子扉）が入れば `room_found`（`Region.found` を立てる）。発見の点（`haul.discovery.room`）は 1 部屋 1 回。
- **施錠された宝物庫**: 入口は鍵のかかった格子扉（通れないが見通せる。中の宝が先に見える）。生成の最後（`populate` の後、`keys` ストリーム）に、宝物庫の外の通常の敵（動かない種族を除く）1 体に `carries: core:vault_key` を付ける。敵がいなければ鍵を床に置く。持っている品は見れば分かる（観測に出る）。倒すと落とす。鍵を持って格子扉の隣で interact すると、鍵は無くなり、格子扉が開いた格子扉に変わる。
- **碑文**: 読むと（interact）`inscription` の物語の文 1 つと、手がかり 1 つ: この階の守護者（生きていて、本人がまだ弱点を知らない）の弱点 → 鍵のかかった宝物庫（まだ見つけていない）の矩形を地図に記す → 未鑑定の見た目 1 種の正体（持っている物を先に）。読むと発見 +50。書き置き（`old_note`）は `note` の文だけ。どちらも 1 回だけ（読んだ状態になる）。
- **賭けの祭壇**: 地物の `gamble` の表（重み）から 1 つ選び（`runtime` の乱数）、その効果を起こす。表と確率（%）は公開カタログに入れ、look で読める。1 回だけ。表: 最大 HP +3（20%）・持ち物の装備 1 つに良い接辞（20%）・持ち物を全部鑑定（20%）・装備している品 1 つが呪われる（15%）・敵を 2 体呼ぶ（15%）・HP が半分（10%。HP 1 では減らない）。
- **ほかの部屋**: 番兵の詰所（眠っている敵 4 体と宝の表の品）・先行者の野営跡（ふつうの戦利品 3 つと書き置き。地下 9 階まで）・崩れた書庫（本棚＝通れず見通せない地形、巻物 3、起きている敵 1）。どれもデータだけ。
- travel_to の止め方: 目的地までの道のり（経路の長さ）の最短を覚え、20 手のあいだ縮まなければ `no_progress`（bot の計測で、逃げ回る敵で経路が変わり続け、2 マスの往復でない形で 200 手さまよった）。
- 見送ったもの（§5.1 のうち）: レバー（離れた扉・格子の開閉）は、バイオームの仕掛け（§5.2）と一緒に作る。

## 32. 階の異変・描写と手がかり・名前付きの強敵 V3-5d（IMPROVEMENTS_V3 §5.3・§5.4）

設計は IMPROVEMENTS_V3 §5.3・§5.4、実装メモは同書 §48。`engineVersion` 0.20.0、`eventVersion` 16。

- **階の異変**（データ `floorEvents.json` と、生成の handler）: 階の種類の `rules.events` が真の階（通常の階・大空洞）で、prefab を置いた後に `events` ストリームで 25% の確率で 1 つ引く。生成の前の効果（荒らされた跡: 敵とアイテムの数を半分にし、先行者の野営跡を置く／溢れた宝: 宝の割合を 2 倍）と、敵を置いた後の効果（深い眠り: 守護者以外の全員を眠らせる／賞金首・番人の巡回: 名前付きの強敵を 1 体足し、巡回の道を持たせる）。`Floor.event` に入れ、プレイヤーには到着の文（arrival）だけを渡す。
- **深い眠り**: 眠っている敵が起きたとき（理由を問わず）、その階の異変が深い眠りなら、ほかの眠っている敵（守護者を除く）を全員起こす（`monster_woke.reason: 'floor'`）。
- **溢れた宝の徘徊**: 徘徊の湧きの間隔を半分にする（スケジューラ）。
- **巡回**（行動様式 `patrol`）: 相手を見ている間と、見失って探している間は近接で追う。それ以外は道（`AiState.route`）の点を順に回る。番人の巡回の道は部屋の中心 4 つ（足りなければ離れたマス）、賞金首は離れたマス 6 つ。種族は守護者の候補の表（巡回は格 1、賞金首は格 2）から。
- **名前付きの強敵**: 敵を置いた後（`elites` ストリーム）、通常の敵の 3% を強敵にする（地下 3 階から。動かない種族と害獣を除く）。深さに合う接辞を 2 つ・名前（守護者の名前の音節）・賞金。役割は `elite`。接辞付きなので倒すと宝を必ず落とす。
- **未鑑定の手がかり**: 薬と巻物の定義の `clue`（2 種で同じ文）。手番の終わりに、手がかりのある未鑑定の見た目を持っていれば、初めてのとき手番数を覚え（`clue_noted`）、`clueTurns`（30）手番たったら（職業の `clueOnPickup` なら拾った時点で）手がかりを知る（`clue_learned`。`Knowledge.clues`）。観測は所持品の行と inventory に出す。
- **初見の描写**: 種族・バイオームの `desc`（地物とアイテムは今までの説明）。応答の変化（`diffChanges`）で、このランで初めて見たものに `first_seen` を 1 回だけ（1 回の応答で 3 件まで。溢れた分は次の応答に回す）。覚えておく集合はプレイヤーの応答の要約（World の外）に持つ。

## 33. バイオームの仕掛け V3-5e（IMPROVEMENTS_V3 §5.2）

設計は IMPROVEMENTS_V3 §5.2、実装メモは同書 §49。`engineVersion` 0.21.0、`eventVersion` 16（出来事の種類は増やしていない）。

- **データの形**: バイオームの `rules { levers, ceilings, pods }`（生成のとき置く数）と `items [{ item, min, max }]`（床に置く品）。地形の `moveCostPct`（入る手番の倍率。既定 100）とタグ `conceal`（中の者は隣からしか見えない）・`pushable`（押して動かせる）・`grate`（投げた物は通る）。地物の `lever`・`collapse { trigger, loudness, radius, dmg }`・`burst { radius, cloud, turns }`。地物の実体の `feature.expiresAt`（その階の時刻を過ぎたら消える）と、レバーの `Entity.links`（つながった格子扉のマス）。
- **石の広間（レバーと格子扉）**: 生成の最後に、扉（部屋と通路の境）を最大 `levers` 個だけ開いた格子扉 `core:grate_open` に変え、その扉から 2〜5 マス（チェビシェフ距離）の床にレバー（通れる地物）を置いて `links` でつなぐ。レバーは足元か隣で interact すると、つないだ格子扉を閉じる（`core:grate_closed`。通れず、見通せて、投げた物と射撃は通る。敵の射撃もプレイヤーの投擲と同じ経路の判定）・開ける。閉じるマスに者か物があれば、そこは開いたまま。引くと音 4。
- **湿った洞窟（浅い水と脆い天井）**: 浅い水は入る手番が 150%（プレイヤーは重い鎧の倍率に掛ける。敵も動いた手番だけ同じ）。水の上で起きた音は大きさを 2 倍にする（届く距離が延びる）。脆い天井（`core:brittle_ceiling`。通れる地物）は、3 マス以内で大きさ 4 以上の音が起きると崩れる: 周り 1 マス（真下を含む）の者に 2d6、真下に誰もいなければ瓦礫（`tile_changed.reason: 'collapse'`）。周り 8 マスが通れるマスに 3 つ置く。
- **苔むした遺跡（背の高い草と胞子嚢）**: 背の高い草（タグ `conceal`）の中にいる者は、隣（チェビシェフ距離 1）からしか見えない。プレイヤーの射影（`projectPlayerView`）と、敵の見る判定・プレイヤーの知識（会った・射線）に同じ判定を使う。草が視線そのものを遮るのではなく、中の者が見えない（草の向こうは見える）。胞子嚢（`core:spore_pod`。通れない地物）は、隣で interact（突く）か投げた物が当たると弾け、周り 1 マスの者に毒の雲の効果（毒 1d4+2 手番）を与え、周り 1 マスの通れる空きマスに毒の雲（`core:spore_cloud`。入ると毒）を 3 手番残す。周り 8 マスが通れるマスに 4 つ置く。
- **沈んだ書庫（地下 6 階から。重み 6）**: 本棚の塊が多い（7%・8 塊）。本棚は通れず視線を遮り、move で押すと、向こうのマスが空いた床（者・物・地物・扉・階段が無い）なら 1 マス動き、押した者はその跡に入る（手番 150・音 4。`tile_changed.reason: 'push'`）。床に残り頁（`core:loose_page`。区分 `page`）を 2〜4 枚置く。読むと（use_item）周り 10 マスの地形が分かる（効果 `map` の `radius`）。レバーと格子扉も 1 組。
- **観測と規則の文**: 地物は今までどおり `visible.features`（状態つき）と look の説明。valid_actions の interact にレバーと胞子嚢が出る（公開カタログの `interactable`）。公開カタログの地形に `moveCostPct`。get_rules にバイオームの仕掛けの 1 項目。到着の文はバイオームの `desc`（初見の描写。V3-5d）。

## 34. ランをまたぐ積み上げ V3-7（IMPROVEMENTS_V3 §7・§16.3）

設計は IMPROVEMENTS_V3 §7・§16.3、実装メモは同書 §50。`engineVersion` 0.22.0、`eventVersion` 16（出来事の種類は増やしていない）。§8（他のプレイヤーの痕跡）は §16 の決定どおり作らない。

- **プロフィール**（World の外）: サーバーが `runs/profiles/<id>.json` に持つ（`MUSE_PROFILES_DIR` で変える。`runsDir` が null ならメモリだけ）。ファイルには `profile_token` の SHA-256 だけを残す。`new_run`・`join_run`（HTTP の `POST /api/runs`・`/join` も）の任意の `profile_token` で引き、省くと作って応答で 1 度だけ返す。知らないトークンは拒否する（`no_session`。黙って別のプロフィールに積まない）。参加コマンドにはプロフィールの **ID** だけを入れる（`JoinCommand.profile`。commands.jsonl に残り、トークンは残らない）。RunSession は参加コマンドから「プレイヤー → プロフィール」を持ち、復元のときも作り直す。
- **ランの記録**（`ProfileRun`）: 参加・遠征の終わり・ランの終わりのたびに（RunSession の確定の中、`SessionDeps.profiles.onCommit`）、そのプレイヤー本人の知識（`monsterMemory`・`identified`・`archive`・`guardianIntel`・`wardenIntel`）、本人の出来事（`inscription_read`・`room_found`）、本人の遠征レポートから作り直して上書きする。他人の情報・シード・未探索は入らない。中身は職業・継承の有無・確定点・最深・レベル・遠征の数（達成・撤退）・倒した節目・続けて達成した最長・遠征 1 回の自己最高（深さ・確定点・余力）・図鑑。
- **図鑑**: 6 分類で、項目はコンテンツから数える。種族（遭遇で埋まる）・品（未鑑定の見た目がある種類を鑑定したら）・遺物（記録庫に納めたら）・守護者の型（見たら。守護者の思い出に `types`）と弱点（分かったら）・断章（碑文と書き置きを読んだら）・特殊部屋（見つけたら）。完成度は全ランの和で「見つけた/全部」（いまは 62）。種族には遭遇・撃破の合計、体力の記録、受けた最大の一撃、能力を添える。
- **記録**（`records`）: ランの数（継承あり・なし）、確定点（ランの合計）の最高と平均（継承の有無で分ける）、最深、達成した遠征、倒した大守護者、死因の内訳（上位 5）、直近 5 ラン、図鑑、実績、次の節目（どのランでも倒していない最も浅い大守護者・図鑑・実績）、遠征 1 回の自己最高。キャンプの観測には 1 行（記録の要約と次の節目）。
- **継承**: 参加のとき、サーバーがプロフィールの**このラン以外**の記録（終わったランと、進行中の別のラン）の図鑑から、`balance.legacy.minKills`（5）以上倒した種族の知識（`LegacyMonster`: 能力・体力の記録・受けた最大の一撃・射程）を作り、参加コマンドの `legacy` に入れる。engine の `joinPlayer` がそれを思い出（遭遇・撃破は 0 から、`legacy.kills`）に入れ、`PlayerRecord.legacy { kinds }` を付ける。推定残り HP・脅威度・fight の止まり方（受けた最大ダメージがある種族は記録あり）に、そのまま効く。recall・look の文は「覚え書きより」で始める。外見・弱点・地図・強さは引き継がない。サーバーの `legacyPolicy: 'off'` か `legacy: false` なら付けない。再実行とリプレイは参加コマンドだけを読み、プロフィールのファイルを読まない。図鑑を作るときは、継承した体力の記録の数を引く（二重に数えない）。
- **実績**（`feats.json`、32 個）: 条件は `FeatContext`（`report.*`・`expedition.*`・`run.*`・`profile.*`）のパスと比較の式（`all`・`any`・`{ path, op, value }`）。遠征が終わるたびに（その遠征のレポートで）、参加とランの終わりに（レポート無しで）、取っていないものを判定し、プロフィールに残す（ラン・遠征の番号）。強さには影響しない。`hidden` は取るまで条件を伏せる。取った遠征の後のキャンプに「新しい実績」。
- **目標の比べる相手**（§40.8）: 自己最高を「このランの遠征レポート」と「プロフィールの前のランまでの遠征 1 回の自己最高」の大きいほうにした。型に `codex`（図鑑の数）・`feats`（実績の数）を足した（期限 1〜3 回。候補は今の数 +2／+4／+6、+1／+2／+3。判定はプロフィールの数）。
- **読み取り口**（`ProfilePort`）: 記録（`records`）・表示名と進行中のラン（`info`。`run_id` だけ）・表示名の変更（`rename`）。MCP の `records`・`profile`、HTTP の `GET /api/profile`・`GET /api/profile/records`（`Authorization: Bearer <profile_token>`）、人間の画面（ロビーの「記録と図鑑」）が同じものを使う。
- **表を分ける**: ランの要約の `players[].legacy`、リーダーボードの `legacy`、ロビーの表（継承ありは別の表）。
- **ホスト駆動**: `npm run drive -- --new-run <name> --profile-token <tok> --continue`（ランが終わったら同じプロフィールで次のラン。`--max-runs` 既定 10、`--no-legacy`）。

### 34.1 最後の AI 評価で直したこと（IMPROVEMENTS_V3 §52）

`engineVersion` 0.22.1、`eventVersion` 17。テストは `packages/tools/test/v3final.test.ts`。

- **宝物庫に入れる**: 部屋（prefab）を置くとき、縁の扉・格子はどれも外側の隣が通れるマスでなければならず、縁の床と合わせて外へ通じる入口が 1 つ以上要る（`entrancesOk`）。さらに生成の検査 `vaults_reachable`（すべての階に暗黙に）: 鍵のかかった格子扉は、到着地点から歩いて隣に立てる。部屋の後に置く瓦礫などで道が切れた階は作り直す。生成だけの数え（100 シード × 地下 1〜18 階）で、届かない格子扉は 59/141 → 0/142。
- **自分の能力値の変化を本人に渡す**: `stats_changed`（自分のものだけ）をプレイヤーに渡し、遠征レポートの最大 HP に使う（特技・加護・装備で最大 HP が変わっても、場面の「HP 16/63」がずれない）。このため `eventVersion` 17。
- **思い出の速さ**: 速い・遅いは、種族の印ではなくその個体の速さから付ける（大守護者は速さの下限で遅くない、俊敏な個体は速い）。図鑑の種族で速いと遅いが並ぶときは「速さは個体で違う」。
- **マクロの「初見の種族」**: 守護者として見た種族も見た種族として数える（思い出のキー `guardian|種族` ではなく種族で）。大守護者が見えるたびに steady・careful が止まらない。
- **文と表示**: ソロで「仲間が見つけた」と出ない（出来事のプレイヤー ID と、自分のプレイヤー ID を比べる）。hp_risk の提案は、最悪の 1 手を受けても 1 以上残るときだけ値を出し、そうでなければ「倒れうる」。引退の応答にランの確定点の合計。振り返りの戦闘の行に最も下がった HP。未鑑定の手がかりは、組の片方を鑑定済みなら「…のはず」。look は見えていないマスの覚えている地物・アイテムも読む（賭けの祭壇の表も）。脆い天井の崩落・胞子嚢の破裂の文、持ち主の無い効果のダメージは「何かが」ではなく受けた側の文。加護の候補の数は、まだ持っていない加護の数まで。逃げ道の「あなたより速い」は加速を含むいまの速さと比べる。1 手の結果の文に、倒した文は必ず入れる。マクロが品のマスで止まったら「足元の X はまだ拾っていない」。
- **階の異変の文**（§51.3 の「2 体とも同じ物が分からなかった」）: 到着の文に、意味の手がかりを足した（深い眠り「…ひとつ騒ぎが起きれば階じゅうが目を覚ましそうだ」、溢れた宝「…宝が多そうだが、物音に寄ってくる者も早そうだ」など）。効き目は変えていない。
- **規則の文**: 遠征の条件は「目標階までのまだ生成していない階」に効く（前の遠征で行った階は、敵・宝・泉もそのまま）。
- **人間のキャンプの画面**: 記録の 1 行（AI のキャンプの観測と同じ文。§51.4）。

## 35. 最後の見直し V3-8（IMPROVEMENTS_V3 §53）

設計は IMPROVEMENTS_V3 §53、実装メモは同書 §54。`engineVersion` 0.23.0、`eventVersion` 18。テストは `packages/tools/test/v38.test.ts`。

### 35.1 守護者の重い一撃（§53.1）

- 格 2 以上の守護者と大守護者は `GuardianInfo.heavy`（生成のときに付ける。再挑戦の守護者は前のまま）。その者の攻撃（近接の会心でない一撃・射撃・突進・大振り。突進と大振りの倍率は装甲を引いた後に掛かる）は、受けるダメージ = max(一撃 − 装甲 − 構え, 一撃の半分の切り上げ)。会心は前から装甲を無視するので変わらない。
- 見れば分かる特徴 `heavy_blow`（観測の `traits`、候補の見込み、look）。候補の一撃の目安に「装甲で減っても N より下がらない」。最悪の被害・hp_risk・推定は受けた一撃の記録から作るので、この規則の後の数字になる。

### 35.2 深い階の目的（§53.2）

- 目的の種類に `slay_bounty`（目標の階の賞金首を倒す）と `open_vault`（目標の階の施錠された宝物庫の格子扉を開ける）。`balance.expedition.typePct` は 110・105。
- 候補: 目標が地下 6 階より深く、踏破になった枠は、踏破・賞金首・宝物庫から等しく引く（乱数は `seed|expedition|no|deep|i` の別の流れ。ほかの候補を動かさない）。直前の遠征が踏破なら踏破は引かない。賞金首と宝物庫はまだ生成していない階だけ（賞金首は、その階に目的の賞金首が残っていれば再挑戦）。
- 賞金首の種族・接辞・名前は候補で決める（`ExpeditionOffer.bounty`。乱数 `seed|expedition|no|bounty|i`。候補には種族名・接辞名・体力の目安・一撃の目安・装甲・通る目安）。生成では目標の階に異変「賞金首」を必ず付け、その強敵にする。宝物庫は目標の階に必ず置く（置けなければ作り直す）。
- 進捗: 賞金首は `Expedition.targets.bounty`（その個体の ID）が倒れたら `guardianSlain`。宝物庫は、生成のときに数えた施錠の格子扉の数（`targets.vaultLocks`）より今の数が減ったら `progress.vaultOpened`。
- 再挑戦の賞金首（`rechallenge.bounty`）は、守護者と同じく、遠征の開始時に階に残り、キャンプの間に傷跡の分を残して全快し、落ち着く。繰り返しの減点は掛けない。

### 35.3 居座る強敵と傷跡（§53.3）

- 遠征の開始時に、目的でない未討伐の名前付きの強敵も、守護者と同じく去る（`guardian_departed.elite`）。その強敵が道を持っていた階（異変「賞金首」「番人の巡回」）の異変も消える（`floor_event_cleared`）。
- 傷跡（`Entity.scar`）: キャンプから遠征を始めるとき（全階の守護者を落ち着かせるところ）に、`scar = min(最大体力の半分, 前の傷跡 + 切り捨て(今の傷 ÷ 4))`（今の傷 = 最大体力 − 前の傷跡 − 今の体力）を残し、最大体力 − 傷跡まで戻す。遠征の中の休み（離れている間の回復）は傷跡を増やさず、最大体力 − 傷跡までしか戻らない。候補の `scar` は同じ式の見込み。大守護者・再挑戦の守護者・賞金首に効く（ほかの守護者は去る）。
- 候補の注記（PlayerPort）: 「前回（遠征 N）は与 A・被 B。傷跡で体力 −S」。賞金首の戦いは本人の遠征レポートの `combat.bounty_fights`（その遠征の目的の賞金首だけ）。
- 強敵の look に接辞の中身（`affixes.json` の `monsterMods` を公開カタログに出した）。
- 投げた物の在りか: valid_actions の extract・階段・帰還の綱の行に「投げた物が N 個、この階の床に残っている」（見えている・覚えている自分の投擲物の数。止めはしない）。投げて戦った fight の結果に「投げ物: 手元 N・床に M（うち敵の足元 K）」。

### 35.4 マクロ（§53.4）

- 速い敵の数え直し: 自分の 1 手番の間に見えていた敵が何回動いたかを数え（`Ctx.actsSeen`。World の外）、2 回以上動いた敵を自分の手番の初めに `pace_seen { player, ids, turn }` で知識に残す（`Knowledge.paceSeen`）。PlayerView に `paceAgo`（見てから過ぎた自分の手番）。`attacksPerTurn` は、速さの比の切り上げが 2 で、c = 切り捨て(10000 ÷ 敵の速さ)・P = 切り捨て(10000 ÷ 自分の速さ) について `paceAgo < 切り捨て((2c − P) ÷ (P − c))` なら 1 回と数える（速さ 120 と 100 なら 3 手番。総当たりで、この間に 2 回動けないことを確かめた）。見ていない敵・比が 3 以上の敵は今までどおり。worst_turn・lethal の警告・fight の hp_risk がこれを使う。
- collect の `within`（既定 15。残りがどれも遠ければ `collect_far`）・`kinds`（種類 ID か区分）・`all`（記憶の装備で、種類の素の性能が今の装備と同じか劣るものも拾う）。
- fight が離れたまま撃つ標的で止まるときは `target_shooting`（当てて離れる `hit_and_run` と分けた）。
- 実装担当の判断で入れたもの: use_item の slot に正体の分かっている品の種類 ID（MCP の層でスロットに読み替える）、呪いと分かっている品の equip に `confirm`（人間の画面は確認の窓）。潜む者の状態の表示と加速の残りは入れていない。
- 予備動作を自動でよける fight は入れない（§53.4）。

### 35.5 目標の宣言を外した（§53.5）

- 外したもの: `declare_goal`、`shared/goals.ts`、キャンプと `expedition` の目標の行、遠征レポートの `goal`、WS の `goal`、人間の画面の目標の箱、`goals.jsonl` の読み書き（古いランに残っていても読まない）。
- キャンプの記録の行（`camp.records.line`）は、そのランで 1 つも遠征を終えていない最初のキャンプで、プロフィールに前のランの記録があれば「前のランまで: 確定の最高 N・最深 地下M階（K ラン）。」で始まる。

### 35.6 人間の画面（§53.6）

- キャンプの候補のカードに、賞金首の見込み・宝物庫の 1 行・傷跡（AI の候補の文と同じ文）。観戦の要約の進捗に賞金首と宝物庫。

### 35.7 確認の評価で直したこと（IMPROVEMENTS_V3 §55）

`engineVersion` 0.23.1、`eventVersion` 19。テストは `packages/tools/test/v38eval.test.ts`。

- **見つけた部屋の場所**: `room_found.at`（見つけたときに見えた、部屋の範囲の通れるマス）。文に方角と歩数を添える（「「賭けの祭壇」を見つけた（発見。東・5 マス先に部屋の一角が見えた）。」）。部屋の中の地物は、見えるまで出さない。
- **呪いの判定の文**: `item_inspected.affixes`（確かめた後の接辞）で、接辞付きの名前にする（「補強された革鎧に呪いは無い。」）。
- **静寂の指輪の短い説明**: 「自分の立てた音（攻撃・扉・投擲）で、眠っている敵が必ず起きる」。効き目は変えていない。

### 35.8 V3-8a（IMPROVEMENTS_V3 §56.1）

実装メモは IMPROVEMENTS_V3 §57。`engineVersion` 0.24.0。テストは `packages/tools/test/v38a.test.ts`。**これで土台（V3-1〜V3-8）は完成とした。**

- **守護者の候補**: `ExpeditionOffer.guardian.armor`（装甲の目安: 種族 + 深層強化の段の半分 + 守護者の接辞 + 候補の接辞。型の効果は除く。`monsterArmorEstimate`。賞金首も同じ式）。見込みの文に「装甲はおよそ N」、キャンプの候補の文と人間の候補のカードに「いまの持ち物で 1 回に通る目安」（大守護者は記録庫の記憶の装甲で、今までどおり）。
- **規則の文**: 枠は目標の遠さと見返りを表し、危険は候補ごとの見立て（推奨レベルとの差・一撃・通る目安）で読む。
- **マクロ**: `macroNext` は、止まる判断が出たとき、collect（what: items）か品を目的地にした travel_to で足元にその品があれば、拾う 1 手を挟んでから止まる（`MacroState.pendingStop`。hp_floor・hp_risk・予備動作では挟まない）。steady の explore・travel・collect は、その呼び出しの被害の合計（`MacroState.damageTaken`）が最大 HP の 4 分の 1 を超えたら `damage_taken`。
- **地物の ID**: 観測の `visible.features[].id`。travel_to の目的地に地物を指すと、隣に着けば到着。
- **加護の説明**: ターンの要約に、説明を出した加護の組（`boonKey`）を持ち、組が変わったときだけ説明を出す（それ以外は名前だけ）。

## 36. Muse の報告への判断 V4-0（IMPROVEMENTS_V4 §1）

### 36.1 V4-0a（IMPROVEMENTS_V4 §1.1・§1.3）

実装メモは IMPROVEMENTS_V4 §2。`engineVersion` 0.25.0、`eventVersion` 20。テストは `packages/tools/test/v40a.test.ts`。

- **不変条件**: 倒した記録の無い節目の階が生成済みなら、そこには生きている大守護者がいる。遠征の開始時（`startExpedition` の最初。候補の番号を確かめた後）に `restoreMilestoneFloors` が確かめ、破れている階を `floor_reset { floorKey, depth, reason: 'warden_missing', guardianName }` で捨てる（階のエンティティと、敵が持っていた品は `del`。reducer は階と、全員のその階の `knowledge.floors`・`floorHint` を消す）。プレイヤーの体がその階にあれば作り直さない。再開する地点がその階のプレイヤーは、その場で `ensureFloor` し、上り階段へ `extractPos` を移す（`player_state` の `reason: 'floor_reset'`。文は出さない）。それ以外は、次に着いたときに今の生成で作る。
- **生成**: 節目の階は fallback でも大守護者を置く（目印が無ければ下り階段に近い、ほかの敵のいない通れる床。探す範囲は階の全体）。`placeWarden` が置けなければ、fallback 以外は作り直し、fallback は例外。
- **封印の判定**: shared の `isMilestoneOf`・`stairsSealed`（節目の深さで、倒した記録が無い）。engine の `sealedFloor(ctx, key)` が包む。規則（stairs・reach_depth の到達・踏破・封じられた階段での帰還の位置）と表示（valid_actions・次の階の封印の注記・帰還の文・次のキャンプの目標）はこれだけを呼ぶ。`livingWarden` は作り直しの検査だけに使う。
- **地形の表**: `ensureFloor` は階を作る前に、今のコンテンツの地形のうちランの表に無いものを `terrain_table_extended { added, concealAdded }` で表の後ろに足す（古い版で始まったラン）。`wardenPreview` は階を作らないので、足した表で生成するだけ。
- **伝える**: `floor_reset` の文「地下N階は姿を変えた。大守護者「名前」の間になっている（その階の地図と記憶は消え、床に残していた品は失われた）」は、開始の応答の outcome と、ターンの要約の changes（`floor_reset`。先頭）に出る。get_rules の節目の文にも 1 文。
- **レポート**: `buildExpeditionReport` の大守護者との戦いは、`wardenIds`（呼び出し側が World の大守護者と履歴の `warden_slain` から渡す）と、その遠征の `warden_slain` の個体だけ。階の深さでは決めない。

### 36.2 V4-0b（IMPROVEMENTS_V4 §1.2・§1.4・§1.5）

実装メモは IMPROVEMENTS_V4 §3。`engineVersion` 0.26.0。テストは `packages/tools/test/v40b.test.ts`。

- **版をまたぐラン**: サーバーは続いているランを読んだとき、作られた版が古ければログに不整合を書く（engine の `checkRunGaps`。World は変えない）。キャンプの観測に「このランは古い版で始まった（engine X）。階の一部が姿を変えることがある」を最初の 1 度だけ（`TurnSnapshot.versionNoted`。サーバーのメモリ）。遠征の開始時に `syncTerrainTable`（地形の表と `concealTerrain` を今のコンテンツに合わせる。`terrain_table_extended` の `concealAdded` は今までの番号も入れられ、reducer は重ねない）。
- **explore の風の方角**: 新しい行き先を選ぶとき、風の方角の境界への道が、方角を問わない近くの境界への道より `DRAFT_DETOUR`（12）歩を超えて長ければ、近くを先に見る（立つ位置で方角が変わり、遠い 2 つの境界を往復していた）。
- **explore の遅い追跡者**: careful の explore は、自分より遅く（`speed` が自分より小さい）3 マス以上離れた、射撃しない追跡中の敵の出現・追跡への変化では止まらない（`MacroState.slowChasers`）。その敵が 2 マスに来たら `chaser_near`。結果に「遅い敵 N 体に追われたまま探索した」（`MacroReport.slowChasers`）。
- **fight の見失い**: 待つのは `fightLostWait`（5）手番まで。ほかに届く追跡中の敵が見えている手番・被害を受けた手番は待たずに `target_gone`。見失った・逃げられたときは、結果に最後に見た場所（記憶の位置）。
- **断る文**: explore の `hostile_adjacent` は「振り切るなら flee、戦うなら fight」。fight の `target_moved`（始めた時点で標的が逃げている）は「見えているが、逃げている」。
- **表示**: 会心のとどめの「倒した」の行（「会心 12。残り 5 を倒した」）。collect の「遺物は対象外」。深追いの文（「深追い: 地下N階の下り階段に着いた…次は地下N+1階の下り階段で +Y」）。推定残り HP（傷の無い相手は「体力の記録」、下限だけのときは根拠。`HpEstimate.untouched`）。種族の体力の記録は素の個体の範囲であることを添える。get_rules の shot は応答の時点の判定で、敵の射撃も同じ判定。

### 36.3 V4-0c（IMPROVEMENTS_V4 §4）

実装メモは IMPROVEMENTS_V4 §5。`engineVersion` 0.27.0。テストは `packages/tools/test/v40c.test.ts`。

- **規則**: 背の高い草の中の者は隣からしか見えず、攻撃しても隠れたまま（プレイヤーにも敵にも）。草の中の見えない者からの攻撃は方角（`fromDir`）だけが伝わる。草の中のプレイヤー（隣でない）に攻撃された敵は起きるが、居場所は受け取らない（音の届いた先へ向かう）。
- **判定は 1 つ**: shared の `inCover`（`meta.concealTerrain` の中で、隣でない）と `actorSeen`（マスが視界にあり、`inCover` でない）。engine の `Ctx.seesActor`・`seesActorAt`。表示のリスト・知識の更新・出来事の伏せ方（`perceive` は者の主体だけ草で隠す。`tileSeen` の行為者も）・`monsterSees`・投擲と攻撃の標的・種族の思い出・そのほか「見えている者」で決める判定が、すべてこれを使う。
- **移動の知覚**: `Ctx.perceiveMove`。見えていた者が草に入る移動は行き先も伝える（主体の `enterFrom`）。草から草へ・見えていない者の移動は伝えない。
- **種族の思い出**: 受けた被害・与えた被害・被弾と命中の記録・射撃の能力は、相手が見えているときだけ。
- **表示**: get_rules の苔むした遺跡の文。マクロの停止の理由に「東から撃たれた。相手は見えていない。」。alerts `unseen_shooter`（最悪の被害の見立てに入っていない）。見えなくなった敵の最後に見た位置に「背の高い草の中」。
- **ターンの要約の変化**: 文になった出来事に加えて、知覚した他の者の移動（`RunSession.movesSince`）から、見えなくなった敵の最後に見た位置と向きを作る。fight は標的を最後に見た場所を覚え（`MacroState.targetSeenAt`）、見失って止まったときの結果に書く。

### 36.4 V4-0d（IMPROVEMENTS_V4 §6）

実装メモは IMPROVEMENTS_V4 §7。`engineVersion` 0.28.0。テストは `packages/tools/test/v40d.test.ts`。

- **体力の目安の幅**: 格 1〜3 の守護者と賞金首の候補は、体力の目安（ダイスの平均）に幅（ダイスの最小と最大）を添える。3 つとも生成と同じ式（上乗せ・下限）に通す。`ExpeditionOffer.guardian.hpRange`・`bounty.hpRange`。文は「体力はおよそ 20（9〜32）」（幅が 1 点なら括弧なし）。大守護者は今までどおり幅だけ。通る目安は平均で数える。
- **深層強化の段は 1 つ**: engine の `deepTier`。生成（普通の敵・守護者・賞金首・巡回の強敵）と候補の目安が使う。賞金首（目的・異変）と巡回の強敵も段を受ける（V4-0c までは 0 だった）。

### 36.5 V4-0e（IMPROVEMENTS_V4 §8）

実装メモは IMPROVEMENTS_V4 §9。`engineVersion` 0.29.0、`eventVersion` 21。テストは `packages/tools/test/v40e.test.ts`。

- **遠征の条件は 2 種類**: その遠征の間だけ効くもの（騒がしい・薄暗い・静かの「徘徊なし」）と、階を作るときに効くもの（群れる・乏しい・静かの「泉なし」。目標階までの、この遠征で初めて入る階）。後の種類は作られた階にずっと残る。
- **階の性質**: `Floor.genTraits`（その階を作ったときに効いた、階を作るときに効く条件）。新しい階には必ず付く（無ければ空）。古い版で作った階には、遠征の開始時と候補を作るときに `floor_traits_noted` で足す（階に残っているモンスター・地物の最も古い sid が入る遠征から。者がいなければ、その深さに初めて届いた遠征）。見せる名前と危険度はデータ（条件の `floor`）。
- **見せるところ**: 着いたときのターンの要約、観測の `self.floor.traits`・`trait_text`、状態の行の「この階:」、人間の画面の「この階」。候補には目的の階と通り道の階（再開する階から目的の階まで）のうち作られていて性質のある階（`ExpeditionOffer.floorTraits`。「通り道の地下 13〜16 階は群れている」）。群れている階があれば、候補に同じ条件が無いときに限り危険度 +1（`offerGap` の extra）。倍率は付かない。まだ作られていない階については何も言わない。
- **条件の付け方**: 階を作るときだけに効く条件（群れる・乏しい）は、目的の階がまだ作られていない候補にだけ付く。
- **遠征の間の落ち着き**: 遠征の開始時に、作られているすべての階（盤面にいる参加者の階を除く）の敵が落ち着く（追跡・予備動作をやめる、全快、状態異常を消す、見た被害の記憶を消す）。守護者と再挑戦の賞金首を先に落ち着かせるので、傷跡はどの階でも残る（今までは再開する階だけ、先に全快させて傷跡を消していた）。離れた場所へ移すのは、再開する階で再開するマスが見える敵だけ。
- **見た被害**: `damage_seen` の日本語の名前は「見た被害」（見ている間にその個体が受けた被害の合計。罠やほかの敵の分も入る。遠征をまたぐと消える）。

## 37. 音（SOUND_SPEC.md §12）

状況に連動する音楽。演出だけの層で、情報を運ばない。AI のプレイヤー・サーバー・MCP・エンジン・World は変えていない。

- **音の状態**: shared の `soundStep`（視界 `PlayerView` と、そのプレイヤーに届いた出来事と、公開のカタログと、前の記憶だけから作る純粋な関数。World を受け取らない）。状態異常の良し悪しはデータ（`statuses.json` の `tone`）。
- **鳴らす仕組み**: client の `sound/`（Web Audio）。定義は音のテーマの `sound.json`（形の版 1 ＝ SOUND_DIRECTION.md §9・§17）。同時に鳴る音は 16 まで（新しい音を置くたびに、ほかの音を早めに止める）。場面は 1 秒続いてから切り替える。合図は 0.15 秒以内の重なりを 1 つに。
- **テーマ**: `themes/index.json` の `kinds`（image・sound）。既定は無音。上の帯の「音」で選び、端末に覚える。
- **画面**: 遊ぶ画面は届いた視界ごと（マクロは 1 歩ごと）、観戦・リプレイは選んでいるプレイヤーの視界から。テストは `packages/tools/test/sound.test.ts`・`packages/client/test/sound.test.ts`。

## 38. 代行 bot の作例 pilot（IMPROVEMENTS_V4 §10・§11）

AI のプレイヤーとゲームの間に置く常駐のプログラムの作例。ゲームの側（エンジン・サーバー・プロトコル・観測）は変えていない。pilot はただのプレイヤーで、同じ命令を同じ口（MCP）から出す。

- **形**: AI は `orders.json`（方針・1 回きりの命令の `queue`・`mode`）を書くだけで、ゲームに直接命令を出さない。pilot は `state.json`（観測の写しと自分の状態。文は観測の行をそのまま）と `log.jsonl` を書き、判断が要るときに起こす（コマンド・HTTP・無し）。起こした相手の終了は待たず、`rev` の変化だけを待つ。ソロは止まって待ち、協力プレイは持ち場の動き（退く・隣の敵に 1 回攻撃・仲間の方へ 1 歩・待機）で毎手番すぐに答える。
- **判断の表**（`decide.ts`。観測の `alerts`・マクロの止まった理由・構造化された項目だけから決める純粋な関数。規則の知識は持たない）: 役割のある敵・遺物・特技と加護・HP・追ってくる敵の数で起こし、追ってくる役割の無い敵とだけ戦い、目的の階へ下り、拾い、探索する。移動の道具が断られたら、その手番は表の次の行へ。何も残らなければ起こす。
- **くり返しの上限**: 同じ手番に同じ起こし方が続く・同じ命令が同じ止まり方で 4 回止まると `stuck`。`stuck` も続けば安全装置で終える。
- 置き場所は `packages/tools/src/pilot/`（文書は同じフォルダの `README.md`）。起動は `npm run pilot`。テストは `packages/tools/test/pilot.test.ts`。計測と、観測に足りない項目の報告は IMPROVEMENTS_V4 §11.2・§11.3。

### 38.1 V4-1a: 観測の足りない所（IMPROVEMENTS_V4 §12・§13）

pilot を作って分かった、構造化された項目だけでは決められない所を、すべてのプレイヤーに同じに渡る形で足した（`engineVersion` 0.30.0）。

- **拾える品**: 観測 `navigation.collectable { count, ids }`（引数なしの collect が拾いに行く品。collect と同じ経路・既定の範囲 15 歩。数え方は shared の `collectTargets` 1 つ）。`valid_actions` の collect の件数もこれ。
- **目的の印**: 視界の投影で、この遠征の目的の守護者・大守護者・賞金首・遺物に `objective: true`（`objectiveEntityIds`）。文と人間の名札に「［目的］」。
- **じゃまをしている敵**: マクロの拒否（`hostile_adjacent`・`blocked`）の `details.blocked_by`（見えている敵だけ）と hint の名前。
- **封じられた階段**: `known_stairs[].sealed`（`stairsSealed`）。
- **寄っていく fight**: `fight { approach: 'advance' }`（既定 `wait`）。歩く間に撃たれても止まらず、hp_floor・hp_risk などはそのまま。人間の画面に「戦う: 待つ／寄る」。
- pilot: 方針の `approach` を fight に渡す。目的でない遺物・役割のある敵は 1 回知らせるだけ。封じられた下り階段へは下りない。拾う品は `collectable`。

### 38.2 V4-1b: pilot の見直し（IMPROVEMENTS_V4 §14・§15）

§10 の「判断しない。迷ったら起こす」を改め、決められることは pilot が決めて知らせ（notify）、AI にしか決められないこと（キャンプ・目的の相手・退く手の無い危険・行き詰まりなど）だけ起こす（wake）。規則の知識は持たないまま（観測の構造化された項目と、pilot 自身の記録だけ）。ゲームの側は変えていない。

- **決着しない戦い**: 相手ごとに「決着しない」止まり方を数え、`approach: "auto"`（既定）なら寄ってやり直し、`give_up_after`（既定 2）回でその階では相手にしない（目的の相手は起こす）。相手にしない敵がいる間は `steady` で進む。探索も撃破も進まない命令が 8 回続いたら `stuck`。
- **立て直しの段**: HP が減ったら起こさずに、休む → 階段へ行って階を移って休む（同じ階で 2 回まで）→ 隣の追跡中の敵を殴る → 仲間へ寄る → 来た道を戻る → 退く → 起こす。逃げる間の HP の下限は、見えている敵の最悪の被害から決める。
- **起こして待つ間**: ソロでも協力プレイでも、隣の追跡中の敵を殴る・隣でない相手から撃たれたら留まらない。`hold_max_turns` の後は `no_reply` を 1 回知らせて、階段へ行って帰る側へ。
- 方針に `approach: auto`・`give_up_after`・`engage_objective`・`perk`・`after_objective: extract`（既定）/`continue`・`retreat_via_stairs`・`queue_on_fail`・`ignore`・`unignore`、`mode: stop_at_camp`。state.json に `hostiles`・`stairs`・`target`・`ignored`・`recovering`・`camp`（候補）。queue は敵のせいの拒否をやり直し、失敗は知らせるだけ。
- テストは `packages/tools/test/pilot.test.ts`。計測（ソロ 10 本で起こす回数はキャンプを除き遠征 1 回あたり 1.13、協力プレイ 5 本で 1 本倒れた）と、設計で決めてほしいこと（返事が無いときの回復）は IMPROVEMENTS_V4 §15.2・§15.3。

### 38.3 V4-1c: 回復の手段（IMPROVEMENTS_V4 §16・§17）

- **観測 `self.recovery[]`**（すべてのプレイヤーに同じに渡る。`engineVersion` 0.31.0）: 使うと自分の HP が回復する能動技と、正体の分かっている品。効果の定義から決める（品は `onUse` の `heal`、能動技は最大 HP の割合の回復。公開のカタログの `heal`）。未鑑定の品は、視界の投影で種類が伏せられているので入らない。`ready` は能動技の「使える」と同じ、`amount` は説明の文。
- **pilot の `allow_heal`**（既定 true）: 能動技は立て直しの最初に、品は倒されうるのに退く手が無いときだけ使い（`healed` を知らせる）、品を使ったら起こす。目的の相手は HP の止まり方も数えて 2 回で起こす。立て直しで守護者と殴り合わない。
- 測り直し（協力プレイ 5 本で 1 本倒れた・品を 4 回使った）と、設計で決めてほしいこと（返事を待つ間に撃ってくる相手から離れきれない）は IMPROVEMENTS_V4 §17.3・§17.4。

### 38.4 V4-1d: 道をふさぐ罠・離れて撃つ敵（IMPROVEMENTS_V4 §18・§20）

- **エラー `details.blocked_by_traps: { id, kind, pos }[]`**（すべてのプレイヤーに同じに渡る。`engineVersion` 0.32.0）: マクロが発見済みの罠の手前で 1 歩も進めずに `blocked` で断るとき、道の上の罠を近い順に。hint に罠の名前と位置と `move { dir }`。マクロの道は射影の中の罠だけを避けるので、見つけていない罠は入らない（`v41d.test.ts` の漏洩テスト）。マクロが罠を踏まない決まりは変えない。
- **pilot**: `state.json` の `traps[]`（公開カタログの分類で罠と分かる地物）、罠にふさがれて起こす・知らせるときは罠の行・位置・方角を `detail` の先頭に、方針 `step_on_traps`（既定 false。true なら隣の罠を 1 歩の `move` で踏んで `stepped_on_trap`）。
- **pilot**: 方針 `allow_throw`（既定 true）。離れたままの相手への、諦める前の最後のやり直しで、投げる武器（観測の `self.attack.throws` の種類を、公開カタログの分類 `throwing` で引く。名前では探さない。薬は投げない）を `fight` の `with` に渡す。`give_up_after` の既定は 3（待つ → 寄る → 投げる）。`shot_while_waiting` で止まったら、撃ってきた見えている相手（飛び道具の特徴を持つ追跡中の敵）を次の標的に、見えなければ来た道を戻る。

### 38.5 V4-1e: 上げる段・節目の大守護者・空回り・帰る（IMPROVEMENTS_V4 §19・§21）

ゲームの側は変えていない（pilot と返事役の見本だけ）。

- **起こす段 `escalate`**: プログラムの返事役が答えてはいけないもの（`warden_decision`・`stalled`・`safety`）。pilot の動きは `wake` と同じ。見本は答えない。
- **方針 `warden`**（`escalate`（既定）・`engage`・`avoid`）: キャンプで候補が大守護者に関わるものだけ・目的の階が封じられた階段の先・大守護者が見えた、のとき、その大守護者につき 1 回上げる。挑むと決まっていなければ挑まずに帰る。大守護者に関わる候補は `engage` のときだけ自動で選ぶ。
- **空回り**: `history.jsonl`（1 遠征 1 行。確定した点は結果の `payout`）で、直近の `stall_after`（既定 3）回がどれも確定 0 か 10 手番以内なら、次を始めずにキャンプで `stalled` を上げる。遠征の中で同じ理由の `wake` に同じ返事が 3 回続いたら、4 回目は上げる。
- **帰る**: `mode: "return"`（キャンプに着いたら同じ `rev` の間は `auto`）。帰り方の順は共通（階段の上で帰る → 着ける階段へ → 着けないときだけ綱 → 立て直し）。危ないときの「退く」も、着ける階段を綱より先にした。綱を使ったら `lifeline_used`。
- **目的でない遺物・守護者の知らせはランを通して 1 回**（`memory.json`）。方針 `pick_relics`（既定 false）。`memory.json` には済ませた `queue` の数も残し、起動し直しても済んだ命令を出し直さない。
- 測り直し（ソロ 10 本で 9 本が `stalled` で止まった。1 本倒れた）と、設計で決めてほしいことは IMPROVEMENTS_V4 §21.8・§21.9。

### 38.6 V4-1f: 仲間の情報・探す・仲間についていく（IMPROVEMENTS_V4 §22・§23）

- **観測 `party[]`**（すべてのプレイヤーに同じに渡る。`engineVersion` 0.33.0）: 自分以外の参加者の名前・人間か AI か・参加の順・迷宮にいるか・キャンプにいるか・倒れているか・抜けたか、迷宮にいれば階。位置・HP の段階・エンティティ ID は同じ階で見えているときだけ。仲間のいる階の地形・敵は渡さない（漏洩テスト）。ソロは空の配列。文に「仲間: …」の 1 行、人間の画面に「仲間」の欄。
- **エラー `details.still_inside`**: 仲間がまだ迷宮にいて `start_expedition` が断られるとき、だれがどの階にいるか（hint にも）。
- **pilot の「探す」**: 目的の階で目的の相手・品が見えていなければ、気配の方角へ探索し、大守護者なら封じられた階段の広間へ行き、探索し終えた階は見回る（この階で立ったことのあるマスの、遠い所から）。`seek_max_turns`（150）で見つからなければ `target_not_found`。
- **大守護者のもう一度の相談**: `warden: "engage"` の後、倒さずに `warden_retry_after`（2）回終わったら、もう一度 `warden_decision` を上げる（遠征ごとの結果つき）。
- **空回りの後**: `rev` を上げるだけで再開（数えは 0 に戻る）。
- **協力プレイ `coop`**: 人間の仲間（いなければ参加がいちばん早い仲間。pilot 同士はお互いを追わない）についていく。危ない・HP・敵への対応が先。ついていく間は自分から階を移らず、相手が帰ったら帰る。キャンプで、遠征の途中に仲間がまだ迷宮にいれば待つ（`waiting_party`。行き詰まり・空回りに数えない）。
- 仲間を待つ「待つ」（ついていく相手の近く・遠征の最初・キャンプ）は、pilot の命令の上限に数えない。代わりに、仲間が何もしないまま実時間で `coop.idle_minutes`（10 分）過ぎたら `party_idle` で上げる（自分からは帰らない）。
- 決まり同士がぶつかる所の詰め方と測り直しは IMPROVEMENTS_V4 §23。

### 38.7 V4-1g: 協力プレイの入り方・危ないときの順序・通信と記録（IMPROVEMENTS_V4 §24・§25）

- **途中参加はキャンプから**（すべてのプレイヤーに同じ。`engineVersion` 0.34.0）: 協力プレイのランに入った者は、遠征が進んでいてもキャンプに置き、次の遠征から一緒に出る。キャンプの文に「遠征 N が進んでいる（仲間がまだ迷宮にいる）。全員が戻ったら、次の遠征を選べる」。
- **参加者の種類**: `Controller.kind` に `unknown`。HTTP で `controller` を省くと `unknown`（ブラウザは `human` を送る。MCP は `agent`）。
- **仲間の HP**: `party[].hp` は、迷宮にいる仲間について、見えていなくても出す。位置とエンティティ ID は今までどおり見えているときだけ（漏洩テスト）。
- **協力プレイの確定**: `expedition.result` に `banked`（自分の分）・`party_banked`（合計）・`shares`（だれの分か）。帰った者の点は、全員が戻って遠征が終わったときに、そのときの共有の分（目的・踏破・発見・撃破・賞金）と、本人が持ち帰った宝で確定する（決まりは前から。文を合わせた）。
- **`valid_actions` の行は、書いてある形のまま呼べる**: 1 行の形は `<ツール> [<主な引数>] [<名前>:<値> ...] (<説明>)`。`use_ability` は `ability`（`id` も）。`fight` の `with`・`abilities` は並べた文字列（`[a,b]`・`a,b`）も受ける。全部の行を MCP で呼ぶテストがある。
- **地物の 1 行の説明**: すべての地物に `desc`（無ければ起動時の検査で落とす）。`visible.features[].desc`。初めて見たときの 1 行は、変化の上限で落とさない。
- **pilot**: 帰る途中・立て直し・階を出る間は、道をふさいでいる敵（断りの `blocked_by`）しか殴らない。逃げる手がまったく無いときだけ、隣で追ってくる敵を殴る（`cornered`）。相手にしないと決めた敵に撃たれたら階段で階を出て、その遠征では戻らない（目的の階なら `target_blocked`）。`danger`・`ended` は上げる段。協力プレイの `wait_for_join`・`assist`・`on_party_down`、終える前に帰る（猶予 3 分）。通信のやり直し（10 分）、起こした時点の写し `wakes/`、命令の理由 `why`。上げる段も、手番が進まないまま同じ上げ方に 3 回返事が来たら `stalled`。
- 詰めた解釈・測り直し・設計で決めてほしいことは IMPROVEMENTS_V4 §25。

### 38.8 V4-1h: 立て直しで殴ってよいとき・手が尽きても帰らない・階を出た後に 1 回戻る（IMPROVEMENTS_V4 §26・§27）

- §38.7 の「帰る途中・立て直し・階を出る間は殴らない」を場面で分けた。帰ると決めた後は殴らない（道をふさいでいる敵と、逃げ道がまったく無いときだけ）。立て直しの間は、隣でない相手から撃たれている間は殴らない（離れるのが先）。撃ってくる相手がいなければ、隣で追ってくる役割の無い敵は殴る（階段で階を移れないとき）。
- 立て直しは、手が尽きただけでは帰らない（自分から帰るのは `lethal_range`・`critical_hp` の「退く」だけ）。協力プレイでは、ついていく相手の所へ行く（`recover_ally`）。それ以外は `wake`（`recover_failed`）で、帰るかどうかは返事役か AI が決める。
- 相手にしない敵に撃たれて階を出た後は、休んでから 1 回戻る。同じ相手にまた撃たれたら、その遠征では戻らない。
- その後の小さな直し（§27.5）: 立て直しの 3 で殴るのはマクロの `fight`（`hp_floor` は `critical_hp` の線。倒す前に止まったら、その立て直しの間は続きへ）。返事役の見本は、協力プレイで仲間が迷宮にいるときの `stuck` に「帰る」と答えず、その遠征の 1 回目は戦っている相手を `ignore` にし、2 回目は答えない。
- ゲームの側は変えていない。測り直しは IMPROVEMENTS_V4 §27。

### 38.9 V4-1i: 設計どおりに動いていない所の直しと、危ないとき・仲間が倒れた後（IMPROVEMENTS_V4 §28・§29）

- **pilot は黙って止まらない**: 手番が進まない命令（断られた命令も）を数え、同じ決まりで 3 回続いたらその手番は使わず、全部で 6 回で `stuck`。キャンプに戻ったら迷宮での返事待ちはやめる。待つ理由（`waiting_join`・`waiting_party`）は知らせる。命令も知らせも 2 分出さなければ、いまの状態を添えて上げる（`safety`。pilot は終えない）。
- **危ないとき**: `danger` は、ソロでも協力でも命令の前に `escalate`（返事は待たない）。その遠征は帰る（綱は `allow_lifeline` に関わらず使ってよい）。協力では帰る前に 1 回だけ、同じ階のついていく相手の所へ寄る（見えていなければ最後に見た位置へ）。
- **仲間**: 倒れた仲間は「いる」に数えない。仲間が倒れたら、キャンプで `party_down` を 1 回上げて待つ。`party_idle` は待っているときに限らず数える（見え隠れは数えない）。助けに行く（`assist`）は、ついていく相手がいないときも、迷宮にいる仲間について働く。
- 逃げた相手には投げる武器でやり直す。トークンは `--token-file` か環境変数 `MUSE_PLAYER_TOKEN`。見本の返事役は、自分が変える項目だけを書き換える。
- `explore toward: sense` が、目的でない遺物を覚えているだけで止まるマクロの不具合を見つけた（V4-1i では直さず、pilot は方角なしで探した。V4-1j で直した: §38.10）。V4-1i ではゲームの側は変えていない。

### 38.10 V4-1j: 危ないときは薬が先・on_danger・協力で置いていかない・last_act・sense の断り（IMPROVEMENTS_V4 §30・§31）

- **ゲームの側**（`engineVersion` 0.35.0）:
  - 観測の `party[].last_act`: その仲間が自分で最後に行動した時点（その仲間の手番数）。World の `PlayerRecord.lastAct` から取る。`applyEvent` は、出来事 `actor_scheduled` の `acted`（エンジンが、プレイヤーが自分で出した命令で手番数が増えたときに付ける。時間切れの待機・サーバーが代わりに出した命令には付けない）で書く。見えていない仲間・別の階・キャンプにも出す。文と人間の画面には出さない。
  - `explore toward: sense` の `sense_found` は、この遠征の目的の相手・品（観測の `objective`。守護者は名前が目的と同じものも）を見ている・覚えているときだけ。
- **pilot**:
  - 危ないとき（`danger`）の帰り方: 階段の上 → 着ける階段 → 回復の手段（能動技が先）→ 綱（`allow_lifeline` に関わらず）→ 追われていても階段へ → 殴る。倒されうる状態でなくなった後の帰り道は `allow_lifeline` のとおり。
  - 方針 `on_danger`: `return`（既定。帰る）/ `recover`（1 回目は上げて、階段で階を移るか回復の手段で立て直す。どちらも無ければ帰る。2 回目は帰る）。
  - 挑むと決めた相手（`engage_objective`・`warden: engage`）が追ってきておらず離れていれば、先に `travel_to` で隣へ寄る（`fight` は追ってくる相手を待つ手）。
  - 協力プレイで、同じ階に仲間が生きている間は、立て直しのために階を移らない（見えていなくても。`retreat_via_stairs: true` なら移る）。
  - 自分が先頭でも、同じ階に仲間がいる間は先に階段を移らない（階段の上で仲間が隣に来るまで待つ。`hold_max_turns` まで）。だれについていくかを `following` で知らせ、`state.json` の `following` に書く。
  - `party_idle` は `last_act` で判定する（状態・階・位置で代えるのをやめた）。
  - 協力プレイで、ついていく相手（か、ついてくる相手）が重傷以下なら、立て直しの「休む」より先に助けに行く（自分の HP が減っていても。自分が倒されうるときだけ、危ないときの退く手が先）。先頭で待ち切って 1 人で階を移るときは `moved_without_party` を知らせる（IMPROVEMENTS_V4 §31.6 の答え）。

### 38.11 V4-1k: 通らない相手・fight_with・覚えている地図で探す・仲間の位置（IMPROVEMENTS_V4 §32・§33）

- **ゲームの側**（`engineVersion` 0.36.0）: 観測と PlayerView の `party[].pos` を、同じ階にいる仲間については見えていなくても出す（エンティティ ID は見えているときだけ。仲間のいる所の地形・敵・品は出さない）。人間の画面は、見えていない仲間の位置に暗い印を出す。
- **pilot**:
  - 通らない相手（§32.1）: `fight` の結果の文から、相手ごとに近接・投擲の当てた回数と与えた被害を数える（`memory.json` の `fights`。遠征と相手の組ごと）。当てた回数が 6 回を超えても相手の HP の段階が下がらなければ、投げてやり直す。投げても通らなければやめる（目的の相手なら帰って、キャンプで `not_getting_through`。目的でなければ相手にしない）。方針 `fight_with`（`auto`・`throw_first`・`melee`）。`warden_decision` とその相談し直しに、前の戦いの数字を出す。
  - 探す（§32.2）: 探索し終えた階では、立ったマスの記録に加えて、覚えている地図（`get_map`）の通れるマス（今いる所からつながっている所）も見回り先にする。気配の方角は 8 方位で見て、同じ方角を先に。
  - ついていく（§32.3）: 相手の今の位置（見ていないマスなら、覚えているいちばん近い所）へ。相手が階段の上なら隣まで行く。相手がもう別の階にいれば待たない。相手が帰ったら、すぐ帰る。危ないときに寄るのは、見えているか `follow_distance` の内の相手だけ。
  - 小さな直し（§32.4）: `camp` は遠征の終わりにつき 1 回。キャンプで上げるときも遠征の結果を入れる。階段で仲間を待つ命令の理由は `stairs_hold`。命令の前にも `state.json` を書く（`status: acting`）。休むかはゲームの `rest` と同じ判定。眠っている相手へ寄る（V4-1j）は、大守護者に `warden: engage` のときも同じ。

### 38.12 V4-1l: やめるのは見込みで・装甲の高い相手に「投擲に弱い」を引かない（IMPROVEMENTS_V4 §34・§35）

- **ゲームの側**（`engineVersion` 0.37.0）: 守護者の弱点に `maxArmor`（付けてよい装甲の目安の上限）。「投擲に弱い」は 4。
  - 守護者は候補を作るとき、大守護者は階を作るときに、装甲の目安（種族 + 深層強化の半分 + 接辞）で付けられない弱点を引いたら、付けられる弱点から引き直す。装甲 4 以下の相手と、引いた弱点が付けられる相手は、今までと同じ弱点。
  - 記録庫が返す大守護者の弱点の記憶は、その階の大守護者のもの（作られていればその個体、まだなら作ったときの弱点）。
  - 今いる個体と出してある候補の弱点は変えない。
- **pilot**:
  - 手を替える（近接 → 投げる）のは今までどおり回数で。投げても近接より通らなければ近接に戻す。
  - やめるのは、いまの手で 6 回当てた後から、倒すまでの見込みで決める。見込み = 観測の `hp_left_est` ÷ 1 回あたりの被害。見込みが `give_up_hits`（既定 30）を超えたらやめる。
  - `hp_left_est` が無い相手（守護者・大守護者・記録の無い種族）は、最後に段階が下がってから 12 回当てても下がらなければやめる。
  - `not_getting_through` の `detail` に、見込みの回数と、もとにした数。

### 38.13 V4-1m: 長いランの復旧・pilot の不具合 6 つ（IMPROVEMENTS_V4 §37・§38）

- **サーバー**（ゲームの規則は変えていない。`engineVersion` は 0.37.0 のまま）
  - 起動時の復旧が、出来事が十数万件あるランで「Maximum call stack size exceeded」で落ちていた（`history.push(...events)` の引数の上限）。1 件ずつ足す形に直した。記録の再生の仕方は変えていない。
  - 長いランの復旧のテストは、サーバーと同じ大きさのスタックの別のプロセスで動かす（vitest の worker ではスタックが大きく、起きないため）。
  - 起動時に復旧できなかったランは、ランの一覧（`recoveryFailed: { reason, at }`。人間の画面にも）と、再開・参加のエラー（`recovery_failed`。理由つき。HTTP は 503）で見える。
  - 規則の文に、死んだら持ち物と戦利品をすべて失う（落とさない。協力プレイでも仲間に残らない）ことを足した。
- **pilot**（新しい方針は足していない。これで pilot の作り込みは閉じる）
  - 倒れた仲間 1 人につき `party_down` はランを通して 1 回（`memory.json` の `once`）。
  - 上げた返事を待つ間は「黙って止まる」の `safety` を出さない。
  - 特技・加護の選択は、キャンプでも遠征を選ぶ前に。選ぶものが残っていない `choose_perk`・`choose_boon` は捨てる。
  - 待つ間に殴ってきた隣の敵と戦う（`hitBy`）。
  - HP で断られる `fight` は出す前にやめて立て直しの段へ（`fightRefusal`。ゲームの判定と同じ）。
  - ついていく相手と別の階のまま 30 手番で `party_apart` を 1 回知らせる。
  - 観測の文（V4-1m の続き。IMPROVEMENTS_V4 §39.1・§40）: 命中の記録の頭に「この種族の記録: 」（守護者は「この種族の守護者の記録: 」）。目の前の 1 体の数と読まれていた。人間の画面と規則の文も同じ。
