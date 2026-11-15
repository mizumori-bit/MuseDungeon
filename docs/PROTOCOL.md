# MuseDungeon プロトコル仕様

[DESIGN.md](DESIGN.md) の補足。MCP ツール、観測（Observation）、イベント、WebSocket、ログの形式を定める。
型は TypeScript 風の擬似記法。正式な定義は `packages/shared`（Command は zod スキーマ `commands.ts`、Event は TS の判別共用体 `events.ts`、WS/HTTP は `protocol.ts`）とし、本書と食い違う場合は実装前に本書を更新する。

---

## 1. 共通規約

- 列挙値・キー・ID はすべて英語。人間／AI 向けの文章は `locale`（`ja` | `en`、ラン参加時に指定、既定 `ja`）で生成する。
- 座標: フロア左上原点、`x` 東向き、`y` 南向き。方向: `n ne e se s sw w nw`。
- ID: エンティティ `e_xxxxxx`、プレイヤー `p_xxxx`、ラン `run_xxxxxxxx`。不透明で、連番ではない。
- 所持品はスロット文字 `a`〜`z` で指す（所持中は安定）。
- すべての MCP ツール結果は `content`（テキスト）と `structuredContent`（JSON）の両方を返す。テキストは JSON の要約であり、テキストにしか無い情報は作らない。

### 1.1 エラー

不正な行動は**状態を変えず、時間も消費しない**。

```ts
ActionError {
  code: 'invalid_direction' | 'blocked' | 'no_target' | 'out_of_range' | 'no_line_of_sight'
      | 'no_such_item' | 'cannot_use' | 'inventory_full' | 'nothing_here' | 'unknown_destination'
      | 'unreachable' | 'not_your_turn' | 'stale_turn' | 'dead' | 'run_ended' | 'no_session' | 'bad_request'
  message: string      // 何が起きたか
  hint: string         // 次に何をすればよいか
}
```

エラー時の結果: `{ ok: false, error, valid_actions }`。

---

## 2. MCP ツール

### 2.1 セッション

| ツール | 引数 | 結果 |
|---|---|---|
| `get_rules` | `topic?: 'overview'|'actions'|'combat'|'items'|'observation'|'all'`, `locale?` | ルールブック。式と操作方法のみで、個別のモンスター数値は含めない |
| `list_runs` | – | 参加可能・再開可能なラン一覧 |
| `new_run` | `character_name`, `class?`（`warrior`/`scout`）, `mode?: 'solo'|'coop'`, `seed?`, `locale?`, `brief_map?` | `{ run_id, player_token, player_id, observation }`。`seed` を指定しても結果には返さない |
| `join_run` | `run_id`, `character_name`, `class?` | 同上（COOP） |
| `resume_run` | `player_token` | 現在の MCP 接続にプレイヤーを再束縛し、`observation` を返す |
| `retire` | `confirm: true` | ランを自主終了（スコア記録） |

以降のツールは MCP 接続に束縛されたプレイヤーに対して作用する。ステートレスなクライアント向けに、全ツールが任意引数 `player_token` も受け付ける。

### 2.2 情報照会（手番を消費しない）

| ツール | 引数 | 結果 |
|---|---|---|
| `observe` | `detail?: 'brief'|'full'` | Observation（§3） |
| `look` | `target: {x,y} | entity_id` | 対象の説明。モンスターなら「思い出」に基づく既知情報 |
| `get_map` | `floor?`, `region?: {x,y,w,h}` | 記憶しているフロアの ASCII 地図と凡例、既知の注目点一覧（MVP は現在フロアのみ） |
| `inventory` | – | 所持品と装備の詳細 |
| `recall` | `kind_name` | そのモンスター種について自キャラが学んだこと（遭遇数、撃破数、観測した最大ダメージ、見た能力） |
| `get_messages` | `since_seq?`, `limit?` | 自分が知覚したイベントの文章ログ |
| `notes` | `add?: string`, `remove?: number` | 自分用メモの読み書き（長時間プレイでの文脈喪失対策。ゲームに影響しない） |

### 2.3 行動（手番を消費する）

全行動ツールの共通任意引数:

- `thought?: string`（280 文字まで）: 判断理由の短いメモ。観戦・リプレイに表示される。**ゲームの裁定には一切使わない。**
- `expect_seq?: number`: 自分が前提としている観測の `seq`。食い違えば `stale_turn` を返して実行しない（再送・重複実行の防止）。

| ツール | 引数 | 備考 |
|---|---|---|
| `move` | `dir` | 敵対者がいれば近接攻撃、閉じた扉は開ける |
| `wait` | – | |
| `rest` | – | マクロ。全快か中断まで |
| `explore` | – | マクロ。未探索へ自動移動 |
| `travel_to` | `to: {x,y} | 'stairs_down' | 'stairs_up' | entity_id` | マクロ。既知地図上のみ |
| `pickup` | `item?: entity_id` | 省略時は足元の全て（入る分だけ） |
| `drop` | `slot`, `qty?` | |
| `equip` / `unequip` | `slot` | |
| `use_item` | `slot`, `target?: dir | {x,y} | entity_id` | |
| `throw_item` | `slot`, `target: {x,y} | entity_id` | |
| `interact` | `dir?` | 扉の開閉、地物の操作。省略時は足元 |
| `use_stairs` | – | 足元の階段 |
| `say` | `text` | COOP 用チャット。手番を消費しない |

行動結果:

```ts
ActionResult {
  ok: true
  outcome: string                 // 1〜2 文の結果要約
  steps?: number                  // マクロで実際に進んだ手数
  interrupted_by?: string         // マクロ中断理由 'hostile_in_view' | 'damaged' | 'item_seen' | 'arrived' | ...
  events: { seq, type, text }[]   // 前回の行動結果以降に知覚した出来事（トークン節約のため文章のみ。WS では PerceivedEvent 全体）
  observation: Observation        // brief。次の判断に必要な現況
}
```

- 行動ツールは「次に自分の手番が来る」か「ランが終わる」まで待ってから返る。
- COOP で他プレイヤー待ちが 20 秒を超えたら `observation.status = 'waiting_others'` で一旦返す。その場合は `observe` を呼べば手番が来るまで（最大 20 秒）待って返る。

---

## 3. Observation

`PlayerView`（§4）に、AI が使いやすい派生情報（相対方向・距離・到達可否・ASCII 地図）を足して整形したもの。派生情報は PlayerView だけから計算する。

```ts
Observation {
  seq: number
  status: 'your_turn' | 'waiting_others' | 'dead' | 'ended'
  summary: string                      // 1 行の現況
  alerts: Alert[]                      // 重要度順。例 { code:'enemy_adjacent', text, entity? }
  self: {
    name, class, level, xp, xp_next
    hp, max_hp, statuses: {id, turns_left}[]
    pos: {x,y}, floor: { depth, biome_name, time }
    equipment: { weapon?, armor?, accessory? }     // 表示名
    attack: { acc, dmg }, defense: { eva, armor }
    inventory_count, inventory_capacity
    inventory?: { slot, name, qty, category, identified, equipped }[]   // full のみ
    inventory_brief?: string        // brief のみ（例 "a)小剣* b)赤い薬x2"。* は装備中）
  }
  visible: {
    monsters: { id, name, pos, dir, dist, hp_state: 'healthy'|'wounded'|'badly_wounded'|'near_death',
                awareness: 'asleep'|'unaware'|'hunting', threat: 1|2|3|4|5, statuses }[]
    items:    { id, name, pos, dir, dist, qty }[]
    players:  { id, name, pos, dir, dist, hp_state }[]
    features: { type, pos, dir, dist, state? }[]   // 階段・扉・泉・発見済みの罠 など
  }
  navigation: {
    here: string                         // 足元の地形・アイテム
    passable_dirs: Dir[]
    frontiers: { pos, dir, dist }[]      // 未探索との境界（近い順、上限 5）
    known_stairs: { type:'down'|'up', pos, dist, reachable }[]
  }
  recent_events: string[]              // 前回の行動結果以降に知覚した出来事の文章（最大 10）
  map?: { origin:{x,y}, rows: string[], legend: Record<string,string> }  // 自分中心の局所 ASCII（既定 21×15）
  valid_actions: string[]              // 例 "move e (attack ゴブリン)", "use_item a (回復の薬)", "use_stairs"
}
```

- `threat` は「自分の現在 HP」と「思い出にある観測済み最大ダメージ／未知なら深度からの控えめな推定」から出す。PlayerView 外の値は使わない。
- `alerts` の主なコード: `low_hp`, `critical_hp`, `enemy_adjacent`, `multiple_enemies`, `poisoned`, `on_stairs`, `item_here`, `inventory_full`, `new_floor`。人間向け UI にも同じものを表示する。
- 目安: brief は約 400 トークン以内、full は約 1,500 トークン以内。`map` は brief では既定で付け、`new_run` のオプション `brief_map: false` で外せる。

### 3.1 テキスト表現の例（`content` に入るもの）

```
[seq 1284 | 地下3階 湿った洞窟 | HP 23/40 | Lv4 | 位置(12,7) | あなたの番]
!! 敵が隣接: オーク(東) / HP が半分以下
見えるもの:
- オーク e_k3f9a2 (13,7) 東1  負傷:軽傷  状態:追跡中  脅威:4
- 赤い薬 e_p0q8zz (10,9) 南西2
- 下り階段 (20,11) 東8南4  到達可
未探索: 北(12,2) 距離5 / 東の扉(18,7) 閉 距離6
直前の出来事:
- あなたはオークに 5 ダメージを与えた。
- オークの攻撃。7 ダメージを受けた。
地図(自分中心):
  #########
  #..!....+
  #...@O..#
  #.......#
  凡例: @=自分 O=オーク !=薬 +=閉じた扉 #=壁 .=床 (空白)=未知
できること: move e(攻撃:オーク) / move n,s,w,nw,sw,ne,se / use_item a(回復の薬) / throw_item c(投げナイフ) / rest(不可:敵が視界内) / travel_to stairs_down
```

---

## 4. PlayerView

AI の Observation と人間のプレイ画面の**共通の元データ**。`projectPlayerView(world, playerId)` が返す。

```ts
PlayerView {
  runId, playerId, seq
  status: 'your_turn' | 'waiting_others' | 'dead' | 'ended'
  self: { entity（自分の全コンポーネント）, inventory: ItemView[] }
  floor: { key, depth, biome, width, height, time }
  visibleCells: number[]                  // セル index
  entities: EntityView[]                  // 視界内のみ。モンスターの stats は hp バケット等に縮約済み
  memory: { terrain: number[] /*0=未知*/, remembered: RememberedEntity[] }
  identified: string[]
  monsterMemory: Record<string, MonsterMemory>
  notes: string[]
}
```

`ItemView.kind` は未鑑定なら `null` で、代わりに `appearanceId`（外見の ID。content で定義）と `appearance`（その表示名。例 "赤い薬"）を持つ。視界内の床にある未鑑定アイテム（`EntityView`）も同様。人間向けの描画は `appearanceId` で画像を引く（[ASSET_SPEC.md](ASSET_SPEC.md) §7.4）。

クライアントは起動時に公開カタログ `GET /api/content/catalog`（各コンテンツ ID の分類・カテゴリ・表示名のみ。能力値・出現条件は含まない）を取得し、描画時のカテゴリ代替と名前表示に使う。

---

## 5. Event

```ts
EventBase {
  seq: number            // ラン内通番
  cause: number | null   // 原因となった command の cseq
  floor: FloorKey | null
  ft: number             // floor.time
  wall: number           // 壁時計(ms)。再生ペース用。ルールでは使わない
  seenBy: PlayerId[] | 'all'
  masks?: Record<PlayerId, string[]>   // そのプレイヤーに伏せるフィールド（見えていない主体の ID・種別・位置）
  put?: Entity[]                       // 汎用 after 値: 置換・追加するエンティティ
  del?: EntityId[]                     // 汎用 after 値: 削除するエンティティ
}
```

**規約: イベントは結果値を持ち、`applyEvent` は代入・追加・削除しかしない。**

| 分類 | type | 主なペイロード |
|---|---|---|
| ラン | `run_started` | meta, content/engine version |
| | `player_joined` / `player_left` | player（record）, entity |
| | `run_ended` | reason, summary |
| フロア | `floor_generated` | floor 全体（terrain は RLE）。リプレイは生成器を必要としない |
| | `tile_changed` | x, y, terrain, reason（door_open 等） |
| | `floor_time` | time（プレイヤー手番の区切りで更新） |
| エンティティ | `entity_spawned` | entity 全体 |
| | `entity_removed` | id, reason |
| | `entity_moved` | id, from, to, mode: walk\|teleport\|swap\|knockback |
| | `entity_changed_floor` | id, from, to |
| | `actor_scheduled` | id, nextActAt（手番終了時） |
| | `ai_state_changed` | id, state, targetPos |
| 戦闘 | `attack` | attacker, target, roll, hit, crit（演出用。状態は変えない） |
| | `damaged` / `healed` | target, amount, source, via（melee/ranged/thrown/poison/trap/effect）, hpAfter |
| | `died` | id, killer |
| | `status_applied` / `status_expired` | target, status（after 値） |
| | `xp_gained` / `level_up` | player entity, xpAfter / levelAfter, statsAfter |
| アイテム | `item_picked_up` / `item_dropped` | actor, item, slot, invAfter |
| | `item_equipped` / `item_unequipped` | actor, item, equipAfter |
| | `item_used` / `item_thrown` | actor, item, consumed, qtyAfter |
| | `item_identified` | player, kind, appearance |
| 知識 | `knowledge_updated` | player, floor, visible（RLE）, newlySeen: [idx, terrain][], remembered 差分 |
| | `monster_memory_updated` | player, kind, memoryAfter |
| 知覚 | `noise` | pos, loudness（状態は変えない） |
| | `trap_revealed` / `trap_triggered` | trap, by |
| メタ | `thought` | player, text（状態は変えない） |
| | `chat` | player, text |
| 追加 | `player_state` / `player_stats` | プレイヤーの生死・離脱 / 撃破数・到達深度・死因 |
| | `turn_began` | actor, time（フロアの手番待ちと floor.time を設定） |
| | `floor_wander` | nextWanderAt |
| | `status_ticked` / `stats_changed` / `max_hp_changed` | 状態異常の残り手番 / 実効能力値（装備変更時）/ 最大 HP |
| | `feature_state` / `notes_updated` | 地物の状態（泉の使用済み等）/ 自分用メモ |
| 内部 | `rng_advanced` | 乱数ストリームの状態（プレイヤーには渡さない。観戦・HTTP には中身を空にして渡す） |

プレイヤーに渡す際は `filterEventsForPlayer(events, playerId, view)` を通す: `seenBy` に含まれないものを落とし、見えていないエンティティ参照を `null` にし、`knowledge_updated` 等の他人向け・内部用イベントを除く。`PerceivedEvent` はそれに `text`（`narrate` の出力）を付けたもの。

---

## 6. Command ログ

```ts
CommandRecord {
  cseq: number
  player: PlayerId
  command: Command              // move / wait / pickup / ... / explore / travel / rest
  source: 'mcp' | 'ws' | 'macro' | 'timeout'
  parent?: number               // マクロ展開元の cseq
  thought?: string
  wall: number
  resultSeq: [from, to]         // この command が生んだイベントの seq 範囲
}
```

マクロ行動は「元の呼び出し 1 件（イベント無し）」＋「展開された基本行動 N 件（`source: 'macro'`）」として記録する。決定論的再実行では基本行動だけを流す。

---

## 7. WebSocket（`/ws`）

```ts
// client → server
{ t: 'hello', role: 'player',    runId, token }
{ t: 'hello', role: 'spectator', runId, mode: 'director' | 'follow', follow?: PlayerId, fromSeq?: number }
{ t: 'command', command: Command, expectSeq?: number }        // player のみ
{ t: 'query', id, kind: 'look'|'recall'|'map'|'inventory'|'messages'|'observation', args }   // player のみ・手番消費なし

// server → client
{ t: 'welcome', role, runId, contentVersion }
{ t: 'view', view: PlayerView, events: PerceivedEvent[] }      // player: 状態が進むたび
{ t: 'snapshot', seq, world: World(secret 除去) }              // spectator: 接続時・シーク時
{ t: 'events', events: Event[] }                               // spectator: 逐次
{ t: 'error', error: ActionError }
{ t: 'result', id, data }
{ t: 'agent', activity: { playerId, seq, tool, args, text, wall } }   // 観戦: MCP ツール呼び出しと AI が受け取った観測テキスト
{ t: 'macro', playerId, kind, state: 'running'|'stopped', steps, reason? }
{ t: 'ended', summary }
```

- 人間プレイヤーの `command` は MCP と**同一の `Command` スキーマ**で、同じ `PlayerPort.submit` を通る。
- 観戦者は書き込み系メッセージを送れない（サーバーが拒否）。`spectatorPolicy` が `follow_only` の場合、サーバーは `director` を拒否し、`follow` には World ではなく PlayerView 相当だけを送る。

## 8. HTTP

| パス | 内容 |
|---|---|
| `GET /` | Web クライアント |
| `POST /mcp` ほか | MCP Streamable HTTP |
| `GET /api/runs` | ラン一覧（進行中・終了済み） |
| `GET /api/runs/:id/meta` | meta（終了前はシード無し） |
| `GET /api/runs/:id/events?from=&to=` | イベント範囲（JSONL） |
| `GET /api/runs/:id/keyframes` / `/:seq` | キーフレーム一覧／取得（進行中は secret 除去） |
| `GET /api/runs/:id/index` | リプレイ用マーカー索引（フロア移動・撃破・死亡などの seq） |
| `GET /api/leaderboard` | スコア一覧（`controller.kind` は表示用） |
| `GET /api/health` / `GET /api/config` | 生存確認 / `spectatorPolicy` |
| `GET /api/content/catalog` | 公開カタログ |
| `POST /api/runs` / `POST /api/runs/:id/join` | 人間がランを開始・参加（`{ name, classId?, seed?, mode?, locale? }` → `{ runId, playerId, token }`） |
| `GET /api/runs/:id/commands` | commands.jsonl（AI パネルのツール呼び出し・thought 表示用） |
| `GET /api/runs/:id/summary` | 終了時サマリー |
