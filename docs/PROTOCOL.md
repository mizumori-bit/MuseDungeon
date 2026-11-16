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
      | 'confirm_required' | 'cannot_extract' | 'not_at_camp' | 'at_camp'     // 遠征（v2）
      | 'hostile_adjacent' | 'hostile_in_view' | 'hp_floor' | 'nothing_to_do'   // マクロが 1 歩も進めない（V3-2R。手番を使わない）
  message: string      // 何が起きたか
  hint: string         // 次に何をすればよいか
}
```

エラー時の結果: `{ ok: false, error, valid_actions, turn }`（プレイヤーが束縛されていない `no_session` には `turn` が無い）。

### 1.2 ターン契約（`turn` ブロック）

プレイヤーが束縛された全応答（`new_run`・`resume_run`・`observe`・`wait_for_turn`・全行動ツール・照会ツール・エラー）の `structuredContent` に必ず付ける。テキストでは**末尾の 1 行**（`▶ ...`）に同じ内容を書く。定義は `packages/shared/src/turn.ts`。

```ts
turn: {
  state: 'your_turn' | 'waiting_others' | 'at_camp' | 'expedition_ended' | 'run_ended'
  turn_no: number                 // 自分の手番の通番（行動した手番数）
  reason: 'run_started' | 'resumed' | 'action_completed' | 'macro_interrupted' | 'action_rejected'
        | 'turn_arrived' | 'expedition_started' | 'observed' | 'wait_timeout'
  interrupted_by?: string         // マクロの停止理由（macro_interrupted のとき。完了した停止 arrived / explored / full_hp なども入る）
  awaiting: 'action' | 'camp_choice' | 'nothing'
  changes: { code, text, entity? }[]   // 前回の応答以降の重要な変化（事実のみ、最大 8 件）
}
```

- `state` と `awaiting` は**事実の通知**であり、行動の提案ではない。選択肢の列挙は `valid_actions` が担う。
- `expedition_ended` は遠征を終わらせた行動（`extract`、死亡を伴う行動など）への応答、`at_camp` はその後のキャンプ中の応答。どちらも、`run_ended` と同じく「ここでやめてよい」正規の合図。`awaiting` は `expedition_ended`・`run_ended`・`waiting_others` で `nothing`、キャンプで候補があれば `camp_choice`。
- `reason`: `observed` は `observe` と照会ツール、`wait_timeout` は `wait_for_turn` が時間切れになったとき（実装で追加した値）。
- `changes` のコード（v3。この優先順で最大 8 件）: `floor_changed`, `objective_complete`, `objective_progress`, `can_extract`, `hp_low`, `killed`（自分が倒した）, `died_seen`（目の前で倒れた）, `hp_dropped`, `new_hostile`（このランで初めて見た個体）, `level_up`, `status_gained`, `status_lost`, `item_found`, `stairs_found`, `reappeared`（前に見た個体が再び見えた）, `hostile_gone`（倒れた以外の理由で見えなくなった）。PlayerView・観測と、その間に知覚したイベント（撃破・死亡の区別に使う）から作る（`turnSnapshot` → `diffChanges(prev, cur, view, obs, events)`）。基準は「前回この プレイヤーに turn を返した時点」で、行動ツール・`observe`・`wait_for_turn`・`new_run`・`resume_run` が基準を更新する。照会ツール（`look` 等）の `turn.changes` は常に空。人間向け UI も同じ関数で自分の手番ごとの変化を出す。
- `objective_complete` は、`slay_guardian` と `retrieve_relic` では「坑が騒がしくなった（この遠征の間、徘徊の湧き間隔が半分）」を添える。遺物を手にした `objective_progress` は「この階の眠っていた敵が目を覚ました」を添える。
- V3-2R2: 守護者が倒れたら `guardian_slain`（「★ 守護者が倒れた」。優先順の先頭で、テキストではほかの変化と別の行にして先に出す）。
- V3-2R: 踏破（目標より深い階の下り階段に立った）は `objective_progress`（「地下4階を踏破した」）。今帰った場合の次の候補の下限が変わると `next_camp`（優先順は `objective_progress` の次）。`hostile_gone` は最後に見た位置と、視界の外へ出た一歩の向きを添える（「見えなくなった敵: ゴブリン（最後に見た位置 (5,6)・北東へ）」。向きは知覚した移動から。行き先は出さない）。
- 末尾の ▶ 行は既定で短縮形（`set_options status_line: short`）。新しいラン・再開・遠征の開始と、`state` が変わった応答では長い形になる。

---

## 2. MCP ツール

### 2.1 セッション

| ツール | 引数 | 結果 |
|---|---|---|
| `get_rules` | `topic?: 'overview'|'expedition'|'actions'|'combat'|'items'|'classes'|'observation'|'all'`, `locale?` | ルールブック。式・操作・遠征（戦利品・確定点・候補の枠と条件・危険度）・観測の読み方のみで、個別のモンスター数値は含めない。数値は `balance.json`（公開カタログの `rules`）から生成。`classes` は職業ごとの初期値・初期装備・成長（v3） |
| `list_runs` | – | 参加可能・再開可能なラン一覧 |
| `new_run` | `character_name`, `class?`（`warrior`/`scout`）, `mode?: 'solo'|'coop'`, `seed?`, `locale?`, `objective?: 'auto'|'reach_depth'|'slay_guardian'|'retrieve_relic'|'endless'`, `brief_map?`, `map?`, `inventory?`, `status_line?` | `objective` を省くと**キャンプから始まる**（`at_camp`・`awaiting: 'camp_choice'`。最初の遠征も 3 候補から `start_expedition` で選ぶ。V3-2R）。`objective` を渡せば従来どおり最初の遠征まで始める（`auto` は 1 番目の候補 = 堅実・到達）。`{ run_id, player_token, player_id, briefing, observation, turn }`。`seed` を指定しても結果には返さない。`map` 以下は `set_options` と同じ（`brief_map: false` は `map: 'never'`）。不明な `class` のエラーは職業の一覧を返す |
| `join_run` | `run_id`, `character_name`, `class?` | 同上（COOP。進行中の遠征に加わる） |
| `resume_run` | `player_token`, `map?`, `inventory?`, `status_line?` | 現在の MCP 接続にプレイヤーを再束縛する。**再開ブリーフィング**（遠征の目的と進捗、現在地、直近の節目 最大 10 件、自分のメモ）＋ `observation` ＋ `turn` |
| `retire` | `confirm: true` | ランを終了する（キャラクターは戻らない）。スコアを記録。遠征中なら、その遠征の戦利品は失う（キャンプで引退すれば確定点はそのまま） |

### 2.1.1 遠征（v2、v3 で戦利品と確定点）

| ツール | 引数 | 結果 |
|---|---|---|
| `expedition` | – | 遠征の目的・達成条件・進捗（ブリーフィング）。キャンプでは次の遠征の候補。手番を消費しない |
| `extract` | `confirm?: boolean`, 共通引数 | 行動。階段（上り・下り）の上なら可（V3-2R2: 追跡中の敵が見えていてもよい。敵は階段を追ってこない）。目的を達成していれば**帰還**（遠征は `completed`、戦利品 × 倍率を確定）。未達成なら `confirm: true` で**撤退**（`withdrawn`、(戦利品 − 目的) × `withdrawPct`% を確定）。`confirm` が無ければ `confirm_required`。確定する点は観測の `expedition.haul.if_extract_now` と一致する。所持している宝は換金され、達成して持ち帰った遺物は納められ、どちらも所持品から消える |
| `start_expedition` | `offer: 1..n | 'endless'` | キャンプで次の遠征を始める。前回 `extract` した階段から再開する。結果に `briefing`（目的・枠・条件・倍率・戦利品の説明） |

スコア（版 2、v3）: ランのスコア = 確定点（`banked`）の合計。遠征の払い戻しは、帰還 = 戦利品 × 条件の倍率、撤退 = (戦利品 − 目的の基礎点) × `withdrawPct`%（初期値 50）、帰還の綱 = 戦利品（目的は達成済みのときだけ含む）× `lifeline.pct`%（初期値 50。倍率なし。V3-2R2）、死亡・引退 = 0（失った戦利品 `lost` として記録）。結果の段階は 4 つ（階段で帰還・綱で帰還・階段で撤退・死）。戦利品の内訳 `HaulParts` は `objective`（達成で基礎点）・`overreach`（踏破: 目標より深い階の**下り階段に立ったとき**。着いただけでは入らない。n 階目 = 目的の基礎点 × (`overreachPct.first` + `overreachPct.step` × (n − 1))%、下限 `overreachFirst` + `overreachStep` × (n − 1)。V3-2R2）・`treasure`（所持している宝の価値）・`bounty`（守護者の賞金）・`discovery`（このランで初めて倒した種族・鑑定したアイテム種）・`kills`（1 体 `perKill`）。宝を除く部分は遠征の参加者で共有し、extract した各自に払い戻す。係数は `balance.json` の `haul`。

キャンプの候補は 3 枠（`slot`: `safe` 堅実 / `standard` 標準 / `ambitious` 野心）で、目標深度（生成済みの最深階 + 堅実 1・標準 2・野心 3。重ならない）・条件（`expeditionTraits`）の数・枠の基礎点が枠ごとに違う（`balance.expedition.slots`）。候補の点 = 枠の基礎点（`slots.*.base`: 1600 / 2400 / 3600）× 種類の係数（`typePct`: 到達 100・守護者 120・遺物 120・守護者付きの遺物 135 %）× 深さの係数（`depthPct`: 100 + 5 × 目標深度 %）で、どの組み合わせでも 堅実 < 標準 < 野心（V3-2R2。`offerPoints`）。目的の種類は 3 枠で別。最初の遠征は 堅実 地下2階・標準と野心 地下3階（`firstTargetDepth`）。条件は目標階までの全階に効く公開の修飾で、倍率は帰還時の戦利品に掛かる（複数なら掛け合わせ）。V3-2R で危険度の 5 段階を廃止し、`recommended_level`・`level_gap`（推奨 − 自分のレベル）・`trait_danger`（条件の危険度の合計）を出す。推奨レベルは公開の表（`balance.expedition.recommendedLevelByDepth`。bot の実測の中央値。表より深い階は直近 4 階の傾きで伸ばす）。

以降のツールは MCP 接続に束縛されたプレイヤーに対して作用する。ステートレスなクライアント向けに、全ツールが任意引数 `player_token` も受け付ける。

### 2.2 情報照会（手番を消費しない）

| ツール | 引数 | 結果 |
|---|---|---|
| `observe` | `detail?: 'brief'|'full'` | Observation（§3）＋ `turn`。**待たずに返す**（v2） |
| `wait_for_turn` | `timeout_s?`（既定 20、最大 60） | 自分の手番（または遠征・ランの終了）まで待って Observation ＋ `turn` を返す。既に自分の番なら即時。時間切れは `turn.reason = 'wait_timeout'` |
| `look` | `target: {x,y} | entity_id` | 対象の説明。モンスターなら「思い出」に基づく既知情報 |
| `get_map` | `floor?`, `region?: {x,y,w,h}` | 記憶しているフロアの ASCII 地図（上 2 行が x の 10 の位・1 の位、行頭が y）と凡例、既知の注目点一覧（MVP は現在フロアのみ） |
| `inventory` | – | 所持品と装備の詳細 |
| `recall` | `kind_name` | そのモンスター種について自キャラが学んだこと（遭遇数、撃破数、観測した最大ダメージ、見た能力、倒した個体の体力の範囲 `hpSeen`、見た射撃の最長距離） |
| `get_messages` | `since_seq?`, `limit?` | 自分が知覚したイベントの文章ログ |
| `notes` | `add?: string`, `remove?: number` | 自分用メモの読み書き（長時間プレイでの文脈喪失対策。ゲームに影響しない） |
| `set_options` | `map?: 'auto'|'always'|'never'`, `inventory?: 'on_change'|'always'`, `status_line?: 'short'|'long'` | 応答テキストの出し方（v3）。既定は `auto`（階が変わった・新しいセルを知った・敵の出入りがあった応答だけ地図を付け、それ以外は「地図: 変化なし」）・`on_change`（所持品の行は変わったときだけ）・`short`。ゲームと `structuredContent` には影響しない |

### 2.3 行動（手番を消費する）

全行動ツールの共通任意引数:

- `thought?: string`（280 文字まで）: 判断理由の短いメモ。観戦・リプレイに表示される。**ゲームの裁定には一切使わない。**
- `expect_seq?: number`: 自分が前提としている観測の `seq`。食い違えば `stale_turn` を返して実行しない（再送・重複実行の防止）。

| ツール | 引数 | 備考 |
|---|---|---|
| `move` | `dir` | 敵対者がいれば近接攻撃、閉じた扉は開ける |
| `wait` | `turns?: 1..10` | 追跡中の敵が見えなければ休息（回復が `restMultiplier` 倍）。`turns` が 2 以上ならマクロ（V3-2R2）: 敵が新たに見えた（`hostile_in_view`）・起きている敵が隣に来た（`hostile_adjacent`）・攻撃や毒以外の被害・状態異常で止まり、指定の手数で `max_turns` |
| `rest` | `until_hp?`, `max_turns?` | マクロ。全快（かつ毒が抜ける）か、指定の HP・手数か、中断まで（上限 `rest.maxTurns`） |
| `explore` | `mode?`, `hp_floor?`, `pickup?`（既定 true） | マクロ。未見の区画（地図の巻物で地形だけ知った区画を含む）へ自動移動。pickup なら通り道と見えている・記憶したアイテムも拾う（遺物と鑑定済みの有害品は拾わない） |
| `travel_to` | `to: {x,y} | 'stairs_down' | 'stairs_up' | entity_id`, `mode?`, `hp_floor?`, `pickup?` | マクロ。既知地図上のみ。目的地がアイテムなら着いて拾う |
| `collect` | `what?: 'thrown'|'items'`, `mode?`, `hp_floor?` | マクロ（v3）。`thrown`（既定）は既知の自分が投げた物、`items` は見えている・記憶したアイテムを近い順に回って拾う。結果に `collected: { picked, remaining }` |
| `fight` | `target: entity_id`, `with?: slot`, `hp_floor?` | マクロ（V3-2R、V3-2R2 で拡張）。その相手と決着を付ける。`with` なし: 隣なら近接攻撃を繰り返す。相手が追跡中で届かない間は隣に来るまで待つ（最大 10 手番、`target_not_approaching`）。当てて逃げる相手は追跡中で 2 マス以内なら 2 手番まで待つ（追わない）。`with`: そのスロットの品を投げて戦う（射程と射線が通るまで待つ）。止まるのは: 相手が倒れた（`target_down`）・離れた／逃げて射程を出た（`target_moved`）・見えなくなった（`target_gone`）・（`with`）隣に来た（`target_adjacent`）・品が尽きた（`out_of_ammo`）・射線が 3 手番続けて通らない（`no_line_of_sight`）・HP が `hp_floor`（既定 50%）未満・追跡中の別の敵・状態異常。眠っている・気付いていない相手は待たない（`target_not_hunting` で拒否）。結果の `outcome` に与えた攻撃（投げた）回数・命中・合計・待った手番 |
| `pickup` | `item?: entity_id` | 省略時は足元の全て（入る分だけ） |
| `drop` | `slot`, `qty?` | |
| `equip` / `unequip` | `slot` | |
| `use_item` | `slot`, `target?: dir | {x,y} | entity_id`, `target_slot?` | 帰還の綱（`core:lifeline`。V3-2R2）は使うと `lifeline.turns`（2）手番のあいだ行動できず（状態 `core:recall`、その間も攻撃は受ける）、切れるとキャンプへ戻る。1 回の呼び出しで最後まで進む。遠征の開始時にキャンプが 1 本にそろえる。捨てる・投げることはできず（`cannot_use`）、所持数に数えない。`target_slot`: 鑑定の巻物で鑑定する品（省略時はスロット順で最初の未鑑定品。読んだ巻物自身の種類は除く）。引数の形が合わないときもゲームのエラー形式（`bad_request`・hint・valid_actions）で返す |
| `throw_item` | `slot`, `target: {x,y} | entity_id` | 投擲の経路は双方向（自分→相手の直線か、相手→自分の直線を逆にたどったもののうち通る方。敵の射撃も同じ経路。V3-2R2）。ID 指定で経路が通らない相手は `no_line_of_sight`、射程外は `out_of_range`（どちらも手番も品物も失わない。観測の `shots`）。座標指定は遮られた位置か射程の端に落ちる。結果は必ず 命中 / 外れ / 遮られた / 届かない / 誰もいない と落下地点で書く。自分が投げた物はそのマスに入るだけで拾う（追加の手番なし） |
| `interact` | `dir?` | 扉の開閉、地物の操作。省略時は足元 |
| `use_stairs` | – | 足元の階段 |
| `say` | `text` | COOP 用チャット。手番を消費しない |

行動結果:

```ts
ActionResult {
  ok: true
  outcome: string                 // 1〜2 文の結果要約
  steps?: number                  // マクロで実際に進んだ手数
  interrupted_by?: string         // マクロの停止理由 'hostile_in_view' | 'hostile_alerted'（見えている敵が追跡に変わった）| 'hostile_adjacent' | 'attacked' | 'damaged' | 'blocked' | 'stairs_seen' | 'hp_floor' | 'hp_threshold' | 'arrived' | 'explored' | 'collected' | 'target_down' | 'target_moved' | 'target_gone' | 'full_hp' | 'target_hp' | 'max_turns'
                                  // V3-2R2 の fight: 'target_adjacent' | 'out_of_ammo' | 'not_throwable' | 'no_line_of_sight' | 'target_not_approaching' | 'target_not_hunting' | ...
  distance?: number               // explore / travel_to: 歩いた手数
  time_elapsed?: number | null    // explore / travel_to: 経過したフロア時間（階を移ったら null）
  rest?: { hp_gained, turns, time_elapsed, stopped_by }   // rest の実績
  briefing?: string[]             // start_expedition: 遠征のブリーフィング
  collected?: { picked, remaining } // collect: 回収した数と、既知の残り
  events: { seq, type, text }[]   // 前回の行動結果以降に知覚した出来事（トークン節約のため文章のみ。WS では PerceivedEvent 全体）
  observation: Observation        // brief。次の判断に必要な現況
  turn: TurnBlock                 // §1.2
}
```

- `outcome` には、その行動から次の自分の手番までに受けた攻撃の回数・命中数・合計ダメージ・HP の前後を必ず書く（v3。「3 回攻撃を受け、2 回命中・合計 9 ダメージ（HP 23→15、回復 +1）、外れ 1 回」）。数えるのはその間の自分が対象の `attack`・`damaged`・`healed` で、合計 − 回復 = HP の差。毒・罠などのダメージが混ざるときは「（攻撃 X・毒など Y、HP a→b）」と分ける。
- 移動マクロ（`explore`・`travel_to`・`collect`）の `mode`（V3-2R）:
  - `careful`（既定）: 初見の**種族**・追跡中（逃走中を除く）で自分に届く敵の出現・見えている敵が追跡に変わった・攻撃を受けた（外れも含む、`attacked`）・毒以外のダメージ・状態異常・HP が 50%／25% をまたいだ（`hp_threshold`）・階段の発見（explore）で止まる。既知の種族の眠っている・気づいていない個体、隣にいない動かない敵、毒の継続ダメージ、アイテムの発見では止まらない（`changes` には出る）。隣に起きている敵（逃走中を除く）がいれば動かない
  - `steady`: 追跡中の敵が隣接した・初見の種族・HP が `hp_floor`（既定 最大 HP の 50%）未満・その階の下り階段を初めて見た（`stairs_seen`。V3-2R2）で止まる
  - `flee`: 到着・進路をふさがれた・HP が `hp_floor`（既定 25%）未満で止まる。隣に敵がいても動く（退却）
  - どの mode も 1 歩ずつ通常の `move` として記録し、敵は通常どおり攻撃する。マクロは攻撃しない（次のマスに敵がいれば `blocked`）。`rest` は敵が視界に入ると状態によらず止まる（動かない敵は隣にいなければ休息を妨げない。V3-2R2: すでに見た個体が逃げながら視界を出入りしても止まらない）
  - careful と steady は、その階の下り階段を初めて見たときにも止まる（`stairs_seen`。flee は止まらない。V3-2R2）。経路探索は、見えている動かない敵の隣のマスを罠と同じく避ける（ほかに道が無ければ通る）
  - `valid_actions` の `fight` と `mode:steady` の行には、既定の `hp_floor` の実数を書く（「HP 24 未満で止まる」）
- **0 歩で終わる呼び出しは作らない**: 実行前に 1 歩も進めないと分かれば、手番を使わずに理由付きのエラー（`hostile_adjacent`・`hostile_in_view`・`hp_floor`・`blocked`・`unreachable`・`unknown_destination`・`nothing_to_do`）で返す。`valid_actions` にはその場で進める mode だけを出す（隣に敵がいれば `travel_to stairs_up mode:flee` と `fight <id>`）。
- 行動ツールは「次に自分の手番が来る」か「遠征・ランが終わる」まで待ってから返る。
- COOP で他プレイヤー待ちが 20 秒を超えたら `turn.state = 'waiting_others'` で一旦返す。その場合は `wait_for_turn` で手番が来るまで待てる。

---

## 3. Observation

`PlayerView`（§4）に、AI が使いやすい派生情報（相対方向・距離・到達可否・ASCII 地図）を足して整形したもの。派生情報は PlayerView だけから計算する。

```ts
Observation {
  seq: number
  status: 'your_turn' | 'waiting_others' | 'dead' | 'ended' | 'at_camp'
  summary: string                      // 1 行の現況
  alerts: Alert[]                      // 重要度順。例 { code:'enemy_adjacent', text, entity?, data? }（data: incoming / escape の数値。V3-2R2）
  self: {
    name, class, level, xp, xp_next
    hp, max_hp, statuses: {id, turns_left}[]
    pos: {x,y}, floor: { depth, biome_name, time, draft?: Dir, explored?: 1|2|3|4, hint_text? }
                                    // draft: 下への風（今いる階の下り階段を見ていない間の 8 方向。遠近は出さない）、explored: 通れるマスのうち見た割合の 4 段階（約 1/4・半分・3/4・ほぼ全て）。V3-2R2
    equipment: { weapon?, armor?, accessory? }     // 表示名
    attack: { acc, dmg, throws?: { slot, name, dmg: string|null, acc, range }[] }, defense: { eva, armor }   // throws: 投げられる持ち物（acc は自分の命中込み。V3-2R）
    inventory_count, inventory_capacity   // inventory_count は手放せない品（帰還の綱）を数えない
    inventory?: { slot, name, qty, category, identified, equipped, value?, stats? }[]   // full のみ。value は宝の価値、stats は鑑定済みの性能（weapon {dmg,acc} / armor {armor,eva} / throw {dmg,acc,range}。接辞込み）
    inventory_brief?: string        // brief のみ（例 "a)小剣*[1d6・命中+1] c)投げナイフx8[投擲1d4+1・射程7・命中+1]"。* は装備中）
    turns: number                   // 自分が行動した手番数
    speed: number                   // 実効の速さ（標準 100。状態異常込み。v3）
    score: { banked, expeditions_completed }   // 確定済みの点と達成した遠征の数（v3）
    rest_estimate?: { hp_to_full, turns, time, wander_expected: string /* 例 "0〜1" */, blocked_by?: 'poisoned', lowest_hp?: number /* 毒のとき、抜けるまでの最低 HP（V3-2R2） */ }  // HP が減っていて、休めるときのみ（追跡中の敵が見えている間は出さない。V3-2R）
  }
  visible: {
    monsters: { id, name, pos, dir, dist, hp_state: 'healthy'|'wounded'|'badly_wounded'|'near_death',
                awareness: 'asleep'|'unaware'|'hunting', threat: 1|2|3|4|5|null, statuses,   // null: 攻撃を受けた記録が無い種族（不明・初見。V3-2R）
                worst_hit: number|null,                       // その種族から受けた最大の一撃（会心を見ていれば会心の値）
                speed: 'slow'|'normal'|'fast',                // 自分の今の速さとの比較（見れば分かる。V3-2R2）
                traits: ('pack'|'ranged'|'stationary')[],      // 見れば分かる特徴（種族の公開タグ。V3-2R2）
                first_seen?: true,                            // 本当に初めて見た種族（threat null の文が「不明（初見）」になる）
                hits?: { your_melee?: [hits, tries], your_thrown?: [hits, tries], theirs?: [hits, tries] },   // 命中の記録（種族ごと。確率は出さない）
                role?: 'guardian', fleeing?: true,            // 守護者 / 手負いで逃走中
                damage_seen?: number,                         // 見ている間にこの個体が受けた実ダメージの合計
                hp_left_est?: { min, max: number | null, samples, record: { min, max } },   // 体力の記録がある種族のみ。記録が estimateMinSamples（5）体未満は max: null。record は記録した個体の体力の範囲（標本）
                shot: 'clear' | 'blocked',                    // 自分のセルから投擲の経路が通るか（v3）
                shots: { slot, state: 'clear'|'blocked'|'out_of_range' }[],   // 投げられる持ち物ごと（V3-2R）
                bounty?: number }[]                           // 倒すと戦利品に入る賞金（v3）
    items:    { id, ids?, name, pos, dir, dist, qty, role?: 'relic', remembered?, mine?: true, value? }[]
              // 同じセルの同種は 1 行（ids に全て）。mine = 自分が投げた物、value = 宝の価値（v3）
              // 自分が投げた物は見えている・記憶したものを全部で 1 行にまとめる（qty = 本数、pos = 最寄り、ids = 全て。V3-2R2）
    items_omitted?: number          // 記憶の中の遠いアイテムのうち省いた件数
    players:  { id, name, pos, dir, dist, hp_state }[]
    features: { type, pos, dir, dist, state? }[]   // 階段・扉・泉・発見済みの罠 など
  }
  navigation: {
    here: string                         // 足元の地形・アイテム
    passable_dirs: Dir[]
    frontiers: { pos, dir, dist }[]      // 未探索との境界（近い順、上限 5）
    known_stairs: { type:'down'|'up', pos, dist, reachable, path_len: number | null }[]   // path_len: 既知地図上の経路長
    unsighted?: number                   // 地形は判明しているが、まだ見ていないセルの数（地図の巻物の後。frontiers はそこへの境界を含む）
  }
  expedition?: {                       // 遠征の事実（次の一手の指示ではない）
    no, points, status: 'in_progress'|'objective_complete'|'ended'
    objective: { type: 'reach_depth'|'slay_guardian'|'retrieve_relic'|'endless', target_depth: number|null, text }
    progress: { depth, target_depth, reached?, guardian_slain?, relic_held? }
    can_extract: boolean               // 今この場で extract できるか
    extract_blocked_by?: 'not_on_stairs' | 'not_your_turn' | 'ended'   // V3-2R2: 追跡中の敵が見えていても止めない
    extract_outcome: 'complete' | 'withdraw'   // 今 extract したら達成か撤退か
    text: string                       // 1 行の要約
    result?: { reason, points, deepest, kills, turns, text }   // 終了した遠征
    slot?: 'safe'|'standard'|'ambitious', traits?: string[]    // v3
    haul?: {                           // 未確定の戦利品（v3）
      total, multiplier_pct, parts: { objective, overreach, treasure, bounty, discovery, kills }
      if_extract_now: number           // 今 extract したら確定する点（帰還なら × 倍率、撤退なら (total − objective) × withdrawPct%）
      if_lifeline_now?: number         // 帰還の綱を今使った場合の確定点（綱を持っているときだけ。V3-2R2）
      next_overreach: { depth, points, at: 'stairs_down', path_len: number|null, dir?: Dir } | null   // 次に踏破の点が入る階（その階の下り階段に立てば入る）。今いる階なら既知の下り階段までの経路長、未発見なら下への風の方角 dir
      next_camp: { min_target_depth, recommended_level } | null   // 今帰った場合の次の候補の下限と推奨レベル（潜るほど深くなる）
      next_camp_after_crossing?: { min_target_depth, recommended_level } | null   // 次の踏破をしてから帰った場合（V3-2R2）
      text: string                     // 戦利品の 1 行（テキストでは遠征の行に続けて 1 行にする）
    }
    sense?: { what: 'guardian'|'relic', dir, range: 'far'|'near', text }   // 目標階にいる間の気配（10 マス以内が near。正確な位置は出さない。V3-2R）
  }
  camp?: { next_no, offers: { index, type, target_depth, points, text,
           slot?, traits?, multiplier_pct, recommended_level: number | null, level_gap: number | null, trait_danger: number }[] }   // キャンプ（遠征と遠征の間）のみ
  recent_events: string[]              // 前回の行動結果以降に知覚した出来事の文章（最大 10）
  map?: { origin:{x,y}, rows: string[], legend: Record<string,string> }  // 自分中心の局所 ASCII（既定 21×15。フロア外は出さない）
  valid_actions: string[]              // 例 "move e (attack ゴブリン)", "use_item a (回復の薬)", "use_stairs"
}
```

- `threat` は「自分の現在 HP」と「思い出にある観測済み最大ダメージ／未知なら深度からの控えめな推定」から出す。PlayerView 外の値は使わない。
- `alerts` の主なコード: `low_hp`, `critical_hp`, `enemy_adjacent`, `incoming`, `lethal_range`, `escape`, `poisoned`, `on_stairs`, `item_here`, `inventory_full`, `new_floor`, `can_extract`, `at_camp`。
  - `incoming`（V3-2R2。`multiple_enemies` を置き換え）: 自分に届く追跡中の敵（逃走中を除く。動かない敵は隣にいるときだけ）が 2 体以上。`data: { hunting, worst_sum, unrecorded, hp }`。worst_sum は種族ごとの `worst_hit` を個体ごとに足したもの（思い出の記録だけ）。
  - `lethal_range`: 追跡中の敵の `worst_hit`、または記録のある追跡中の敵の `worst_hit` の合計が今の HP 以上。
  - `escape`（V3-2R2）: 追跡中の敵が見えていて、既知の階段に辿り着けるとき（階段の上では出さない）。`data: { stairs: 'up'|'down', path_len, faster }`（faster = 自分より速い追跡中の敵の数）。人間向け UI にも同じものを表示する。`alerts` は現在の状態、`turn.changes` は前回からの差分。
- `hp_left_est` は思い出の `hpSeen`（目の前で倒した個体の最大 HP の範囲。守護者は除く）、`hp_state`、`damage_seen` だけから計算する（`hpLeftEstimate`）。記録の範囲と矛盾する（接辞・深層強化で頑丈な）個体には付かない。
- `rest_estimate` は engine と同じ式（`regenInterval`・`regenStep`）と自分の回復の蓄積値（`self.regen`）で数える。中断が無ければ `rest` の実績と一致する。
- `fleeing`: 逃走の閾値（種族データの `fleeBelowHpPct`）を下回った追跡中の敵。逃走中の敵は `extract` と休息を妨げない。
- 目安: brief は約 400 トークン以内、full は約 1,500 トークン以内。`map` は brief では既定で付け、`new_run` のオプション `brief_map: false` で外せる。
- 地図（v3）: モンスターは種族ごとに固定の 1 文字（content の `glyph`。一意）。テキストでは上の 2 行が x 座標の 10 の位・1 の位、行頭が y 座標の目盛り。`get_map` も同じ。
- 帰還の綱を持っていれば `valid_actions` に「use_item <slot>（帰還の綱: 2 手番動けずにキャンプへ戻る・+N 確定・追跡中の記録の最大被害 …）」。投擲の候補があれば「fight <id> with:<slot>（投擲で決着まで）」、追跡中で届かない相手がいれば「fight <id>（迎え撃つ）」を足す（V3-2R2）。
- 投擲の候補（`valid_actions`）は、射程内で経路が通る相手だけを、自分を攻撃している相手から順に最大 3 件出す。有害と分かっている薬（`harmful`）は使う代わりに投げる候補になる。自分が投げた物を知っていれば `collect` が出る。
- 推定残り HP の文章: 記録が足りない間は「3 以上（記録 1 体）」のように下限だけを書く。
- キャンプの観測テキストは、遠征の観測の欄（見えるもの・地図など）を出さず、確定点・前回の払い戻し・候補（枠・倍率・危険度・推奨レベル）だけを書く。

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
  status: 'your_turn' | 'waiting_others' | 'dead' | 'ended' | 'at_camp'
  self: { entity（自分の全コンポーネント）, inventory: ItemView[], turns, regen }
  floor: { key, depth, biome, width, height, time, noWander }
  visibleCells: number[]                  // セル index
  entities: EntityView[]                  // 視界内のみ。モンスターの stats は hp バケット等に縮約済み
  memory: { terrain: number[] /*0=未知*/, remembered: RememberedEntity[] }
  identified: string[]
  monsterMemory: Record<string, MonsterMemory>
  notes: string[]
  runMode: 'solo' | 'coop'
  expedition: ExpeditionView | null      // 現在（または直前）の遠征。目的・状態・進捗（reached / guardianSlain / relicHeld / relicHeldByYou）・結果。守護者・遺物の居場所や ID は含まない
  camp: CampState | null                 // 遠征と遠征の間の候補 { nextNo, offers: { index, objective, points, relicGuarded }[] }
  deepestDepth: number
  record: { banked, lost, expeditions }   // スコア版 2 の確定点・失った戦利品・達成した遠征の数（v3）
  sense: { what, dir, range } | null      // 目標の気配（V3-2R）。memory.unsighted?: number[]（地形は知っているが見ていないセル）
  floorHint: { floor, draft: Dir | null, explored: 1|2|3|4 } | null   // 今いる階の手がかり（engine が計算して knowledge に書く。V3-2R2）
}
```

`EntityView` は v2 で `role?: 'guardian'|'relic'`、`damageSeen?`（モンスター）、`fleeing?` を持つ。V3-2R2 でモンスターに `speed`（素の速さ。見れば分かる性質。観測では自分との比較の 3 段階にする）を足した。v3 で `shot`（投擲の経路）、`firstSeenSeq`（このランで初めて見た seq）、`mine`（自分が投げた物）、`value`（宝）、`bounty`（賞金）を足した。`ExpeditionView` は v3 で `slot`・`traits`・`multiplierPct`・`haul`（共有の賞金・発見・撃破）・`maxDepth` を持つ。目的・深追い・宝の点は観測側で公開の式から計算する。

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
| 遠征（v2） | `expedition_offered` | camp（次の遠征の候補） |
| | `expedition_started` | expedition（通番・目的・基礎点・参加者。プレイヤーには目的と参加者だけを渡す） |
| | `objective_progress` | no, progressAfter, statusAfter, targetsAfter?, extractedAfter?（守護者・遺物の ID を含むので**俯瞰専用**） |
| | `objective_completed` | no, objective |
| | `haul_changed` | no, haulAfter（賞金・発見・撃破の after 値）, gains, reasons（v3。参加者に渡す。文章にするのは賞金と発見だけ） |
| | `expedition_ended` | no, reason（completed/withdrawn/lifeline/died/retired）, result, summary（ラン継続中はシード無し） |
| メタ | `thought` | player, text（状態は変えない） |
| | `chat` | player, text |
| 追加 | `player_state` / `player_stats` | プレイヤーの生死・離脱 / 撃破数・到達深度・死因 |
| | `turn_began` | actor, time（フロアの手番待ちと floor.time を設定） |
| | `floor_wander` | nextWanderAt |
| | `status_ticked` / `stats_changed` / `max_hp_changed` | 状態異常の残り手番 / 実効能力値（装備変更時）/ 最大 HP |
| | `feature_state` / `notes_updated` | 地物の状態（泉の使用済み等）/ 自分用メモ |
| 内部 | `rng_advanced` | 乱数ストリームの状態（プレイヤーには渡さない。観戦・HTTP には中身を空にして渡す） |

v2 で既存イベントに足した項目（いずれも後方互換。旧ログはそのまま畳み込める）:

- `damaged.dealt`: 実際に減った HP（とどめの超過分を含まない）。文章と「与えた最大ダメージ」の集計はこれを使う。`amount` は出目どおり。`damaged.seenTotals`: 見ていたプレイヤーごとの、その個体への累計実ダメージ（after 値。プレイヤーには渡さない）
- `died.maxHp`: 目の前で倒れた個体の最大 HP（見ていない者には伏せる）
- `actor_scheduled.regenAfter`: 自然回復の蓄積値（after 値）
- `player_state.state` に `at_camp`、`player_state.extractPos`（再開地点）
- `monster_memory_updated.memoryAfter.hpSeen`

v3 で既存イベントに足した項目（同じく後方互換）:

- `attack.fromDir` / `damaged.fromDir`: 姿の見えない攻撃者の来た方向（被害者にだけ渡す）
- `item_picked_up` / `item_dropped` / `item_equipped` / `item_unequipped` の `affixes`（文章に接辞名を出す）、`item_picked_up.auto`（自分が投げた物を歩いて拾った）
- `item_thrown.outcome`（`hit` / `missed` / `blocked` / `fell_short` / `no_target`）、`blockedBy`（`terrain` / `actor`）、`reached` / `reachedKind`（遮った・外れた相手）
- `knowledge_updated.shotsAfter`（見えている個体への投擲の経路）、`metAtAfter`（個体を初めて見た seq。reducer は代入だけ）
- `died.bounty`、`objective_progress.extractedAfter[].treasure`、`expedition_ended.result.payout { banked, lost, multiplierPct, parts, players[] }`
- `player_stats.stats.banked` / `lost`、`expedition_offered.camp.offers[].slot` / `traits` / `multiplierPct`、`expedition_started.expedition.slot` / `traits` / `multiplierPct` / `haul` / `progress.maxDepth`
- アイテムの `item.thrownBy`（投げた人。拾えば消える）と `item.value`（宝の価値。生成時に決まる）、モンスターの `bounty`

V3-2R で足した項目（同じく後方互換。会心と経験値のルールを変えたので `engineVersion` は 0.3.0）:

- `knowledge_updated.mappedAdd` / `mappedDel`（地形だけ知ったセル・目で見たので外すセル）、`senseAfter`（目標の気配。after 値）
- `objective_progress.progressAfter.crossedDepth`（踏破した最も深い階）
- `attack.attackerAffixes` / `targetAffixes`、`damaged.targetAffixes` / `sourceAffixes`、`died.affixes`、`item_thrown.reachedAffixes`（文章で接辞付きの名前を出す。見えていない側は伏せる）
- `level_up.gains`（上がった能力値）
- `StatusInst.source`（状態異常を与えた者。毒で倒したときの撃破者になる）、`status_applied.targetAffixes`
- `player_state.reason: 'joined'`（キャンプから始まる参加）。参加コマンドの `atCamp`
- プレイヤー向けの射影で、見えていた個体が視界の外へ動いた `entity_moved` に `dirOut`（向きだけ。行き先は伏せたまま）

V3-2R2 で足した項目（同じく後方互換。転移・守護者の選び方・群れの数で乱数の使い方が、候補と踏破で点の式が変わったので `engineVersion` は 0.4.0）:

- `item_issued { actor, item, kind, qty, reason }`（キャンプが持たせた品＝帰還の綱。状態変化は put/del。本人にだけ渡す）
- `knowledge_updated.hintAfter`（今いる階の手がかり `{ floor, draft, explored }` の after 値。変化したときだけ）
- `monster_memory_updated.memoryAfter.hitsByYou { melee?, thrown? }` / `hitsOnYou`（[命中, 回数]。相手が見えているときだけ数える）
- `objective_progress.extractedAfter[].lifeline`、`expedition_ended.reason: 'lifeline'`、`player_state.reason: 'lifeline'`
- 状態異常 `core:recall`（帰還中。行動不能、切れるとキャンプへ）
- `died` を見ていない者には `id`・`pos`・`maxHp` に加えて `kind`・`affixes` も伏せる（視界外で毒が倒した相手は「何か」）。射影で、自分が対象でない `via: 'poison'` の `damaged` は対象が伏せられていれば落とす（視界外の相手の体力・名前を出さない）
- エンティティの `SpawnSpec.minHp`（守護者の体力の下限。生成の内部）

プレイヤーに渡す際は `filterEventsForPlayer(events, playerId, view)` を通す: `seenBy` に含まれないものを落とし、見えていないエンティティ参照を `null` にし、`knowledge_updated` 等の他人向け・内部用イベントを除く。`PerceivedEvent` はそれに `text`（`narrate` の出力）を付けたもの。

---

## 6. Command ログ

```ts
CommandRecord {
  cseq: number
  player: PlayerId
  command: Command              // move / wait / pickup / ... / explore / travel / rest / extract / start_expedition
  source: 'mcp' | 'ws' | 'macro' | 'timeout' | 'bot' | 'system'   // system: new_run が最初の遠征を始める start_expedition
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
| `GET /api/runs/:id/index` | リプレイ用マーカー索引（フロア移動・撃破・死亡・遠征の開始／目的達成／終了などの seq）と `expeditions`（遠征単位の選択用） |
| `GET /api/leaderboard` | 記録の一覧。各項目に `scoreVersion`（1 / 2）。版 2 を先に、版 2 は確定点 → 達成した遠征の数 → 最深、版 1 は達成した遠征の数 → 最深 → スコアの順。キャンプ中の途中経過（`ongoing`）も含む（`controller.kind` は表示用）。版の違う記録は別の表として扱う |
| `GET /api/player/feed` | **ターンフィード**（SSE、v2）。`Authorization: Bearer <player_token>` か `?token=`。下記 |
| `GET /api/health` / `GET /api/config` | 生存確認 / `spectatorPolicy` |
| `GET /api/content/catalog` | 公開カタログ |
| `POST /api/runs` / `POST /api/runs/:id/join` | ランを開始・参加（`{ name, classId?, seed?, mode?, locale?, objective?, controller? }` → `{ runId, playerId, token }`）。開始時は最初の遠征まで始める |
| `GET /api/runs/:id/commands` | commands.jsonl（AI パネルのツール呼び出し・thought 表示用） |
| `GET /api/runs/:id/summary` | 終了時サマリー |

### 8.1 ターンフィード（`GET /api/player/feed`）

ホスト（AI を動かす側のループ）が「手番が来た」を外部から受け取る経路。ゲームの進行には影響しない（ソロでは手番を自動で進めない）。SSE の `event:` 名と `data:` の JSON（`FeedEvent`、`protocol.ts`）:

| event | data | いつ |
|---|---|---|
| `hello` | runId, playerId, seq, turn | 接続直後 |
| `turn` | …, turn, observation_text（brief。変化と状態行付き） | 自分の手番が来た（同じ手番では 1 回。マクロ展開中は送らない） |
| `idle` | …, seconds, turn | 手番のまま `idleNoticeMs`（既定 60 秒、`MUSE_IDLE_NOTICE_MS`）入力が無い。その間隔ごと |
| `ended` | …, scope: 'expedition' \| 'run', turn, text, summary | 遠征の終了（キャンプ）またはランの終了 |

参照ドライバ `npm run drive`（`packages/tools/src/drive.ts`）がこのフィードを購読し、差し替え可能な「エージェント呼び出し」（任意のコマンド実行／HTTP POST／内蔵ダミー）を呼ぶ。MCP のリソース購読通知は実装していない（任意項目）。
