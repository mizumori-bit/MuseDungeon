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
