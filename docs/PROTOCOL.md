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
      | 'recovery_failed'   // V4-1m: そのランはサーバーの起動時に復旧できなかった（message に理由。ランの記録は残っている）
      | 'confirm_required' | 'cannot_extract' | 'not_at_camp' | 'at_camp'     // 遠征（v2）
      | 'hostile_adjacent' | 'hostile_in_view' | 'hp_floor' | 'nothing_to_do'   // マクロが 1 歩も進めない（V3-2R。手番を使わない）
  message: string      // 何が起きたか
  hint: string         // 次に何をすればよいか
  details?: {
    blocked_by?: EntityId[]   // V4-1a: じゃまをしている敵（hostile_adjacent・blocked。そのプレイヤーに見えている敵だけ。hint にも名前）
    blocked_by_traps?: { id: EntityId; kind: string; pos: Pos }[]   // V4-1d: 道をふさいでいる罠（マクロの blocked。そのプレイヤーが見つけている罠だけ。経路の上で近い順。hint にも名前と位置）
    still_inside?: { id: PlayerId; name: string; floor: number }[]  // V4-1f: start_expedition が断られたとき、まだ迷宮にいる仲間と、その階（hint にも名前と階）
  }
}
```

エラー時の結果: `{ ok: false, error, valid_actions, turn }`（プレイヤーが束縛されていない `no_session` と、復旧に失敗したランの `recovery_failed` には `turn` が無い）。

**引数の名前がツールの定義に合わないとき**（S1c で改め、S1d で直した。SEASON.md §14.4 の 2・§15.11・§17.1）: MCP の SDK の入力の検査の前にサーバーが受けて、**ゲームの断りの形**（`bad_request`・`structuredContent`・`valid_actions`・`turn`）で返す。
- **共通の名前**（`thought`・`player_token`・`expect_seq`・`map`・`inventory`・`status_line`）は、どのツールでも受ける（そのツールの定義に無ければ捨てる。`thought` は、記録できるツールでは今までどおり記録する）。
- 断るのは、**要る引数が足りないとき**（「move には dir が要る（渡されていない）」。知らない名前もあわせて書く）と、**共通でない知らない名前が来たとき**（「travel_to に target という名前の引数は無い」）。`message` にこのツールの引数の一覧（要る・要らない・共通。定義の上では任意でも実際に要るもの（`throw_item` の `target`）は「要る」に書く）、`hint` に呼び方の例（`travel_to { to: 'stairs_down' } / …`）。別名は受け付けない。ツール一覧（tools/list）の「要る引数」は変えない。
- 断った呼び出しの活動の記録（観戦の AI パネル）には、知らない名前の引数の**値**を残さない（名前だけ `unknown_args` に）。名前違いでトークンを渡された場合のため。
- 名前は合っていて形が違う（型・値の範囲。`move { dir: 'north' }`）ときは、今までどおり SDK の入力の検査が断る（`isError: true`、文は `MCP error -32602: Input validation error: Invalid arguments for tool move: …`。`structuredContent` は付かない。S0b で確かめた。SEASON.md §7.3）。

`recovery_failed`（V4-1m）: サーバーの起動時の復旧（記録の再生）に失敗したランのトークンで再開・行動しようとした（MCP の `resume_run` とトークンを使うツール、`GET /api/player/feed`、WebSocket の `hello`（プレイヤー・観戦）、`join_run`・`POST /api/runs/:id/join`）。「見つからない」（`no_session`）とは分ける。`message` に、そのランの ID と失敗の理由（1 行）。ランの記録は消えていないので、サーバーを直して起動し直せば、同じトークンで再開できる。HTTP は 503

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
| `get_rules` | `topic?: 'overview'|'expedition'|'actions'|'combat'|'items'|'classes'|'observation'|'all'`, `locale?` | ルールブック。式・操作・遠征（戦利品・確定点・候補の枠と条件・危険度）・観測の読み方のみで、個別のモンスター数値は含めない。数値は `balance.json`（公開カタログの `rules`）から生成。`classes` は職業ごとの初期値・初期装備・成長（v3）と、習熟・特技の系統・特技の一覧・能動技の一覧（V3-4） |
| `list_runs` | – | 参加可能・再開可能なラン一覧と、開いているシーズン（`seasons: { id, name, budget, ends_at }[]`。S0 §9.1） |
| `new_run` | `character_name`, `class?`（`warrior`/`scout`）, `mode?: 'solo'|'coop'`, `seed?`, `locale?`, `objective?: 'auto'|'reach_depth'|'slay_guardian'|'retrieve_relic'|'endless'`, `brief_map?`, `map?`, `inventory?`, `status_line?` | `objective` を省くと**キャンプから始まる**（`at_camp`・`awaiting: 'camp_choice'`。最初の遠征も 3 候補から `start_expedition` で選ぶ。V3-2R）。`objective` を渡せば従来どおり最初の遠征まで始める（`auto` は 1 番目の候補 = 堅実・到達）。`{ run_id, player_token, player_id, briefing, observation, turn }`。`seed` を指定しても結果には返さない。`map` 以下は `set_options` と同じ（`brief_map: false` は `map: 'never'`）。不明な `class` のエラーは職業の一覧を返す |
| `new_run`（シーズン） | 上の引数に `season: string`（シーズンの ID）, `profile_token`（必須。運用者に招かれたプロフィールのもの） | S0（§9.1）。シーズンのシードでソロ、Lv1 のキャンプから始まる。`seed`・`mode`・`objective`・`legacy` は使わない（継承は受けない）。参加できないときは `season_unavailable`（理由は message。トークンが無い・招かれていない など） |
| `join_run` | `run_id`, `character_name`, `class?` | 同上（COOP。キャンプから始まる。進んでいる遠征には入らず、次の遠征から一緒に出る。V4-1g） |
| `resume_run` | `player_token`, `map?`, `inventory?`, `status_line?` | 現在の MCP 接続にプレイヤーを再束縛する。**再開ブリーフィング**（遠征の目的と進捗、現在地、直近の節目 最大 10 件、自分のメモ）＋ `observation` ＋ `turn` |
| `retire` | `confirm: true` | ランを終了する（キャラクターは戻らない）。スコアを記録。遠征中なら、その遠征の戦利品は失う（キャンプで引退すれば確定点はそのまま） |

### 2.1.1 遠征（v2、v3 で戦利品と確定点）

| ツール | 引数 | 結果 |
|---|---|---|
| `expedition` | – | 遠征の目的・達成条件・進捗（ブリーフィング）。キャンプでは次の遠征の候補。手番を消費しない。V3-6: 進行中なら途中経過（`progress: { combat, tempo }` と 3 行）、キャンプなら直前の遠征のレポート（`report`） |
| `review` | `expedition?: number` | V3-6。終わった遠征のレポート（`report`。省略時は直前の遠征）。文は 12 行のレポートに、入りきらなかった場面と、倒れる直前の出来事を足したもの。手番を消費しない |
| `extract` | `confirm?: boolean`, 共通引数 | 行動。階段（上り・下り）の上なら可（V3-2R2: 追跡中の敵が見えていてもよい。敵は階段を追ってこない）。目的を達成していれば**帰還**（遠征は `completed`、戦利品 × 倍率を確定）。未達成なら `confirm: true` で**撤退**（`withdrawn`、(戦利品 − 目的) × `withdrawPct`% を確定）。`confirm` が無ければ `confirm_required`。確定する点は観測の `expedition.haul.if_extract_now` と一致する。所持している宝は換金され、達成して持ち帰った遺物は納められ、どちらも所持品から消える |
| `report_stairs` | 共通引数 | S0（§9.4）。シーズンのランのキャンプで、このランで自分の目で見た下り階段のうち、まだ報告していないものを全部報告する。手番を消費しない。最初の報告者に貢献 1。結果に `stairs_reported` の 1 行と `season` |
| `place_fire` | 共通引数（`thought`・`expect_seq`） | S1（§9.10）。シーズンのランの迷宮の中で、自分のいるマスに野営の火を置く（1 手番）。費用は 深さ × 200 点を、このランの確定点から。置けないときは理由つきで断る（手番を使わない） |
| `start_expedition` | `offer: 1..n | 'endless'` | キャンプで次の遠征を始める。前回 `extract` した階段から再開する。結果に `briefing`（目的・枠・条件・倍率・戦利品の説明） |

スコア（版 2、v3）: ランのスコア = 確定点（`banked`）の合計。遠征の払い戻しは、帰還 = 戦利品 × 条件の倍率、撤退 = (戦利品 − 目的の基礎点) × `withdrawPct`%（初期値 50）、帰還の綱 = (戦利品 − 目的の基礎点) × `lifeline.pct`%（初期値 50。倍率なし。目的を達成済みでも目的の点は運ばず、遺物は失う。V3-2R2、V3-4b で改め）、死亡・引退 = 0（失った戦利品 `lost` として記録）。結果の段階は 4 つ（階段で帰還・綱で帰還・階段で撤退・死）。戦利品の内訳 `HaulParts` は `objective`（達成で基礎点）・`overreach`（踏破: 目標より深い階の**下り階段に立ったとき**。着いただけでは入らない。n 階目 = 目的の基礎点 × (`overreachPct.first` + `overreachPct.step` × (n − 1))%、下限 `overreachFirst` + `overreachStep` × (n − 1)。V3-2R2）・`treasure`（所持している宝の価値）・`bounty`（守護者の賞金）・`discovery`（このランで初めて倒した種族・鑑定したアイテム種。守護者の撃破は数えない）・`kills`（撃破の点 = 種族の経験値 × `killPerXp` × 深さの係数、接辞付きは × `killAffixPct`%。V3-2R3）。宝を除く部分は遠征の参加者で共有し、extract した各自に払い戻す。係数は `balance.json` の `haul`。

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
| `move` | `dir` | 敵対者がいれば近接攻撃、閉じた扉は開ける。近接の手番コストは武器の「速い」で 70、歩く手番のコストは重い鎧で 110・125（V3-4） |
| `attack` | `target: entity_id` | 近接攻撃（V3-4）。隣の敵か、長柄の武器（槍）なら縦・横・斜めの直線で 2 マス先の敵（間のマスが通れて誰もいない）。届かなければ `out_of_range`（手番を使わない）。`fight` も長柄なら 2 マス先から突く |
| `use_ability` | `ability`（または `id`）, `target?: dir | entity_id`, `slot?` | 能動技（V3-4 §4.2。V4-1g で `ability` を足した。どちらも無ければ、要る引数の名前を言うエラー）。`id` は `self.abilities` の短い ID（`bash`）か完全な ID（`core:bash`）。資源は無く、再使用までの手番（`cooldown`）と、立て直しだけ遠征ごとの回数で管理する。覚えていない・残りの手番がある・回数を使い切った・対象が無いときは手番を使わずに拒否（`cannot_use` / `no_target` / `invalid_direction` / `blocked`）。対象: 隣の敵（強打。ID か方向、隣に 1 体なら省略可）、投擲の対象（狙い撃ち。射程と射線は `throw_item` と同じ検証、`slot` 省略時は投擲用の品の最初のスロット）、方向（身をかわす）、なし（なぎ払い・立て直し）。結果のイベントに `ability_used`（`cooldownLeft` はこの手番の後の残り） |
| `wait` | `turns?: 1..10` | 追跡中の敵が見えなければ休息（回復が `restMultiplier` 倍）。`turns` が 2 以上ならマクロ（V3-2R2）: 敵が新たに見えた（`hostile_in_view`）・起きている敵が隣に来た（`hostile_adjacent`）・攻撃や毒以外の被害・状態異常で止まり、指定の手数で `max_turns` |
| `rest` | `until_hp?`, `max_turns?` | マクロ。全快（かつ毒が抜ける）か、指定の HP・手数か、中断まで（上限 `rest.maxTurns`） |
| `explore` | `mode?`, `hp_floor?`, `pickup?`（既定 true）, `toward?: 'draft'`, `max_steps?: 1..200` | マクロ。`max_steps`（S1b）はその手数で止まる（`max_turns`。既定は 1 回の上限 200）。`toward: 'draft'` は下への風が消えたら（公開された階段を自分の目で見たら。S1b）`stairs_seen` で止まる。**その方角に行ける未探索の境界が無くなったら止まる**（`toward_exhausted`。始める前なら手番を使わずに断る。`mode: 'flee'` は止まらずに、ほかの方角の境界へ。S1c）。遠回り・道が回り込んでいるために方角と違う向きへ歩いたら、結果の文に理由を書く（S1b）。未見の区画（地図の巻物で地形だけ知った区画を含む）へ自動移動。pickup（既定 'useful'。V3-4b）なら通り道と見えている・記憶したアイテムも拾う（'useful' は、鑑定済みで接辞の無い武器・防具のうち公開の数字が装備中の品以下のものを種類が違っても拾わない。true は全部。遺物・鑑定済みの有害品・装備中の品と同じ種類で接辞が含まれる＝同じか劣る装備は拾わない。V3-2R3）。`toward: 'draft'` は下への風の方角、`'sense'`（V3-4b）は遺物・守護者の気配の方角（と隣り合う方角）の未探索を優先する（V3-2R3）。決めた行き先は境界である間は追い続け、見えて消えたらそのすぐ近くの境界を追う（風の方角が歩くたびに変わっても往復しない。2026-11-17） |
| `travel_to` | `to: {x,y} | 'stairs_down' | 'stairs_up' | entity_id`, `mode?`, `hp_floor?`, `pickup?` | マクロ。既知地図上のみ。目的地がアイテムなら着いて拾う |
| `collect` | `what?: 'thrown'|'items'`, `within?: 1..200`, `kinds?: string[]`, `all?: boolean`, `mode?`, `hp_floor?` | マクロ（v3）。`thrown`（既定）は既知の自分が投げた物、`items` は見えている・記憶したアイテムを近い順に回って拾う。結果に `collected: { picked, remaining }`。V3-8: `within` は歩数の上限（既定 15。残りがどれも遠ければ `collect_far`）、`kinds` は種類 ID か区分、`items` は鑑定済みで今の装備より劣る装備を飛ばす（`all: true` で拾う） |
| `fight` | `target: entity_id`, `with?: slot`, `hp_floor?`, `abilities?: string[]`, `until?: 'target'\|'clear'`, `adjacent?: 'throw'\|'melee'\|'stop'`, `approach?: 'wait'\|'advance'` | マクロ（V3-2R、V3-2R2 で拡張）。`approach`（V4-1a、`with` なし）: `wait`（既定）は相手が隣に来るのを待つ。`advance` は相手へ向かって歩き、隣に着いたら殴る（歩く間に撃たれても止まらない。`hp_floor`・`hp_risk`・新しい敵・予備動作・見失いなどの止まり方はそのまま。経路がふさがれていれば `blocked`）。`until: 'clear'`（V3-4b）: 標的を倒した後も、隣の追跡中の敵、いなければ最も近い追跡中の敵へ続け、いなくなれば `cleared`。`adjacent`（V3-4b、with のとき）: 相手が隣に来たら stop（既定）／throw（投げ続ける）／melee（近接に切り替える）。新しく見えた追跡中の敵で止まるのは被弾の記録の無い種族だけ。追跡中で逃げていない標的が見えなくなったら `fight.lostWait`（5）手番まで待つ（逃げて見えなくなったら `target_fled`）。待つ手番に標的以外の射撃で被弾したら `shot_while_waiting`。`abilities`（V3-4a）: 並べた能動技を使える手番ごとに使う。強打は標的が隣、なぎ払いは起きている敵が隣に 2 体以上、狙い撃ちは `with` の品で射程と射線が通るとき（それ以外の手番は通常の攻撃）。立て直し・身をかわすは載せられない、覚えていない、`with` の無い狙い撃ちは手番を使わずに `cannot_use`。結果の文に使った能動技と回数。その相手と決着を付ける。`with` なし: 隣なら近接攻撃を繰り返す。相手が追跡中で届かない間は隣に来るまで待つ（最大 10 手番、`target_not_approaching`）。当てて逃げる相手は追跡中で 2 マス以内なら 2 手番まで待つ（追わない）。`with`: そのスロットの品を投げて戦う（射程と射線が通るまで待つ）。止まるのは: 相手が倒れた（`target_down`）・離れた／逃げて射程を出た（`target_moved`）・見えなくなった（`target_gone`）・（`with`）隣に来た（`target_adjacent`）・品が尽きた（`out_of_ammo`）・射線が 3 手番続けて通らない（`no_line_of_sight`）・HP が `hp_floor`（既定 50%）以下・**次の手番に、届く追跡中の敵（隣・飛び道具）から 1 手の最悪の被害（`worst_turn` の合計）を受けると `hp_floor` を割る（`hp_risk`。被弾の前に止まる。始める前なら `hp_floor` のエラーで拒否）**・被弾の記録の無い種族から初めて被弾した（`first_hit`。一度だけ）・追跡中の別の敵・状態異常（V3-2R3）。眠っている・気付いていない相手は待たない（`target_not_hunting` で拒否。断りの文に `approach: 'advance'`）。**`approach: 'advance'` なら、眠っている・気付いていない相手にも寄って殴る**（S1b。途中で気づかれたらそのまま続ける。近づけたかは、追跡中の相手は直線の距離、そうでない相手は道のりで数える）。`with` の品が尽きたとき、自分の投擲物を拾いに行くのは隣に追ってくる敵がいない間だけ（いれば `out_of_ammo`。S1b）。結果の `outcome` に与えた攻撃（投げた）回数・命中・合計・待った手番 |
| `pickup` | `item?: entity_id` | 省略時は足元の全て（入る分だけ） |
| `drop` | `slot`, `qty?` | |
| `equip` / `unequip` | `slot`, `confirm?`（equip のみ） | 呪いと分かっている品の equip は `confirm: true` が要る（無ければ `confirm_required`。V3-8）。装備すると、未鑑定の種類（装飾品）は正体が、装備品は呪いの有無が分かる（V3-4）。呪われた装備は外せない・同じ場所に別の品を付けられない・捨てられない（`cannot_use`） |
| `use_item` | `slot`, `target?: dir | {x,y} | entity_id`, `target_slot?` | `slot` は正体の分かっている品の種類 ID でもよい（V3-8。スロット順で最初の品）。帰還の綱（`core:lifeline`。V3-2R2）は使うと、`lifeline.turns` が 0（V3-2R3 の既定）ならその手番でキャンプへ戻る。1 以上ならその手番のあいだ行動できず（状態 `core:recall`、その間も攻撃は受ける）、切れるとキャンプへ戻る。達成した遠征の数には入らない。遠征の開始時にキャンプが 1 本にそろえる。捨てる・投げることはできず（`cannot_use`）、所持数に数えない。`target_slot`: 鑑定の巻物で鑑定する品（省略時はスロット順で最初の未鑑定品か、呪いの有無を確かめていない装備品。読んだ巻物自身の種類は除く。V3-4）。解呪の巻物と祭壇は所持品すべての呪いを解く。引数の形が合わないときもゲームのエラー形式（`bad_request`・hint・valid_actions）で返す |
| `throw_item` | `slot`, `target: {x,y} | entity_id` | 投擲の経路は双方向（自分→相手の直線か、相手→自分の直線を逆にたどったもののうち通る方。敵の射撃も同じ経路。V3-2R2）。ID 指定で経路が通らない相手は `no_line_of_sight`、射程外は `out_of_range`（どちらも手番も品物も失わない。観測の `shots`）。座標指定は遮られた位置か射程の端に落ちる。結果は必ず 命中 / 外れ / 遮られた / 届かない / 誰もいない と落下地点で書く。自分が投げた物はそのマスに入るだけで拾う（追加の手番なし） |
| `interact` | `dir?` | 扉の開閉、地物の操作。省略時は足元 |
| `use_stairs` | – | 足元の階段 |
| `say` | `text` | COOP 用チャット。手番を消費しない |
| `choose_boon` | `option: 1..n | boon_id` | 加護を選ぶ（V3-3 §3.2: 節目の大守護者を倒したときの候補 `self.boon_choice`）。**手番を消費しない**。キャンプでも呼べる。候補が無ければ `nothing_to_do` |
| `choose_perk` | `option: 1..n | perk_id` | 特技を選ぶ（V3-4 §4.1）。**手番を消費しない**。自分の手番でなくても、キャンプでも呼べる。選ぶまで進行は止まらない（保留できる）。候補は `self.perk_choice`。保留が重なれば古い順で、次の候補はその後に引く。候補が無ければ `nothing_to_do` |

行動結果:

```ts
ActionResult {
  ok: true
  outcome: string                 // 1〜2 文の結果要約
  steps?: number                  // マクロで実際に進んだ手数
  interrupted_by?: string         // マクロの停止理由 'hostile_in_view' | 'hostile_alerted'（見えている敵が追跡に変わった）| 'intent'（見えている敵が新しく予備動作を見せた。V3-3）| 'hostile_adjacent' | 'attacked' | 'damaged' | 'blocked' | 'trap_ahead'（次のマスが発見済みの罠で、ほかに道が無い）| 'stairs_seen' | 'hp_floor' | 'hp_threshold' | 'arrived' | 'explored' | 'collected' | 'target_down' | 'target_moved' | 'target_gone' | 'full_hp' | 'target_hp' | 'max_turns'
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
  - どの mode も 1 歩ずつ通常の `move` として記録し、敵は通常どおり攻撃する。マクロは攻撃しない（次のマスに敵がいれば `blocked`。steady・flee は、ふさいでいる相手が逃走中なら攻撃して進み、ほかに道が無いときは逃走中の敵のマスを通る経路を引く）。発見済みの罠は踏まない（罠を通る道しか無ければ罠の手前で `trap_ahead`。始める前なら `blocked` で拒否し、`details.blocked_by_traps` にその道の上の罠、ヒントに罠の名前と位置と `move { dir: '<罠の方角>' }`。V4-1d）。経路探索で避ける「見えている動かない敵の隣」は、その呼び出しの間に一度見た動かない敵も含む。その呼び出しの間に眠っているのを見た敵は、見えなくなってもそのマスをふさいでいるものとして道を引く（そのマスが見えていなくなっていれば忘れる。ふさがれて `blocked` になれば `blocked_by` に入る。S1b: 見えると避け、見えないと通る、で 2 マスを往復した）。travel_to の「20 手のあいだ道のりが縮まない」（`no_progress`）は、動かない敵・眠っている敵・発見済みの罠が新しく見えたら、そこから数え直す（S1b: 通路をふさぐ敵が見えて遠回りに変わった後、前の短い道のりと比べて止まっていた）。`rest` は敵が視界に入ると状態によらず止まる（動かない敵は隣にいなければ休息を妨げない。V3-2R2: すでに見た個体が逃げながら視界を出入りしても止まらない）
  - careful と steady は、その階の下り階段を初めて見たときにも止まる（`stairs_seen`。flee は止まらない。V3-2R2）。止まる前に足元の拾える品を 1 つ拾う。経路探索は、見えている動かない敵の隣のマスを罠と同じく避ける（ほかに道が無ければ通る）
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
  alerts: Alert[]                      // 重要度順。例 { code:'enemy_adjacent', text, entity?, data? }（data: incoming / escape の数値。V3-2R2。シーズンの budget_low。S1b）
  self: {
    name, class, level, xp, xp_next
    hp, max_hp, statuses: {id, turns_left}[]
    pos: {x,y}, floor: { depth, biome_name, time, draft?: Dir, explored?: 1|2|3|4, hint_text? }
                                    // draft: 下への風（今いる階の下り階段を見ていない間の 8 方向。遠近は出さない）、explored: 通れるマスのうち見た割合の 4 段階（約 1/4・半分・3/4・ほぼ全て）。V3-2R2
    equipment: { weapon?, armor?, accessory? }     // 表示名
    attack: { acc, dmg, throws?: { slot, name, dmg: string|null, acc, range }[] }, defense: { eva, armor }   // throws: 投げられる持ち物（acc は自分の命中込み。V3-2R）。V3-4: attack.acc に近接の習熟と装備、throws[].acc に投擲の習熟と装備を含む
    inventory_count, inventory_capacity   // inventory_count は手放せない品（帰還の綱）を数えない
    inventory?: { slot, name, qty, category, identified, equipped, value?, stats?, curse? }[]   // full のみ。value は宝の価値、stats は鑑定済みの性能（weapon {dmg,acc,traits?} / armor {armor,eva,move_cost?,wake_pct?} / throw {dmg,acc,range} / mods（装飾品の修正と接辞の追加の修正）。接辞込み）。curse: 'unknown'（呪いの有無を確かめていない装備品）/ 'cursed'（呪われている。外せない）。V3-4
    inventory_brief?: string        // brief のみ（例 "a)小剣*[1d6・命中+1] c)投げナイフx8[投擲1d4+1・射程7・命中+1]"。* は装備中）
    turns: number                   // 自分が行動した手番数
    speed: number                   // 実効の速さ（標準 100。状態異常込み。v3）
    score: { banked, expeditions_completed }   // 確定済みの点と達成した遠征の数（v3）
    rest_estimate?: { hp_to_full, turns, time, wander_expected: string /* 例 "0〜1" */, blocked_by?: 'poisoned', lowest_hp?: number /* 毒のとき、抜けるまでの最低 HP（V3-2R2） */ }  // HP が減っていて、休めるときのみ（追跡中の敵が見えている間は出さない。V3-2R）
    perks: { id, name, ranks }[]                                 // 取った特技（V3-4）
    abilities: { id /* 短い ID */, name, cooldown_left, uses_left?, target: 'adjacent'|'throw'|'dir'|'none' }[]   // 覚えた能動技。cooldown_left 0 なら使える。uses_left は遠征ごとの回数の残り（立て直し）
    recovery: ({ kind: 'ability', id, name, ready, amount } | { kind: 'item', slot, name, qty, amount })[]
        // V4-1c: いま知っている回復の手段（使うと自分の HP が回復する能動技と、正体の分かっている品。効果の定義から決める。未鑑定の品は入らない）。
        // ability の id は use_ability の短い ID、ready は abilities の「使える」と同じ（cooldown_left 0 で回数が残っている）。item の slot は use_item の slot。
        // amount は説明の文（例「2d8+4（最大 HP の 30% を下回らない）」「最大 HP の 25%」）。無ければ空の配列
    perk_choice?: { level, options: { option, id, name, desc, lineage }[], more }   // 選べる特技の候補（choose_perk）。more は後に控えている候補の数
  }
  visible: {
    monsters: { id, name, pos, dir, dist, hp_state: 'healthy'|'wounded'|'badly_wounded'|'near_death',
                awareness: 'asleep'|'unaware'|'hunting', threat: 1|2|3|4|5|null, statuses,   // null: 攻撃を受けた記録が無い種族（不明・初見。V3-2R）
                worst_hit: number|null,                       // その種族から受けた最大の一撃（会心を見ていれば会心の値）。守護者は守護者の記録（guardian|種族）から
                worst_turn: number|null,                      // 1 手番あたりの最悪の被害 = worst_hit × 自分の 1 手番に相手が行動する回数（速さの比の切り上げ。V3-2R3）
                size?: 'small'|'large',                       // 体格（並は出さない。V3-2R3）
                dealt?: { melee?: [sum, n], thrown?: [sum, n] },   // 通りの記録: 自分の攻撃が当たったときの実ダメージ（V3-2R3）
                speed: 'slow'|'normal'|'fast',                // 自分の今の速さとの比較（見れば分かる。V3-2R2）
                traits: ('pack'|'ranged'|'stationary'|'armored'|'rusting'|'pierce')[],   // 見れば分かる特徴（種族の公開タグ。V3-2R2。armored = 素の装甲 3 以上、V3-2R3。rusting = 当たると錆びる・pierce = 射撃が装甲を無視、V3-5a）
                first_seen?: true,                            // 本当に初めて見た種族（threat null の文が「不明（初見）」になる）
                hits?: { your_melee?: [hits, tries], your_thrown?: [hits, tries], theirs?: [hits, tries] },   // 命中の記録（種族ごと。守護者は守護者のその種族。ランを通した数。確率は出さない。文は「この種族の記録: あなたの命中 近接1/6・相手の命中 3/5」。V4-1m §39.1）
                role?: 'guardian', fleeing?: true,            // 守護者 / 手負いで逃走中
                objective?: true,                             // この遠征の目的の相手（目的の守護者・大守護者・賞金首。V4-1a。文は名前の後ろに「［目的］」）
                damage_seen?: number,                         // 見ている間にこの個体が受けた実ダメージの合計
                hp_left_est?: { min, max: number | null, samples, record: { min, max } },   // 体力の記録がある種族のみ。記録が estimateMinSamples（5）体未満は max: null。record は記録した個体の体力の範囲（標本）
                shot: 'clear' | 'blocked',                    // 自分のセルから投擲の経路が通るか（v3）
                shots: { slot, state: 'clear'|'blocked'|'out_of_range' }[],   // 投げられる持ち物ごと（V3-2R）
                bounty?: number,                              // 倒すと戦利品に入る賞金（v3）
                guardian?: { name, types: { id, name }[], weakness?: { id, name } },   // 守護者の「称号＋名前」・型・分かった弱点（知るまで無い。V3-3）
                intent?: { code: 'winding_up'|'summoning'|'enraging', dir?, on_line?, text } }[]   // 予備動作（見えている間だけ。on_line = 突進の直線の上に自分がいる。V3-3）
    items:    { id, ids?, name, pos, dir, dist, qty, role?: 'relic', objective?: true, remembered?, mine?: true, value? }[]   // objective: この遠征の目的の遺物（V4-1a）
              // 同じセルの同種は 1 行（ids に全て）。mine = 自分が投げた物、value = 宝の価値（v3）
              // 自分が投げた物は見えている・記憶したものを全部で 1 行にまとめる（qty = 本数、pos = 最寄り、ids = 全て、near_qty = 最寄りのマスの本数。V3-2R2）
    items_omitted?: number          // 記憶の中の遠いアイテムのうち省いた件数
    players:  { id, name, pos, dir, dist, hp_state }[]
    features: { type, pos, dir, dist, state?, desc? }[]   // 階段・扉・泉・発見済みの罠 など。desc: 何であるか・どう使うかの 1 行（V4-1g。すべての地物にある）
  }
  party: {                             // V4-1f: 自分以外の参加者（参加の順）。ソロのランでは空の配列
    id: PlayerId, name, controller: 'human' | 'agent' | 'unknown', order: number   // order: 参加の順（1 から。自分の番号は、抜けている番号）。unknown: 参加のときに人間か AI かを言わなかった（V4-1g）
    status: 'in_dungeon' | 'at_camp' | 'down' | 'left'                 // 迷宮にいる・キャンプにいる・倒れている・ランを抜けた
    floor?: number                       // 迷宮にいるときの階（見えていなくても出す）
    hp?: HpState                         // 迷宮にいる仲間の HP の段階（V4-1g から、見えていなくても・別の階でも出す）
    pos?: [x, y]                         // 同じ階にいるときは、見えていなくても出す（V4-1k。それまでは見えているときだけ）。別の階の仲間は階だけ
    entity?: EntityId                    // 同じ階にいて、見えているときだけ（visible.players の id と同じ）
    last_act: number                     // V4-1j: その仲間が自分で最後に行動した時点（その仲間の手番数で数える。ゲームの中の数えで、実時間ではない）。時間切れでゲームが代わりに待たせた手番は数えない。見えていなくても・別の階・キャンプでも出す。前の観測と同じなら、その間に自分では動いていない。何をしたか・どこにいるかは出さない
  }[]
  navigation: {
    here: string                         // 足元の地形・アイテム
    passable_dirs: Dir[]
    frontiers: { pos, dir, dist }[]      // 未探索との境界（近い順、上限 5）
    known_stairs: { type:'down'|'up', pos, dist, reachable, path_len: number | null, occupied_by?, sealed?: true }[]   // path_len: 既知地図上の経路長。sealed: 大守護者を倒していない節目の下り階段（V4-1a）
    collectable: { count, ids }          // 引数なしの collect（what: items）が拾いに行く品: 既定の範囲（15 歩）の内側で、collect と同じ経路で着ける品（V4-1a）。valid_actions の collect の件数はこれ
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
    result?: { reason, points, deepest, kills, turns, text,   // 終了した遠征
               banked, party_banked?, shares?: { id, name, banked, lost, how }[] }   // V4-1g: banked はあなたの確定、party_banked は全員の合計（協力プレイ）。shares はだれの分か（how: completed / withdrawn / lifeline / lost）
    slot?: 'safe'|'standard'|'ambitious', traits?: string[]    // v3
    haul?: {                           // 未確定の戦利品（v3）
      total, multiplier_pct, parts: { objective, overreach, treasure, bounty, discovery, kills }
      if_extract_now: number           // 今 extract したら確定する点（帰還なら × 倍率、撤退なら (total − objective) × withdrawPct%）
      if_lifeline_now?: number         // 帰還の綱を今使った場合の確定点（綱を持っているときだけ。V3-2R2）
      next_overreach: { depth, points, at: 'stairs_down', path_len: number|null, dir?: Dir } | null   // 次に踏破の点が入る階（その階の下り階段に立てば入る）。今いる階なら既知の下り階段までの経路長、未発見なら下への風の方角 dir
      next_camp: { min_target_depth, recommended_level } | null   // 今帰った場合の次の候補の下限と推奨レベル（目標として達成した最深の階から。踏破では深くならない。V3-2R3）
      text: string                     // 戦利品の 1 行（テキストでは遠征の行に続けて 1 行にする）
    }
    sense?: { what: 'guardian'|'relic', dir, range: 'far'|'near', text }   // 目標階にいる間の気配（10 マス以内が near。正確な位置は出さない。V3-2R）
  }
  camp?: { next_no, offers: { index, type, target_depth, points, text, guardian?: { rank: 1|2|3, traits: ('fast'|'slow'|'ranged'|'large'|'armored')[] },   // 守護者の見込み（種族名は出さない。V3-2R3）
           slot?, traits?, multiplier_pct, recommended_level: number | null, level_gap: number | null, trait_danger: number }[] }   // キャンプ（遠征と遠征の間）のみ
  recent_events: string[]              // 前回の行動結果以降に知覚した出来事の文章（最大 10）
  map?: { origin:{x,y}, rows: string[], legend: Record<string,string> }  // 自分中心の局所 ASCII（既定 21×15。フロア外は出さない）
  valid_actions: string[]              // 例 "move e (attack ゴブリン)", "use_item a (回復の薬)", "use_stairs"、"use_ability bash target:e_xxxxxx (強打: …)"
                                       // 1 行の形（V4-1g）: `<ツール> [<主な引数>] [<名前>:<値> ...] (<説明>)`。主な引数はツールごとに 1 つ（move・interact の dir、fight・attack の target、
                                       // travel_to の to、use_item・equip・throw_item の slot、use_ability の ability）。`<a|b>` はどれか 1 つ。値の `[a,b]`・`a,b` は並べたもの（`fight` の `with`・`abilities`。配列でも、書いてある文字列のままでもよい）。説明が「不可」で始まる行は、今は使えない知らせ
}
```

- `threat` は「自分の現在 HP」と「思い出にある観測済み最大ダメージ／未知なら深度からの控えめな推定」から出す。PlayerView 外の値は使わない。
- `alerts` の主なコード: `low_hp`, `critical_hp`, `enemy_adjacent`, `incoming`, `lethal_range`, `escape`, `poisoned`, `on_stairs`, `item_here`, `inventory_full`, `new_floor`, `can_extract`, `at_camp`, `perk_pending`（V3-4。`data: { level, options, more }`）。
  - `incoming`（V3-2R2。`multiple_enemies` を置き換え）: 自分に届く追跡中の敵（逃走中を除く。動かない敵は隣にいるときだけ）が 2 体以上。`data: { hunting, worst_sum, unrecorded, hp }`。worst_sum は種族ごとの `worst_hit` を個体ごとに足したもの（思い出の記録だけ）。
  - `lethal_range`: 追跡中の敵の `worst_turn`、または記録のある追跡中の敵の `worst_turn` の合計が今の HP 以上（V3-2R3 で `worst_hit` から変更）。`lethal_2turns`: 合計の 2 倍が今の HP 以上。
  - `escape`（V3-2R2）: 追跡中の敵が見えていて、既知の階段に辿り着けるとき（階段の上では出さない）。`data: { stairs: 'up'|'down', path_len, faster, worst_if_chased, hp }`（faster = 自分より速い追跡中の敵の数。worst_if_chased = 敵ごとの「歩く間に攻撃できる回数 × 受けた最大の一撃」の合計、記録の無い敵がいれば null。V3-2R3b、V3-4b で速さを入れた）。人間向け UI にも同じものを表示する。`alerts` は現在の状態、`turn.changes` は前回からの差分。
- `hp_left_est` は思い出の `hpSeen`（目の前で倒した個体の最大 HP の範囲。守護者は除く）、`hp_state`、`damage_seen` だけから計算する（`hpLeftEstimate`）。記録の範囲と矛盾する（接辞・深層強化で頑丈な）個体には付かない。
- `rest_estimate` は engine と同じ式（`regenInterval`・`regenStep`）と自分の回復の蓄積値（`self.regen`）で数える。中断が無ければ `rest` の実績と一致する。
- `fleeing`: 逃走の閾値（種族データの `fleeBelowHpPct`）を下回った追跡中の敵。逃走中の敵は `extract` と休息を妨げない。
- 目安: brief は約 400 トークン以内、full は約 1,500 トークン以内。`map` は brief では既定で付け、`new_run` のオプション `brief_map: false` で外せる。
- 地図（v3）: モンスターは種族ごとに固定の 1 文字（content の `glyph`。一意）。テキストでは上の 2 行が x 座標の 10 の位・1 の位、行頭が y 座標の目盛り。`get_map` も同じ。10 の位は 10 の倍数の列にだけ書く（範囲に 10 の倍数が無い狭い地図だけ、左端に書く。S1b: 左端が x=1 の地図で、左端の「0」をその列の x=0 と読んで 1 列ずれた）。
- 帰還の綱を持っていれば `valid_actions` に「use_item <slot>（帰還の綱: その場でキャンプへ戻る・+N 確定・追跡中の 1 手の最悪の被害 …）」（危なくないときは短い行）。階段の上の extract には「次の遠征はこの階段から始まる。階の敵は追跡をやめて全快する」、綱には「次の遠征はこの遠征を始めた階段から」、射撃する敵には fight の待ち受けではなく「travel_to <id>（近づく／視線を切る）」（V3-2R3a）、追跡中の敵が届くときの階段への移動には「階段まで N 歩。追われたままなら最悪 M の被害（HP h）」（M が HP 以上で綱を持っていれば綱の候補を先に。V3-2R3b）、隣に起きている追跡中の敵がいるときの薬・巻物には「使う間に隣の敵が行動する」を添える。同じか劣る装備には equip を出さない（未鑑定の指輪・首飾りには出す）。下への風があれば「explore toward:draft」（V3-2R3）。特技の候補は「choose_perk <n>（名前: 説明）」（自分の手番でなくても・キャンプでも出る）、能動技は使えるものを対象付き（「use_ability bash -> e_xxx」「use_ability slip <dir>」「use_ability cleave」）、使えないものを残りの手番付き（「use_ability bash（あと 3 手番）」）、長柄なら「attack <id>（2 マス先から突く）」（V3-4）。投擲の候補があれば「fight <id> with:<slot>（投擲で決着まで）」、追跡中で届かない相手がいれば「fight <id>（迎え撃つ）」を足す（V3-2R2）。
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
| | `actor_scheduled` | id, nextActAt（手番終了時）, turns, acted?（V4-1j: 自分で出した命令で行動した） |
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
| | `expedition_ended` | no, reason（completed/withdrawn/lifeline/died/retired、S0 で time_up）, result, summary（ラン継続中はシード無し） |
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

S1d で変えた項目（S1c の検査の指摘の直しと、設計の判断 SEASON.md §16.2。`engineVersion` 0.42.1、思い出の `maxPlainToYou` と `dmgOnYou` の 3 つ目の欄、`fire_return.reason: 'damaged'` が増えたので `eventVersion` 28。SEASON.md §17）:

- **すべてのラン**
  - 引数の名前の断り（§1.1）: 共通の名前はどのツールでも受ける。断るのは要る引数が足りないときと、共通でない知らない名前のとき。断った呼び出しの活動の記録に、知らない名前の値を残さない
  - fight の判定を 2 つに（§2.3）: **死にうるなら止まる**（今の HP が最悪＝全員が記録の最大の一撃・会心を含む、以下なら、`hp_floor` によらず止まる・始めない）／**`hp_floor` の判定は見込み**（いちばん重い 1 体は記録の**会心でない**最大の一撃、残りは平均。会心でない記録が無ければ最大）。止まった文・断りの文に、どちらで止まったか（「死にうるので止まった: HP 20 が最悪 20 以下」「hp_floor で止まった: HP 35 − 見込み 12 が hp_floor 25 を下回る」）
  - 思い出の `dmgOnYou` は `[合計, 当たった回数, 攻撃された回数]`。平均の分母は 3 つ目（同じ時から数える。0.42.0 の 2 つの欄の記録は平均に使わず、最大で数える）。`maxPlainToYou`（会心でない最大の一撃）
  - 予備動作の `hold` は、プレイヤー向けの射影（`EntityView.intent`）に出さない
- **シーズンのランだけ**
  - 帰り支度の間に**被害を受けたら取りやめ**（`fire_return { phase: 'cancel', reason: 'damaged' }`。毒も・見えない相手に撃たれた場合も）
  - 火からの帰還・撤退を支援賞に数えるのは、**その帰還・撤退で確定した点が 1 以上のとき**だけ（続く `expedition_ended` の `payout.players[].banked`）
  - 特別な場所から、節目の階（大守護者の間）を外す

S1c（2 つ目）で変えた項目（試運転 t1 を受けた直しのうち、すべてのランに同じに効くもの。`engineVersion` 0.42.0、思い出の `dmgOnYou`・予備動作の `hold`・品の `droppedBy` が増えたので `eventVersion` 27。SEASON.md §14.4・§14.6・§14.10・§15.10〜）:

- **fight の止まり方の見積もり**（§2.3）: `hp_floor` で止める・断る判定は、次の手番の**被害の見込み**＝いちばん重い 1 体（1 手の最悪が最大の者）は記録の最大の一撃×行動の回数、残りの敵は記録の平均の被害（攻撃で受けた被害の合計 ÷ 攻撃された回数。外れは 0。装甲の後）×行動の回数、の合計（shared の `threatEstimate`）。平均の記録が無い敵は最大で数える。被弾の記録の無い敵は、今までどおり数えない（別に止まる）。止まった文・断りの文に「見込み 12・最悪 40（HP 50・hp_floor 45。…）」（`riskText`。最悪は全員が最大の一撃）と、実際に使った `hp_floor`。観測の `incoming` に `expected_sum` と文の 2 つの数、`escape` に `expected_if_chased`（逃げの見込みも同じ考え）。`valid_actions` の「HP N 未満で止まる」に「（既定の hp_floor）」
- 思い出（`MonsterMemory`）に `dmgOnYou: [合計, 当たった回数]`（その種族の近接・射撃で受けた被害。毒・罠は入れない）
- **予備動作**: 速い敵の大振り・突進は、構えた相手（プレイヤー）が構えの後に 1 回動くまで出さない（`Intent.hold { id, turns }`。構えたまま待つ）。`fight` は、見えている構えが自分のマス（大振りのマス・突進の直線の 6 マス以内）を的にしている間は、2 手目から `intent` で止まる（始めたときから見えていた構えでも）。予備動作で止まった応答に、的のマス（大振りのマス・突進の直線の始めと終わり）と自分がそこにいるか、外れる一歩（`intentStopText`）
- **公開された下り階段の文**: 遠征の戦利品の行の「地下N階の下り階段に着けば +M」は、公開された階段が地図にあって道が分からないとき「（公開されている: ○○ が報告 (x,y)。途中の道はまだ分からない）」（「未発見」と書かない）
- **collect**: `kinds` は、未鑑定の品を外見の区分（`potion`・`scroll`・`amulet`・`ring`）で比べる。`kinds` を付けて `what` を省くと `items`。既定（`thrown`）の結果と断りに「自分が投げた物だけを拾う（ほかに拾える品 N 個: collect { what: 'items' }）」。ツールの説明に `kinds` に渡せる区分の名前
- **pickup**: `item` を省くと、足元にほかの品があれば、自分の置いた品（`item.droppedBy`）は拾い直さない（置いた品だけなら拾う）
- **遠回りの文**（§2.3）: `travel_to`・`collect` が動かない敵の隣を避けた道を選び、それが隣を通る近道より 10 歩を超えて長く、かつ 2 倍を超えるときは、結果の文に「動かない 毒カビ e_x の隣を通らない道を選んだ（隣を通る近道より N 歩長い）」
- **`explore` の `toward`**（§2.3）: その方角（下への風・気配と隣り合う方角）に行ける未探索の境界が無くなったら止まる（`toward_exhausted`。始める前なら手番を使わずに `nothing_to_do` で断り、`details.stop: 'toward_exhausted'`）。`mode: 'flee'` は今までどおり、ほかの方角の境界へ
- **覚える敵**（§2.3）: 気づいていない守護者（持ち場を離れない）も、眠っている敵と同じに、その呼び出しの間は見えなくなってもマスをふさいでいるものとし、2 マス以内を避ける
- `travel_to` の「20 手縮まない」の数え直しは、その呼び出しの間に一度も見たことの無い障害の印が増えたときだけ（見え隠れする眠っている敵で、何度も数え直していた）
- **引数の名前の断り**（§1.1）

S1c で変えた項目（試運転 t1 を受けた直しのうち、シーズンのランだけに効くもの。`engineVersion` 0.41.0、出来事 `fire_return` と `knowledge_updated.publicSpot`・`stairs_reported.spots` が増えたので `eventVersion` 26。SEASON.md §14・§15、DESIGN.md §40.2）。シーズンでないランは何も変わらない（`extract` の断りの文も今のまま）:

- 野営の火の作り直し（§9.10）: **火の上か隣から帰還・撤退できる**（`extract`。追ってくる敵が見えていなければ。帰り支度 `balance.season.fireReturnTurns`（5）手番。途中で追ってくる敵が見えたら取りやめ）。次の遠征はその火のそばから始まる。費用は深さ × `fireCostPerDepth`（**100**）。支援賞は「使った人数」（回復で 10% 以上、または火から帰った）。状態 `core:fire_return`（行動できない）と出来事 `fire_return { phase: 'start' | 'cancel' | 'done', depth, x, y, by, turns?, reason?, completed? }`（本人だけ）。観測の `expedition.extract_via { type: 'fire', by, turns }`・`extract_blocked_by` に `hunted_at_fire`・`budget_at_fire`
- 火について足したもの（§9.10）: 取り込みの自分の火に `users`（使った参加者の表示名）。`SeasonState.fireNews`（前の取り込みから新しく使った者。キャンプで見せるまで持ち越す）とキャンプの知らせ。迷宮で火を置けるマスにいるときの `season.support`（支援賞の行と自分の火の数）。キャンプの支援賞の行にも自分の火の数
- 貢献賞の対象を広げる（§9.4）: **特別な場所**（部屋の作りに組み込まれた祭壇・賭けの祭壇・碑文）も `report_stairs` で一緒に報告し、最初の報告者に貢献 1。公開された場所は `season_sync` の `season.spots`、その階に入ると `knowledge_updated { rememberedSet, publicSpot }` で地図に載る。観測の `visible.features[].public_by`、キャンプの `season.spots`
- 道しるべのマスは、階段のほかは普通の床として載せる（§9.4。その世界の浅い水・扉を載せない）
- 予算の終わりぎわの知らせ（`budget_low`）に、帰還の綱を持っていれば「綱なら、その場で帰れる」の 1 句

S1b で変えた項目（試運転 t0 を受けた直し。`engineVersion` 0.40.0、`knowledge_updated` に `publicPath` が増えたので `eventVersion` 25。SEASON.md §12.4・§13、DESIGN.md §40.1）:

- **シーズンのランだけ**
  - 道しるべ（§9.4）: 公開された下り階段の階に入ると、入口（上り階段。地下 1 階は最初の入口）から階段までのいちばん短い道のマスも地図に載る（`knowledge_updated { publicStairs, publicPath: true, newlySeen, mappedAdd }`。道を引けない世界では今までどおり階段のマスだけで `publicPath` は無い）
  - 観測の `alerts` に `budget_low`（§9.6。`data: { left, stairs: 'up' | 'down' | null, path_len: number | null }`）
- **すべてのラン**（シーズンでないランで変わるのはこれだけ。生成・候補・出来事の形は変わらない）
  - マクロ（§2.3）: その呼び出しの間に眠っているのを見た敵は、見えなくなってもそのマスをふさいでいるものとして道を引く（explore・travel_to・collect）。travel_to の「20 手縮まない」は、動かない敵・眠っている敵・発見済みの罠が新しく見えたら数え直す。`explore { toward: 'draft' }` は下への風が消えたら（公開された階段を自分の目で見たら）`stairs_seen` で止まる。`explore` に `max_steps`（その手数で `max_turns`）。`fight` の `approach: 'advance'` は、眠っている・気づいていない相手にも寄って殴る（付けなければ今までどおり `target_not_hunting` で断り、断りの文に `approach: 'advance'` を書く）。`with` の品が尽きたとき、隣に追ってくる敵がいる間は拾いに行かない（`out_of_ammo`）
  - 結果の文: `explore toward` が方角と違う向きに歩いた理由（方角に行ける境界が無かった手・遠回りで近い境界を先にした回数・道が回り込んでいる）。`fight` が拾いに行かなかったこと。鑑定の巻物を `target_slot` なしで使い、ほかにも鑑定できる品があったときは選び方を添える
  - 観測: 地図の目盛りの 10 の位は 10 の倍数の列にだけ書く（範囲に 10 の倍数が無いときだけ左端）。`travel_to stairs_*` の見込みに「いま隣の N 体が離れぎわに殴る 1 回ずつを含む」。遠征を始めた応答に「今いる階: 地下N階。目的の階: 地下M階（K 階下。下り階段から降りる）」
  - 内容: 泉と鑑定の巻物の説明（泉は 3d6+2 で全快ではない。鑑定の巻物は対象を `target_slot` で選ぶ）。カタログの品に `identifies`

S1a で変えた項目（S1 の検査の指摘の直し。規則が変わったので `engineVersion` 0.39.1、取り込みの火に `dup` が増えたので `eventVersion` 24。SEASON.md §10・§11）:

- 支援賞は、使った者がキャンプに着いたとき・ランが終わったときに、そのランの `fire_used` をまとめて数える（その場では数えない）。数えたかどうかは火ごとの `users` で決まるので、やり直しても同じ。起動し直して復旧したランも、キャンプにいるかランが終わっていれば数え直す。参加者ごとの支援の数は持たず、`fires.json` の `uses` から作る
- 取り込んだ火を地図に載せる `knowledge_updated { publicFire }` は、記憶の火（`rememberedSet`）だけ。そのマスの地形（`newlySeen`）も `mappedAdd` も載せない
- `place_fire` の「追ってくる敵が見えている」は休憩と同じ判定（隣にいない動かない敵は数えない。観測の行と同じ）
- 同じマスの取り合いで載らなかった火は `fires.json` に `dup: true` で残し、置いた者の取り込みにだけ `season.fires[].dup` で渡す（シーズンの 3 つ・同じ階の 1 つに数え、そのマスの火を自分で使っても、ほかの者の支援に数えない）。このランで置いた火（`placed`）は、いつも自分の火として数える
- プロフィールの記録の確定点は、野営の火の費用を引く前の点（`fire_placed.cost` を足し戻す）。費用はシーズンの生還賞にだけ効く
- サーバーの起動時に、開いているシーズンの版（engine・コンテンツ）がサーバーと違えば `[season] 警告:` を出す（新しいランを始められない）
- 試運転の道具の入口 `node packages/tools/bin/call.mjs <tool> …`（npm.cmd・cmd.exe を通さない。PowerShell でも bash でも同じ）

S1 で変えた項目（野営の火と支援賞。`engineVersion` 0.39.0、`eventVersion` 23。SEASON.md §8、DESIGN.md §40。中身は §9.10）。シーズンでないランで変わるのは `xp_gained` の項目だけ:

- 命令: `place_fire`（迷宮の中・1 手番。シーズンのランだけ）。MCP のツール `place_fire`、WS の `{ t: 'command', command: { type: 'place_fire' } }`
- イベント: `fire_placed`・`fire_used`。`entity_spawned.reason` に `fire_placed`（自分で置いた）・`season_fire`（取り込んだ）。`healed.via` に `fire`。`knowledge_updated.publicFire`（取り込んだ火を地図に載せた。置いた者の名前）
- **`xp_gained` に理由**（§8.9 の 2。すべてのラン）: `reason: 'kill' | 'depth' | 'objective'`、`kill` は `victimKind`・`victimAffixes`（倒した相手が見えていなかったら null）、`depth` は `depth`。S0b でプレイヤー向けの射影が出来事の順から決めていたもの（下の S0b の 1 行目）は、やめた。文は S0b のまま。理由の無い古い出来事は「経験値 +N」
- 地物: `core:camp_fire`（野営の火）。エンティティの `campfire: { by }`、`EntityView`・`RememberedView` の `campfire`
- 命令 `season_sync` の `season.fires`・`season.self`、賞の `support`。`SeasonState` の `fires`・`placed`・`fireUses`・`self`（どれも任意。古いランの写しには無い）
- 観測: `visible.features[].by`（火を置いた者）、`season.fires`（キャンプ: 自分の火と使われた回数）、`season.fire_used`（迷宮: この遠征で火を使った階）、`valid_actions` の `place_fire`・火の `interact`
- HTTP: 順位の表の `support`
- get_rules: season に火・費用・上限・支援賞

S0b で変えた項目（文と、プレイヤー向けの出来事の射影と、道具だけ。engine と出来事の形は変えていないので `engineVersion` は 0.38.0、`eventVersion` は 22 のまま。開いているシーズン s0 はそのまま使える。SEASON.md §6.2・§7）:

- （S1 でやめた。理由は engine の `xp_gained` が持つ）プレイヤー向けの射影（`filterEventsForPlayer`）: 自分の `xp_gained` に、増えた理由 `reason?: 'kill' | 'depth' | 'objective'` と、`victimKind?` / `victimAffixes?`（`kill`。倒した相手が見えていなければ null）・`depth?`（`depth`。着いた深さ）を足す。engine の `xp_gained` には無い。経験値が入るのは 3 か所だけ（倒した・新しい深さに初めて着いた・目的を達成した）なので、同じ命令（`cause`）の中で `xp_gained` の前にある、自分が知覚した出来事（自分が倒した `died`・自分の `entity_changed_floor`・`objective_completed`）の最も近いものから決める。間に別の `xp_gained` があればそこで止め、決まらなければ付けない（理由をこしらえない）。すべてのプレイヤーに同じ（観戦の俯瞰では文にしない）
- 文: 自分の `xp_gained` を文にする（今までは文にしていなかった）: 「経験値 +6（大ネズミを倒した）」「経験値 +8（初めて地下2階に着いた）」「経験値 +16（遠征の目的を達成した）」、理由が無ければ「経験値 +N」（英語 `+6 XP (killed cave rat)`・`(first time on depth 2)`・`(expedition objective complete)`）。**経験値の文は、件数に上限のある所の枠に数えない**（ほかの知らせを押し出さない。検査の指摘の直し、SEASON.md §7.9）: 手番が 1 つの行動の結果（outcome）は今までどおり「経験値でない最初の 3 件＋倒した文」で、その間の経験値の文は出た場所に添える。観測の `recent_events`（10 件）・行動の結果の `events`（20 件）・遠征レポートの最期の `last_events`（10 件）も、経験値でないものを数え、その間の経験値の文を添える（`lastWithoutXp`）。マクロの結果の「最後の 2 件」には経験値の文を入れない（直前の出来事に出る）。理由 `objective` は、射影の中ですぐ前の出来事が `objective_completed` のときだけ付ける
- 文: `fight` の結果の「合計 N ダメージを与えた」は今までどおり実際に減らした HP の合計で、とどめの一撃の超過分（`damaged.amount − dealt`）があれば「（実際に減らした HP。とどめの一撃の超過分 M は含まない）」を添える（英語 ` (HP actually removed; the finishing blow's M overkill is not counted)`）。1 行ごとのとどめの文（出目の値と残りの HP）は今のまま
- 文: alerts の `new_floor` を「新しい階に到着した」から「階を移った（地下N階）」に（前に来た階でも出るので、作り直された階と読まれないように）
- get_rules: 経験値の入り方とレベルを combat の「## 経験値とレベル」1 か所にまとめた（数は変えていない。expedition の「その他」はそこを指す）。overview に「階は、ランの間、作られたまま残る」（例外は倒していない節目の階の作り直し。シーズンでは地形と階段の位置が全員に同じ）。season にも同じことを短く。fight の合計とレポートの与ダメージに、とどめの超過分を含まないこと。シーズンの参加の briefing にも「階は、ランの間、作られたまま残る」
- 運用の道具: `season -- uninvite --id <id> (--name <表示名> | --profile <profile_id>)`（§9.1）
- 試運転の道具: `npm.cmd run call -- <tool> [key=value …]`・`--tools`（`packages/tools/src/mcp-call.ts`。トークンはファイルに保存して伏せる。`MUSE_PORT` か `MUSE_MCP_URL` が無ければ断る。呼んだ後はセッションの終わり（DELETE）を送る。SEASON.md §7.6・§7.9）
- MCP（§8）: 使われていない MCP セッションを掃除する（SEASON.md §7.9）

S0b で変えた項目のうち、MCP のセッションの掃除（`/mcp`）: 処理中の要求も開いたままの受信の流れ（GET の SSE）も無いまま、プレイヤーを束縛していないセッションは 30 分（`MUSE_MCP_IDLE_MS`）、束縛した（`new_run`・`join_run`・`resume_run` をした）セッションは 6 時間（`MUSE_MCP_BOUND_IDLE_MS`）だれも使わなければ、サーバーが閉じる（1 分ごとに見る）。閉じたセッションの ID で呼ぶと HTTP 404・`{ jsonrpc: '2.0', error: { code: -32000, message: 'Unknown MCP session' }, id: null }`（MCP の決まりどおり、クライアントは新しい `initialize` でつなぎ直す。束縛はセッションごとなので、つなぎ直したら `resume_run` か、`player_token` を渡して呼ぶ）。ターンフィード（`GET /api/player/feed`）は MCP のセッションではないので、掃除しない

S0a で変えた項目（サーバーと運用の道具だけ。ゲームの規則は変えていないので `engineVersion` は 0.38.0、`eventVersion` は 22 のまま。SEASON.md §4.1・§5）:

- シーズンのランは、運用者がそのシーズンに招いたプロフィールでしか始められない。`new_run { season }`（HTTP は `POST /api/runs { season }`）の `profile_token` は必須。トークンが無い・知らないトークン・招かれていないプロフィールは `season_unavailable`（理由つき）
- 運用の道具 `season -- invite`（招く。表示名はそのシーズンの中で重ならない。新しいプロフィールのトークンは 1 回だけ表示する）・`season -- invites`（招いた者の一覧。トークンは出さない）。招いた者は `seasons/<id>/invites.json`（運用の道具だけが書く）
- 順位の表の名前は、招いたときの表示名。`GET /api/seasons` の `invited`（招いた数）。`participants` は 1 回でもランを始めた数
- 動いているサーバーは、知らないプロフィールのトークンを渡されたら、プロフィールの置き場所を読み直す（運用の道具が作ったプロフィール）

S0（シーズン）で変えた項目（`engineVersion` 0.38.0、`eventVersion` 22。SEASON.md §2、DESIGN.md §39。中身は §9）。シーズンでないランは何も変わらない（生成・候補・観測・出来事のどれも）:

- MCP: `new_run` の `season`、ツール `report_stairs`、`list_runs` の `seasons`。WS の `{ type: 'report_stairs' }`
- 命令: システムの命令 `season_sync`（commands.jsonl）
- イベント: `season_synced`・`stairs_reported`、`expedition_ended.reason` と `player_state.reason` の `time_up`、`knowledge_updated.publicStairs`
- エラー: `season_unavailable`・`budget_exhausted`・`season_ended`
- 観測: `season`（予算・キャンプでは賞と順位・報告していない階段）、`navigation.known_stairs[].public_by`。マクロの止まり方 `time_up`
- HTTP: `GET /api/seasons`・`GET /api/seasons/:id`、`POST /api/runs` の `season`
- get_rules: `topic: 'season'`（`all` にも入る）

V4-1m の続き（§39.1。観測の文だけ。構造化した項目と数え方は変えていないので `engineVersion` は 0.37.0、`eventVersion` は 21 のまま）:

- 観測の文: 命中の記録の頭に「この種族の記録: 」（守護者は「この種族の守護者の記録: 」。英語は `this species' record: `・`record for this species' guardians: `）。後ろに続く「近接の通り」も同じ記録。人間の画面の敵の説明も同じ文。get_rules の説明と例の文も直した

V4-1m で変えた項目（サーバーだけ。ゲームの規則は変えていないので `engineVersion` は 0.37.0、`eventVersion` は 21 のまま。IMPROVEMENTS_V4 §37、DESIGN.md §38.13）:

- 復旧: 長いラン（出来事が十数万件）の起動時の復旧が「Maximum call stack size exceeded」で落ちていた不具合を直した（記録の再生の仕方は変えていない）
- エラー: `recovery_failed`（復旧に失敗したランのトークン・ランへの再開と参加。理由つき。HTTP は 503）
- HTTP: `GET /api/runs` の `recoveryFailed?: { reason, at }`

V4-1l で変えた項目（`engineVersion` 0.37.0。出来事の種類は増やしていないので `eventVersion` は 21 のまま。IMPROVEMENTS_V4 §34、DESIGN.md §38.12）:

- コンテンツ: 守護者の弱点に `maxArmor`（その弱点を付けてよい装甲の目安の上限。無ければ上限なし）。「投擲に弱い」は `maxArmor: 4`（装甲の目安が 5 以上の相手では、装甲を引いた後の被害が下限の 1 に張り付き、1.5 倍しても 2 にしかならない。5 は投げナイフ（1d4+1）の最大の値）
- 規則: 守護者の弱点は候補を作るとき、節目の大守護者の弱点は階を作るときに引く。そのとき、相手の装甲の目安（候補の `guardian.armor` と同じ式: 種族 + 深層強化の半分 + 接辞。守護者の接辞も入れ、型の効果は除く）が弱点の `maxArmor` を超えるなら、その弱点は付けない（V3-3c の、型が打ち消す弱点を引かないのと同じ扱い）。引いた弱点が付けられないときだけ、付けられる弱点から引き直す（装甲の低い相手と、引いた弱点が付けられる相手は、今までと同じ弱点になる）
- 規則: 記録庫が返す大守護者の弱点の記憶（V3-3a §35.7）は、その階の大守護者の弱点（階が作られていればその個体、まだならその階を作ったときの弱点）
- 続いているランでは（V4-0b §1.2）: 今いる守護者・大守護者の弱点、出してある候補（キャンプの候補）の弱点は変えない。変わりうるのは、これから作る候補と、まだ作っていない節目の階の大守護者だけ
- 公開カタログ: `guardianWeaknesses[].maxArmor?`。get_rules topic=classes（と all）の弱点の一覧に「装甲の目安が N を超える相手には付かない」を添える

V4-1k で変えた項目（`engineVersion` 0.36.0。出来事の種類は増やしていないので `eventVersion` は 21 のまま。IMPROVEMENTS_V4 §32、DESIGN.md §38.11）:

- 観測: `party[].pos` を、**同じ階にいる仲間については、見えていなくても出す**（V4-1f §22.4 の「見えているときだけ」を改めた。相手が視界から出ると、ついていく側が最後に見た古い位置へ戻ってしまうため）。別の階の仲間は今までどおり階だけ。`entity`（エンティティ ID）は今までどおり見えているときだけ。仲間のいる場所の地形・周りの敵・品は出さない（まだ見ていない所にいれば、地図の黒い所に仲間の印だけが出る）。PlayerView の `party[].pos` も同じ（同じ階のときだけ）。文の 1 行は、見えていれば「見えている (x,y)」、見えていなければ「(x,y)」
- 人間の画面: 同じ階で見えていない仲間の位置に、仲間の印を出す（覚えている物と同じく暗く）

V4-1j で変えた項目（`engineVersion` 0.35.0。出来事の種類は増やしていないので `eventVersion` は 21 のまま。IMPROVEMENTS_V4 §30、DESIGN.md §38.10）:

- 観測: `party[].last_act`（その仲間が自分で最後に行動した時点。その仲間の手番数で数え、World の状態（`PlayerRecord.lastAct`）から取る。見えていない仲間・別の階・キャンプの仲間にも出す。分かるのは「いつ動いたか」だけ）。文と人間の画面には出さない
- 出来事: `actor_scheduled.acted?: true`（プレイヤーが自分で出した命令で行動した。時間切れの待機（`source: timeout`）と、サーバーが代わりに出した命令（`system`）には付かない）。`applyEvent` がこれで `PlayerRecord.lastAct` を書く。後方互換の項目（付いていない古い記録では、`last_act` は 0 のまま）。協力プレイで、離席した人間が同じ階にいると、時間切れで手番が進み続けるので、手番数そのものでは「動いていない」が分からなかった
- マクロ: `explore toward: 'sense'` の `sense_found`（断る・止まる）は、この遠征の目的の相手・品（観測の `objective: true` の遺物・守護者・賞金首。守護者は名前が目的と同じものも）を見ている・覚えているときだけ。目的でない遺物を覚えているだけで断っていたのを直した（V3-7a 後の評価で決めた「目的の遺物・守護者だけ」のとおりにした）

V4-1g で変えた項目（`engineVersion` 0.34.0。出来事の種類は増やしていないので `eventVersion` は 21 のまま。IMPROVEMENTS_V4 §24、DESIGN.md §38.7）:

- 参加（G1）: 協力プレイのランに入った者は、遠征が進んでいても、キャンプに置く（`join_run`・`POST /api/runs/:id/join`）。進んでいる遠征には入らず、次の遠征から一緒に出る（次の遠征の始まりは、その者の再開地点＝地下 1 階の入口）。キャンプで待つ間の文に「遠征 N が進んでいる（仲間がまだ迷宮にいる）。全員が戻ったら、次の遠征を選べる」
- 参加者の種類（G2）: `Controller.kind` に `unknown`。HTTP の作成・参加で `controller` を省くと `unknown`（今までは `human`）。MCP の `new_run`・`join_run` は `agent`。`party[].controller` は 3 つ
- 仲間の HP（G3）: `party[].hp` を、迷宮にいる仲間については、見えていなくても・別の階でも出す（位置は今までどおり見えているときだけ）。人間の画面の「仲間」の欄にも
- 確定の表示（G4）: `expedition.result` に `banked`（あなたの分）・`party_banked`（全員の合計。協力プレイ）・`shares`（だれの分か）。文は「確定 +128（あなたの分 +64）」と、だれの分か。綱の見込みの文（`haul.text`・`valid_actions` の綱の行）に、協力プレイでは確定が遠征の終わり（全員が戻ったとき）で、共有の分はそのときの値で数えること
- 能動技の引数（G5）: MCP の `use_ability` に `ability`（`id` と同じ）。`valid_actions` の行を、書いてある形のまま呼べる形にした（`use_ability <ability> target:<id>`・`use_ability slip target:<n|ne>`・`throw_item <slot> target:<id>`）。1 行の形は上の `valid_actions` の注。`explore` の行の「拾えるアイテム N 個」は、辿り着ける所の品だけを数える（壁の向こうに覚えている品で行を出し、呼ぶと `nothing_to_do` になっていた。全部の行を呼ぶテストで見つけた）
- 地物の説明（G6）: `visible.features[].desc`（何であるか・どう使うかの 1 行。すべての地物にあり、内容のデータに無ければ起動時の検査で落とす）。初めて見たときの 1 行（`turn.changes` の `first_seen`）が、変化の多い応答で落ちて二度と出なかったのを直した

V4-1f で足した項目（`engineVersion` 0.33.0。出来事の種類は増やしていないので `eventVersion` は 21 のまま。IMPROVEMENTS_V4 §22、DESIGN.md §38.6）:

- 観測: `party[]`（自分以外の参加者。名前・人間か AI か・参加の順・迷宮にいるか・キャンプにいるか・倒れているか・抜けたか、迷宮にいれば階。位置・HP の段階・エンティティ ID は同じ階で見えているときだけ）。仲間のいる階の地形・敵は渡さない。ソロのランでは空の配列。文に 1 行（「仲間: ○○（地下 1 階）、△△（キャンプ）」）。人間の画面にも同じ表示
- エラー: `start_expedition` が、仲間がまだ迷宮にいるために断られるとき、`details.still_inside: { id, name, floor }[]` と、hint に名前と階（「○○がまだ地下 1 階にいる。遠征は全員が戻るまで続く」）

V4-1d で足した項目（`engineVersion` 0.32.0。出来事の種類は増やしていないので `eventVersion` は 21 のまま。IMPROVEMENTS_V4 §18、DESIGN.md §38.4）:

- エラー: `details.blocked_by_traps: { id, kind, pos }[]`（マクロが発見済みの罠の手前で 1 歩も進めないときの `blocked`。そのプレイヤーが見つけている罠だけで、経路の上で近い順。`kind` は種類 ID（`core:trap_dart`））。hint の文に罠の名前と位置（「毒矢の罠 (13,13) が道をふさいでいる。踏むなら move { dir: 'e' }。ほかの道を探すなら explore。」）。マクロは今までどおり罠を踏まない

V4-1c で足した項目（`engineVersion` 0.31.0。出来事の種類は増やしていないので `eventVersion` は 21 のまま。IMPROVEMENTS_V4 §16、DESIGN.md §38.3）:

- 観測: `self.recovery[]`（回復の手段。能動技は効果が HP の回復のもの、品は鑑定済みで使うと HP が回復するもの。未鑑定の品は入れない。文の表示と人間の画面は変えない）

V4-1a で足した項目（`engineVersion` 0.30.0。出来事の種類は増やしていないので `eventVersion` は 21 のまま。IMPROVEMENTS_V4 §12、DESIGN.md §38.1）:

- 観測: `navigation.collectable: { count, ids }`（引数なしの collect が拾いに行く品。見えている品と覚えている品の両方）。`valid_actions` の `collect what:items` の件数をこれに合わせた（出ているのに collect が断る、を無くす。範囲の外の品は今までどおり品の一覧にあり、件数に入らない）
- 観測: `visible.monsters[].objective`・`visible.items[].objective`（この遠征の目的の守護者・大守護者・賞金首・遺物。前の遠征の遺物には付かない）。文は名前の後ろに「［目的］」、人間の画面の名札にも同じ印。`EntityView.objective`・`RememberedView.objective`
- 観測: `navigation.known_stairs[].sealed`（大守護者を倒していない節目の下り階段。判定は `stairsSealed`）
- エラー: `details.blocked_by`（`hostile_adjacent`・`blocked` で、じゃまをしている見えている敵の ID。hint に名前）
- 命令: `fight { approach: 'wait' | 'advance' }`（既定 `wait`）。`shot_while_waiting`・`target_shooting` で止まったときの文と get_rules に「approach: 'advance' で寄って戦える」。人間の画面の「戦う」にも同じ切り替え

V4-0e で変えた項目（`engineVersion` 0.29.0、`eventVersion` 21。DESIGN.md §36.5）:

- イベント: `floor_traits_noted { traits: Record<FloorKey, string[]> }`（古い版で作った階に、作ったときに効いた条件を記録した。遠征の開始時と候補を作るとき、性質を持たない階だけ。俯瞰専用）
- `Floor.genTraits`（その階を作ったときに効いた条件のうち、階を作るときに効くもの。`floor_generated.floorData` に入る。条件が無ければ空）。`ExpeditionOffer.floorTraits: { trait, depths }[]`（目的の階と通り道の階のうち、作られていて性質のある階）
- 規則: 群れる・乏しい（階を作るときだけに効く条件）は、目的の階がまだ作られていない候補にだけ付く。遠征の開始時に、作られているすべての階の敵が落ち着く（今までは再開する階だけ）。守護者と再挑戦の賞金首は先に落ち着かせるので、再開する階でも傷跡が残る
- 観測: `self.floor.traits`・`trait_text`（状態の行の「この階:」にも）、ターンの要約の `floor_changed` に「この階は群れている（敵と宝が多い）」、`camp.offers[].floor_traits: { trait, name, depths }[]`、候補の文に「通り道の地下 13〜16 階は群れている」。候補の `trait_danger` は、群れている階があれば（候補に群れる階層が無いとき）+1。敵の行の「与ダメ累計:」は「見た被害:」に（`damage_seen` の名前は同じ）
- get_rules: 条件の 2 種類と条件の文（「この遠征で初めて入る階は」）、階の性質と候補の通り道の行、キャンプですべての階が落ち着くこと、見た被害の説明

V4-0d で変えた項目（`engineVersion` 0.28.0。出来事の種類は増やしていないので `eventVersion` は 20 のまま。DESIGN.md §36.4）:

- `ExpeditionOffer.guardian.hpRange` を格 1〜3 の守護者にも持たせる（体力ダイスの最小と最大に、目安と同じ上乗せと下限。大守護者は今までどおり `hp` が無く `hpRange` だけ）。`ExpeditionOffer.bounty.hpRange`（古い候補には無い）
- 観測: `camp.offers[].bounty.hp_range`、`camp.offers[].guardian.hp`・`hp_range`。候補の文は「体力はおよそ 20（9〜32）」（幅が 1 点なら括弧なし）
- 生成: 賞金首（目的・異変）と巡回の強敵も、その階の深層強化（tier。地下 19 階から先）を受ける
- get_rules: 守護者の体力の目安の文に、括弧の中の幅の説明

V4-0c で変えた項目（`engineVersion` 0.27.0。出来事の種類は増やしていないので `eventVersion` は 20 のまま。DESIGN.md §36.3）:

- 伏せ方: 背の高い草の中の者（隣でない）が主体の出来事は、その者を見えていないものとして伏せる（`attack.attacker`・`from`、`damaged.source`、`entity_moved`、`died` など。被害を受けたのが自分なら `fromDir` だけ残る）。見えていた者が草に入る `entity_moved` は `to` も伝わる。草から草への移動は伝わらない
- 規則: 草の中の見えない相手は、`throw`・`attack` の ID 指定の標的にできない（`no_target`）。種族の思い出は、相手が見えているときだけ更新される
- 観測: alerts `unseen_shooter`（その応答の間に見えない相手に撃たれた。方角つき）。マクロの結果の文に「東から撃たれた。相手は見えていない。」。ターンの要約の `hostile_gone` に「背の高い草の中」と、知覚した移動からの最後に見た位置・向き。fight の結果の「最後に見た場所」はマクロが覚えた場所
- get_rules: 苔むした遺跡の文に「攻撃しても隠れたまま」「草の中から撃たれたときは方角だけ」

V4-0b で足した項目（`engineVersion` 0.26.0。出来事の種類は増やしていないので `eventVersion` は 20 のまま。DESIGN.md §36.2）:

- マクロ: 止まり方 `chaser_near`（careful の explore が止まらずに続けた遅い追跡者が 2 マスに来た）。explore は、遅く 3 マス以上離れた射撃しない追跡中の敵では止まらず、結果に「遅い敵 N 体に追われたまま探索した」。fight の見失いは、ほかに届く追跡中の敵が見えている・被害を受けた手番には待たない。見失った・逃げられたときは結果に最後に見た場所。explore の `toward: 'draft'` は遠回りの風の方角より近くの境界を先に見る
- 観測: `hp_left_est.untouched`（まだ傷を負っていない。文は「体力の記録 …」）。`camp.version_note`（古い版で始まったラン。最初の 1 度だけ）。ターンの要約の「倒した」の行に会心のとどめの値。深追いの文。collect の結果に「遺物は対象外」
- エラーの文: fight の `no_target`（標的が見えているが逃げている）、explore の `hostile_adjacent` の hint
- `terrain_table_extended.concealAdded` は、今までの表の番号（古い版のランに無かった背の高い草など）も入る。遠征の開始時にも出る

V4-0a で足した項目（`engineVersion` 0.25.0、`eventVersion` 20。DESIGN.md §36.1）:

- イベント: `floor_reset { floorKey, depth, reason: 'warden_missing', guardianName? }`（倒していない節目の階に大守護者がいなかったので、遠征の開始時に階を捨てた。全員に。階のエンティティは del で消え、その階の地図と記憶も消える。次に着いたとき大守護者の間として作られる）・`terrain_table_extended { added, concealAdded }`（古い版で始まったランの地形の表に、今の地形を後ろに足した。俯瞰専用）・`player_state.reason: 'floor_reset'`（再開する地点を、作り直した階の上り階段へ移した）
- 規則: 下り階段の封印は「節目の深さで、倒した記録が無い」（前は「その階に生きている大守護者がいる」。表示と同じ判定にした）。get_rules の節目の文に作り直しの 1 文
- ターンの要約: changes の `floor_reset`（作り直した階の文。先頭）。開始の応答の outcome にも同じ文
- 遠征レポート: 大守護者との戦い（`warden_fight`）は大守護者の個体だけ（節目の深さの守護者は `guardian_fight`）

V3-8a で足した項目（表示と使い勝手だけ。後方互換。候補の中身が増えたので `engineVersion` は 0.24.0。出来事の種類は増やしていないので `eventVersion` は 19 のまま。DESIGN.md §35.8）:

- 候補: `ExpeditionOffer.guardian.armor`（守護者の装甲の目安）。観測の `camp.offers[].guardian.armor`。候補の文に「装甲はおよそ N」と「いまの持ち物で 1 回に通る目安」（守護者の候補。大守護者を除く）
- 観測: `visible.features[].id`（地物の ID。文の行にも出す）。get_rules の「遠征の候補」に枠の読み方
- マクロ: 止まり方 `damage_taken`（steady の explore・travel_to・collect で、その呼び出しの被害の合計が最大 HP の 4 分の 1 を超えた）。collect（what: items）と品を目的地にした travel_to は、着いた手番に止まるなら拾ってから止まる（hp_floor・hp_risk・予備動作を除く）。travel_to の `to` に地物の ID（隣に着けば到着）
- 加護の説明: 持っている加護が変わったときの 1 回だけ（`self.boons_brief` が true なら名前だけ）

V3-8 で足した項目と外した項目（最後の見直し。規則・候補・生成が変わったので `engineVersion` は 0.23.0、出来事が増えたので `eventVersion` は 18。DESIGN.md §35）:

- 外した: MCP の `declare_goal`、観測の `expedition.goal`・`camp.goal`、遠征レポートの `goal`、WS の `goal`（サーバーからの通知と `view.goal`）、`shared/goals`（`GoalDecl`・`GoalRecord`・`GoalCandidate`・`GoalInfo`）、ログの `goals.jsonl`（古いランに残っていても読まない）
- 目的の種類: `slay_bounty`（賞金首を討つ）・`open_vault`（宝物庫を開ける）。`ObjectiveProgress.vaultOpened`（PlayerView の `expedition.progress.vaultOpened`）。賞金首の討伐は `guardianSlain` で表す
- 候補（`ExpeditionOffer`）: `bounty { kind, name, affixes, kindName, affixNames, hp, maxHit, armor }`・`vault`（true）・`scar`（傷跡で減る体力）・`rechallenge.bounty`（賞金首の再挑戦）。公開カタログの `rules.expedition.typePct.slay_bounty`・`open_vault`
- World State: `Expedition.bounty { kind, name, affixes }`・`Expedition.targets.bounty`（目的の賞金首の ID）・`targets.vaultLocks`（生成のときの施錠の格子扉の数）・`GuardianInfo.heavy`（重い一撃）・`Entity.scar`・`Knowledge.paceSeen { [id]: 自分の手番数 }`
- イベント: `floor_event_cleared { floorKey }`（強敵が去って階の異変が消えた。全員に）・`pace_seen { player, ids, turn }`（前の手番の間に 2 回以上動いたのを見た敵。本人だけ）・`guardian_departed.elite`（去ったのが名前付きの強敵）
- PlayerView: `EntityView.paceAgo`（2 回動いたのを見てから過ぎた自分の手番）
- コマンド: `collect.within`（1〜200。既定 15）・`collect.kinds`（種類 ID か区分、8 つまで）・`collect.all`・`equip.confirm`（呪いと分かっている品）。止まり方 `collect_far`・`target_shooting`。`equip` の拒否 `confirm_required`
- MCP: `collect { within?, kinds?, all? }`・`equip { confirm? }`・`use_item` の `slot` に種類 ID（正体の分かっている所持品のスロットに読み替える。無ければ `no_such_item`）
- 観測: 敵の `traits` に `heavy_blow`、look に強敵の接辞の中身、キャンプの `camp.records.line` の先頭に「前のランまで: …」（2 回目以降のランの最初のキャンプ）、候補の注記に傷跡、extract・階段・帰還の綱の説明に床に残した投擲物の数、投擲の fight の結果に「投げ物: 手元 N・床に M（うち敵の足元 K）」
- 遠征レポート: `combat.bounty_fights { id, dealt, taken }[]`（目的の賞金首との戦い）
- コンテンツ: 接辞の `monsterMods`（公開カタログに出す）・`balance.expedition.typePct.slay_bounty`（110）・`open_vault`（105）
- 確認の評価の直し（`engineVersion` 0.23.1、`eventVersion` 19。DESIGN.md §35.7）: `room_found.at { x, y }`（見つけたときに見えた部屋の一角）・`item_inspected.affixes`（確かめた後の接辞）。どちらも任意の項目

V3-5e で足した項目（バイオームの仕掛け。後方互換。生成と規則が変わったので `engineVersion` は 0.21.0。出来事の種類は増やしていないので `eventVersion` は 16 のまま。DESIGN.md §33）:

- コンテンツ: 地形の `moveCostPct`（入る手番の倍率。浅い水は 150）とタグ `conceal`（背の高い草）・`pushable`（本棚）・`grate`。地形 `core:grate_closed`（閉じた格子扉: 通れず見通せる。投げた物と射撃は通る）。地物 `core:lever`（`lever`）・`core:brittle_ceiling`（`collapse { trigger 3, loudness 4, radius 1, dmg 2d6 }`）・`core:spore_pod`（`burst { radius 1, cloud, turns 3 }`）・`core:spore_cloud`（入ると毒）。アイテム `core:loose_page`（区分 `page`。効果 `map` の `radius` 10）。バイオームの `rules { levers, ceilings, pods }`・`items [{ item, min, max }]`。バイオーム `core:sunken_archive`（沈んだ書庫。地下 6 階から）。公開カタログの `terrain[id].moveCostPct`
- World State: 地物の `feature.expiresAt`（その階の時刻を過ぎたら消える）・`Entity.links`（レバーにつながった格子扉のマス）・`meta.concealTerrain`
- イベント: `tile_changed.reason` に `lever`（格子扉の開け閉め）・`collapse`（崩れた天井の瓦礫）・`push`（押した本棚）。時間で消えた毒の雲は `entity_removed.reason: 'expired'`
- PlayerView: 背の高い草の中の者（敵・プレイヤー）は、隣からしか見えない
- 観測: valid_actions の interact にレバーと胞子嚢。get_rules に「バイオームの仕掛け」の項目
- 規則: レバーを足元か隣で interact すると、つないだ格子扉を閉じる・開ける（閉じるマスに者か物があれば開いたまま。音 4）。浅い水は入る手番 150、水の上の音は大きさ 2 倍。脆い天井は 3 マス以内で大きさ 4 以上の音（投げた物が落ちる 4・戦い 5・敵が扉を開ける 4。自分で扉を開けるのは 3 なので崩れない）で崩れ、周り 1 マスに 2d6、真下は瓦礫。背の高い草の中の者は隣からしか見えない（敵からも）。胞子嚢は突くか投げた物が当たると弾け、周り 1 マスの者を毒にし、毒の雲を 3 手番残す。本棚は move で押すと、向こうが空いた床なら動く（手番 150・音 4）。残り頁を読むと周り 10 マスの地形が分かる

V3-5d で足した項目（階の異変・描写と手がかり・名前付きの強敵。後方互換。生成と規則が変わったので `engineVersion` は 0.20.0、出来事が増えたので `eventVersion` は 16。DESIGN.md §32）:

- コンテンツ: `floorEvents.json`（`FloorEventSchema { id, name, arrival, handler, depth, weight }`）。異変は賞金首（`bounty`）・深い眠り（`deep_sleep`）・荒らされた跡（`ransacked`）・溢れた宝（`treasure_glut`）・番人の巡回（`patrol`）。階の種類の `rules.events`（通常の階と大空洞）。`balance.floorEvent.chancePct`（25）・`balance.elite { chancePct 3, minDepth 3, affixes 2, bountyBase 150, bountyPerDepth 30 }`・`balance.clueTurns`（30）。種族とバイオームの `desc`、薬と巻物の `clue`、職業の `clueOnPickup`（斥候）。行動様式 `patrol`。公開カタログの `monsters[id].desc`・`biomes[id].desc`・`items[id].clue`・`rules.floorEventPct / elite / clueTurns`
- World State: `Floor.event { id, handler, arrival }`（プレイヤーには arrival だけ）・`Entity.named`・`EntityRole` に `elite`・`AiState.route / routeIdx`・`Knowledge.clues / clueSince`
- イベント: `clue_noted { player, appearanceId, turns }`・`clue_learned { player, appearanceId, clue }`（本人だけ）。`monster_woke.reason` に `floor`（深い眠りで、1 体が起きて全員が起きた）
- PlayerView: `floorEvent`（到着の文）・`clues`（見た目 → 手がかり）・`EntityView.named`
- 観測: `self.floor.event_text`（状態の行の「この階:」にも）。`visible.monsters[].named` と、強敵の行「強敵「名前」・賞金 N・宝を必ず落とす」。所持品の `clue`（所持品の行に `{手がかり:…}`、inventory に「未鑑定。手がかり: …」）。changes の `first_seen`（このランで初めて見た種族・地物・バイオーム・鑑定済みのアイテムの描写。1 回の応答で 3 件まで）
- 規則: 異変は生成のとき（`events` ストリーム）に通常の階と大空洞の 25% に付く。深い眠り: 全員が眠っていて、1 体が起きると全員が起きる。荒らされた跡: 敵とアイテムが半分、先行者の野営跡がある。溢れた宝: 宝が倍、徘徊の湧きの間隔が半分。賞金首: 名前付きの強敵が 6 つの点を回る。番人の巡回: 名前付きの強敵（格 1 の守護者と同じ表から）が部屋の中心を 4 つ回り、見つけると追う。名前付きの強敵は、通常の敵（動かない種族・害獣を除く）の 3% が地下 3 階から（`elites` ストリーム）。接辞 2 つで、倒すと宝を必ず落とす

V3-5c で足した項目（特殊部屋。後方互換。生成と規則が変わったので `engineVersion` は 0.19.0、出来事が増えたので `eventVersion` は 15。DESIGN.md §31）:

- コンテンツ: 地形 `core:grate_locked`（通れないが見通せる）・`core:grate_open`・`core:bookshelf`（通れず見通せない）。アイテム `core:vault_key`（区分 `key`）。地物 `core:inscription`（碑文）・`core:old_note`（書き置き）・`core:gamble_altar`（賭けの祭壇。`gamble` に重みと効果の表）。地物の `desc`。部屋（prefab）の `name` とタグ `room`（見つけると発見の点）・`vault_locked`。戦利品の表 `core:scroll_loot`。物語の文の種類 `inscription`・`note`。効果 `inscription`（`clue` 1 で手がかり）・`affix_item`・`curse_item`・`summon`（`count`）・`damage` の `pct`（今の HP の %）
- 部屋: 施錠された宝物庫（`core:locked_vault`）・碑文の間（`core:inscription_hall`）・賭けの祭壇（`core:gamble_shrine`）・番兵の詰所（`core:guard_post`）・先行者の野営跡（`core:camp_remains`。地下 9 階まで）・崩れた書庫（`core:fallen_library`）。標準の階の部屋の数は 0〜3（前は 0〜2）
- イベント: `room_found { player, floorKey, region, room, name }`（参加者全員に）・`inscription_read { player, feature, note, lore, clue, clueText? }`（本人だけ）・`gamble_rolled { player, feature, outcome, pct }`・`item_altered { actor, item, kind, affix, cursed }`。`tile_changed.reason` に `unlock`
- World State: `Entity.carries`（持っている品。倒すと落とす）・`Region.found`。生成の `SpawnSpec` に `carries`・地物の `lair`
- 観測: `visible.monsters[].carries`・`carries_name`（「宝物庫の鍵を持っている」）。valid_actions に `interact <dir>`（格子扉を鍵で開ける／不可: 鍵が要る）。look の地物に説明と、賭けの祭壇の表（「表: 最大 HP +3 20%・…」）。公開カタログの `features[id].desc`・`features[id].gamble { name, pct }[]`
- マクロ: travel_to は、目的地までの道のりが 20 手のあいだ一度も縮まなければ `no_progress` で止まる（2 マスの往復でない行き来も止める）
- 規則: 鍵のかかった格子扉は、宝物庫の鍵を持って隣で interact すると開き、鍵は無くなる（鍵が無ければ手番を使わずに拒否）。宝物庫の鍵は、その階の宝物庫の外の通常の敵 1 体が持つ（敵がいなければ床）。碑文の手がかりは、この階の守護者の弱点（知らないもの）→ 鍵のかかった宝物庫の場所（地図に記す）→ 未鑑定の品 1 種の正体の順。特殊部屋を初めて見つけると発見 +100、碑文を読むと +50（書き置きは点なし）

V3-5b で足した項目（深層の敵。後方互換。種族と規則が増えたので `engineVersion` は 0.18.0、出来事が増えたので `eventVersion` は 14。DESIGN.md §30）:

- 種族: 骨の射手（`core:bone_archer`。2 体組・射程 7 の 1d8・その場で撃つ）・血吸い蝙蝠（`core:blood_bat`。3〜4 体の群れ・速さ 140・血を吸う）・大鬼（`core:ogre`。大柄・大振り）。オークの荒くれの深さの上限は 14
- コンテンツ: 行動様式 `ranged_stand`（距離を取らない射手）。種族のタグ `drain`（与えたダメージの分だけ回復）・`heavy_swing`（大振り。`ai.swingEvery`・`ai.swingMult`）。`balance.monsterTableDepth`（18。種族の表を定義する深さ。これより深い階だけ深層強化で硬くする）
- イベント: `monster_acted { id, kind, act: 'swing_hit' | 'swing_missed' }`。回復の `healed.via` に `drain`
- World State: `AiState.intent.kind` に `swinging`（`pos` が打つマス）・`AiState.swingAt`（最後に大振りした手番）
- 観測: `visible.monsters[].traits` に `drain`・`heavy_swing`（見れば分かる特徴）。`intent.code` に `swinging`（`pos`・`on_line` はあなたがそのマスにいる）。valid_actions の move に「大振りの的から外れる」。候補の守護者の見込みの特徴にも `drain`・`heavy_swing`
- 規則: 格 1 の守護者の候補から、その場で撃つ型も除く（距離を取る射手と同じ）

V3-3c で足した項目（見直し 7。後方互換。規則と候補の作り方が変わったので `engineVersion` は 0.17.0、出来事が増えたので `eventVersion` は 13。DESIGN.md §29）:

- イベント: `guardian_departed { id, guardianName, depth, player, forget }`（目的でなくなった守護者が階を去った。その守護者に会ったことのある参加者に。forget は記憶から消す棲み処の地物）
- World State: `Entity.lairOf`（棲み処の地物の持ち主の守護者）・`Expedition.rechallengeOf`（再挑戦の守護者。プレイヤーには渡さない）。生成の `SpawnSpec` に `minSpeed`（大守護者）・地物の `lair`
- 候補: `ExpeditionOffer.rechallenge { no, guardian }`（再挑戦。目標の階に残っている守護者をもう一度目的にする。繰り返しの減点なし）。`guardian.hp`（格 1〜3 の体力の目安）・`guardian.hpRange { min, max }`（大守護者の体力の幅）。候補の出来事（`expedition_offered`）から `guardianWeakness` を除く（前は残っていた）
- 観測: 候補の文に「体力はおよそ N」「体力 50〜90」「再挑戦: …」と、キャンプでは本人の遠征レポートから「前回（遠征 N）は与 X・被 Y」。`camp.offers[].rechallenge`。記録庫の記憶の「通る目安」に「（およそ N 回の命中）」。`visible.features[].lair`（護りの火の持ち主）・`expedition.ward_fires[] { guardian, dir, range, text }`（同じ守護者の火を 1 基見ていれば、まだ見ていない灯っている火の方角と遠さ）。`self.boons_brief`（加護の行は遠征ごとに 2 回目から名前だけ）。投擲の欄の威力に強肩の上乗せ
- 目標: `GoalInfo.lines` は 1 行（未宣言なら「目標: 未宣言（declare_goal で候補が出る…）」）、`GoalInfo.full` に候補と記録。MCP の `declare_goal` は引数なしで候補と記録を返す
- コマンド: `fight.alsoWith`（MCP では `with` に配列。前の品が尽きて拾い直せる物も無ければ次の品）・`fight.collectAfter`（MCP の `collect_after`。決着の後、追跡中の敵が見えていなければ自分の投擲物を拾う。拾い終えたら決着の理由で止まる）。座標を狙った `throw` も、射程外か経路が通らなければ拒否する（`out_of_range`・`no_line_of_sight`。手番を使わない）
- 遠征レポート: `combat.guardian_fights[] { id, dealt, taken, outcome }`・`economy.potions_detail`（飲んだ薬の内訳）
- コンテンツ: 守護者の型の `excludesWeaknesses`。「投擲に弱い」は `params.pct`（150。端数は切り上げ）。`balance.guardian.warden.minSpeed`。特技 `core:perk_armor_drill`（鎧さばき。不屈・ランク 2・装甲 +1・戦士に Lv4 までに）・`core:perk_strong_arm`（強肩。射手・ランク 3・フック `thrown_dmg`）・`core:perk_heavy_blow`（重い一撃。前衛・ランク 3・フック `melee_crit_dmg`）。公開カタログ: `perks[id].thrownDmg`・`rules.milestone.hpRule`・`rules.milestone.minSpeed`・`rules.guardianRanks[].minHpBase / minHpPerDepth`
- 規則: 遠征を始めるとき、その遠征の目的ではない未討伐の守護者（大守護者を除く）は、呼んだ手下・棲み処の地物と一緒に階を去る。護られし者の装甲は自分の棲み処の火だけで決まる。大守護者の速さは 100 を下回らない。特技の候補の 1 つは、特技を持っている職業の系統か共通の系統のランクが残っている物

V3-7a の後の AI 評価の修正で足した項目（後方互換。同じシードの候補が変わるので `engineVersion` は 0.16.1、`eventVersion` は 12 のまま。DESIGN.md §28.1）:

- World State: `ExpeditionOffer.guardianAffixes`・`Expedition.guardianAffixes`（候補の時点で引いた守護者の接辞。プレイヤーには渡さない）。目標階に置く守護者はこの接辞を持つ。候補の `guardian.traits`（速い・回避が高い・`poison`）と `guardian.maxHit` は接辞込み
- 候補: 同じキャンプの候補に、同じ遺物を 2 枠出さない
- マクロ: 停止理由 `hit_while_waiting`（fight の待つ手番に、標的ではない隣の敵の近接で被弾した。`until: 'clear'` なら止まらずその敵へ標的を替える）。能力値の修正だけの状態異常（錆）では止まらない。`explore toward: 'sense'` が止まるのは、この遠征の目的の遺物・守護者（節目なら大守護者、守護者なら名前が目的と同じもの）が見えた・覚えているときだけ。`explore toward: 'draft'` は、着いた境界の近くの境界を続けて追うとき、風の方角にある境界だけを追う
- 観測: `visible.monsters[].speed_ratio`（速い・遅いときの、自分の速さに対する倍率。文は「遅い×0.8」）。`navigation.known_stairs[].occupied_by`（階段の上に見えている敵の ID）。最寄りの階段に敵が乗っていれば、valid_actions の `travel_to stairs_*` は「不可: 階段の上に … がいる」、alerts の escape にも「ただし階段の上に … がいて、ふさがれている」。致死の警告（`lethal_range`）に回復の手段（「回復の薬 N・立て直し 使える」）。節目に挑む遠征の状況の行の弱点は、試して分かる前でも記録庫の記憶があれば「投擲に弱い（記録庫の記憶）」
- 観測・所持品: 鑑定済みの品に種類 ID（`ObsInvItem.kind`・`self.attack.throws[].kind`。`javelin` のように `core:` を省く）。観測の所持品の行では投げられる物に `{with:javelin}`、`inventory` の行に「（種類 javelin）」。fight の `with` に渡せる
- 文: 投げた物が見えない所に落ちたら「届かず、見えない所に落ちた。」（前は「消えた」）

最後の AI 評価で直した項目（後方互換。生成と思い出が変わったので `engineVersion` は 0.22.1、自分の `stats_changed` を渡すようにしたので `eventVersion` は 17。DESIGN.md §34.1）:

- イベント: プレイヤーへの射影に `stats_changed`（自分のものだけ。特技・加護・装備で能力値が変わった）
- 生成: 鍵のかかった格子扉は到着地点から歩いて隣に立てる（検査 `vaults_reachable`）。部屋の縁の扉・格子は外へ通じる
- 観測と文: look は見えていないマスの覚えている地物・アイテムも返す（`data.entities[].remembered`）。引退の応答にランの確定点の合計。振り返りの戦闘の行に最も下がった HP。手がかりの組の片方を鑑定済みなら「…のはず」。脆い天井の崩落・胞子嚢の破裂の文。マクロが品のマスで止まったら「足元の X はまだ拾っていない」。階の異変の到着の文を言い換えた
- 規則の文: 遠征の条件は、目標階までのまだ生成していない階に効く

V3-7 で足した項目（プロフィール・記録と図鑑・継承・実績。後方互換。参加と思い出が変わったので `engineVersion` は 0.22.0。出来事の種類は増やしていないので `eventVersion` は 16 のまま。DESIGN.md §34）:

- MCP: `new_run`・`join_run` に任意の `profile_token`（前のランで受け取ったもの）と `legacy`（false で継承しない）。応答に `profile_id`、新しく作ったときだけ `profile_token`（文にも「profile_token: …」。保存して次の `new_run` に渡す）。知らないトークンは `no_session`。新しいツール `records { profile_token?, locale? }`（記録・図鑑・実績・次の節目。省くとこの接続のプレイヤーのプロフィール。手番を消費しない）・`profile { profile_token?, name?, locale? }`（表示名・記録の要約・進行中のラン（`run_id` だけ）。`name` で表示名を変える（トークンが要る））。`declare_goal` の `type` に `codex`・`feats`
- HTTP: `POST /api/runs`・`/api/runs/:id/join` の本文に `profileToken`・`legacy`、応答に `profileId`・`profileToken`（新しく作ったときだけ）。`GET /api/profile`・`POST /api/profile { name }`・`GET /api/profile/records`（`Authorization: Bearer <profile_token>`、`?locale=en`）。`records` の中身は MCP の `structuredContent.records` と同じ
- 参加コマンド（commands.jsonl）: `profile`（プロフィールの ID。トークンではない）・`legacy { monsters: { kind, kills, abilities, hpSeen?, maxHit?, rangeMax? }[] }`
- World State: `PlayerRecord.legacy { kinds }`（継承した種族の数）・`MonsterMemory.legacy { kills }`（覚え書き）・守護者の思い出の `types`（見た型）。ランの要約の `players[].legacy`、リーダーボードの `legacy`
- コンテンツ: `feats.json`（`FeatSchema { id, name, desc, hidden, cond }`、32 個）・`balance.legacy.minKills`（5）。公開カタログの `rules.legacyMinKills`
- 観測: キャンプに `camp.records { line, feats_new? }`（文は「新しい実績: …」と「記録: ラン N・確定の最高・最深。次の節目: 地下5階の大守護者（未踏破）／図鑑 32/62／実績 7/32」）。recall・look の思い出の文は、継承した種族では「（覚え書きより: …）」で始まる。目標の候補に図鑑・実績
- 規則: 図鑑で `minKills` 体以上倒した種族の知識（能力・体力の記録・受けた最大ダメージ・射程）を次のランの開始時に引き継ぐ。外見・守護者の弱点・地図・能力値・装備・加護は引き継がない。サーバー設定 `legacyPolicy`（環境変数 `MUSE_LEGACY_POLICY=off`）・`profilesDir`（`MUSE_PROFILES_DIR`。既定 `runs/profiles`）
- ホスト駆動: `drive --profile-token <tok>`・`--continue`・`--max-runs`・`--no-legacy`

V3-7a で足した項目（目標の宣言。後方互換。World と engine は変えていない。DESIGN.md §28）:

- 目標（`shared/goals`）: `GoalDecl { type, value, within }`・`GoalRecord { id, player, type, value, within, fromNo, best, status: 'active'|'achieved'|'missed'|'withdrawn', endedNo? }`・`GoalCandidate { type, value, within, level: 'match'|'beat'|'beat_big'|'start', text }`・`GoalInfo { active, candidates, record: { declared, achieved }, lines }`。型は depth（最深到達。期限 1〜3 回）・banked（1 回の遠征の確定点。次の遠征）・milestone（次の未踏破の節目の大守護者。1〜3 回）・margin（達成した遠征で、最も下がった HP の %。次の遠征）
- 候補はそのランの本人の遠征レポートの自己最高から（並ぶ／+10%・深さ +1／+30%・深さ +2）。記録が無ければ初期値（深さ 2・3・4、確定 1500・2500・4000、余力 30・40・50%）
- MCP: `declare_goal`。WS: クライアント → `{ t: 'goal', decl: GoalDecl | null }`、サーバー → `view` に `goal: GoalInfo`
- 観測: `camp.goal`（GoalInfo。キャンプの文はこの 3 行で、比較の行（`camp.compare` の文）は出さない。データは残る）・`expedition.goal { type, value, within, text }`（「目標: 1 回の遠征で確定 9700（いま帰ると 6200。あと 3500）」）。確定点の目標なら extract の候補にも差
- 遠征レポート: `goal { type, value, within, diff_from_best, result }`・`combat.min_hp_pct`（最も下がった HP の %）
- ランの記録: `runs/<id>/goals.jsonl`（1 行 = 記録の最新の形。復元時に読み直す）

V3-3b で足した項目（見直し 6。後方互換。規則が変わったので `engineVersion` は 0.16.0、`eventVersion` は 12。DESIGN.md §27）:

- コマンド: `fight.with` は品の種類でもよい（`throwing_knife`・`core:javelin`。手番ごとに同じ種類の品のスロットを引き直す）。`fight.retrieve`（既定 true。投げる物が尽きたら、追跡中の敵の隣を通らずに届く自分の投擲物を拾いに行く）
- コンテンツ: 特技 `core:perk_weak_spot`（急所狙い: フック `thrown_pierce`、ランク 2 まで）と特技の `offerByLevel`。戦利品の項目の `depthMin`。弱点 `core:weak_sleep` の `params.stealthPct`。`balance.expedition.repeatMinPct`。公開カタログ: `perks[id].thrownPierce`・`monsters[id].evasive`・`rules.expedition.repeatMinPct`
- 観測: `visible.monsters[].traits` に `evasive`（素の回避 5 以上）。`camp.milestone.memory.armor`。候補の `guardian.maxHit`（一撃の目安。装甲で減る前）。次の節目の文に、記録庫が装甲を返していれば「いまの持ち物で 1 回に通る目安」
- イベント: `archive_recalled.armor`・`guardian_rested.dispersed`（去った手下の数。遠征の開始で落ち着いたときも、その階を知っている参加者に出す）
- World State: `Entity.minionOf`（呼んだ守護者。プレイヤーには渡さない）。`GuardianInfo.awaySince` は「休み始め」（階を離れた・追跡をやめた）
- 規則: 守護者は追っていない間も回復する（見えたとき・追跡を再開したとき・階に戻ったときに一度に）。落ち着くと呼んだ手下は去り、眠りが深い守護者は眠りに戻る（起こしにくさ +30）。狙い撃ちと不意打ちは朦朧（行動不能の状態異常）の相手にも会心。封じられた下り階段で終えた遠征は、次をその階の上り階段から始める。valid_actions は、投擲の適性が負の職業に投擲の fight を出さず、使い切った能動技を出さず、突進の直線の上では外れる向きの move に印を付ける。移動マクロの経路は、気づいていない守護者の 2 マス以内をできるだけ避ける

V3-5a の後の AI 評価の修正で足した項目（後方互換。`engineVersion` は 0.15.1、`eventVersion` は 11。DESIGN.md §26.1）:

- イベント: `status_expired.targetAffixes`・`ability_used.targetAffixes`（守護者の印を文に出す）
- マクロ: 停止理由 `sense_found`（explore toward:sense で遺物・守護者が見えた・覚えている。最初の判断なら拒否で、travel_to を勧める）。flee の既定の hp_floor は、始める時点ですでにそれ以下なら 0。状態異常で止まるのは、その呼び出しの中で初めて掛かったときだけ（自分が付けた状態と、効き目の無い装甲の修正では止まらない）。fight の hp_risk と観測の「1 手の最悪の被害」に、隣にいる逃走中の敵も入る。collect は敵が乗っている品を後回しにする。足元に拾う品があれば、隣の敵で止まる前に拾う。マクロは、投げて使える有害品（毒薬など）を拾う
- キャンプへ戻ると、能動技の再使用待ちも戻る（`AbilityState.readyAt` を 0 に）
- fight の結果の文は、近接と投擲を分けて数える。遠征レポートの命中は投擲の当たり外れを含む。比較の「最少・最短」は「達成した遠征で」と書く
- 封じられた下り階段の上の extract の文に「次の遠征はこの階段（大守護者の間）から始まる」

V3-5a で足した項目（中層の敵。後方互換。種族と規則が増えたので `engineVersion` は 0.15.0。DESIGN.md §26）:

- 種族: 洞窟狼（`core:cave_wolf`）・錆の粘体（`core:rust_slime`）・呪い火の術者（`core:hexfire_caster`）・石皮の甲虫（`core:stoneskin_beetle`）。大ネズミ・ジャッカル・ゴブリン・ゴブリンの投石兵に深さの上限（4・6・7・9）
- コンテンツ: 射撃の `ranged.pierce`（装甲と構えを無視）、状態異常のハンドラ `stat_mod`（`params.armor` などの修正）と状態異常 `core:rust`（装甲 −2。0 未満にしない。10 手番。重ならない）。公開カタログの `statuses[id].armor`
- 観測: `visible.monsters[].traits` に `rusting`・`pierce`。look に「見た目: …」（見れば分かる特徴）。`self.defense.armor` は状態異常の修正込み（`armorWithStatuses`）。守護者の見込みの特徴に `rusting`・`pierce`

V3-6 で足した項目（振り返り。後方互換。遠征の開始の記録が増えたので `engineVersion` は 0.14.1、`expedition_started` の射影が増えたので `eventVersion` は 10。DESIGN.md §25）:

- 遠征レポート `ExpeditionReport`（`shared/expeditionStats`）: `{ no, objective: { type, target_depth }, status: 'in_progress' | 'ended', reason, payout?: { parts, multiplier_pct, banked, lost }, compare?: { vs_previous?: { no, banked, taken, turns, kills, tool_calls }, personal_best?: string[] }, combat: { dealt, taken, hits, misses, crits, kills, melee_kills, thrown_kills, ability_uses }, economy: { potions_used, scrolls_read, items_left_unidentified, treasure_banked }, tempo: { turns, turns_resting, floors, turns_per_floor, deepest, tool_calls, macro_share_pct }, moments: { seq, turn_no, kind, text }[], death?: { killer, via, self_inflicted?, last_events, hp_trace } }`。`moments.kind` は `hp_min` / `big_hit_taken` / `near_death_escape` / `guardian_fight` / `warden_fight` / `level_up` / `discovery`（最大 8 件、seq 順）。`feats` は V3-7 まで出さない
- 集計の入力は、そのプレイヤーが知覚した出来事（`filterEventsForPlayer`）・自分の `actor_scheduled`（手番の数）・自分が送ったコマンド（`source` が `timeout` と `system` のものは数えない。マクロの呼び出しは 1 件、マクロが展開した手は `macro_share_pct` と休憩の手番に数える）だけ。見ていないものは数えない
- 遠征が終わった行動の応答: `ActionSuccess.report`（全項目）と、結果の行の後に 12 行以内の文（キャンプにいるなら確定と比較の行は観測に出ているので省く）
- 観測: `camp.compare { no, lines, vs_previous?, personal_best? }`（直前の遠征。文は 2 行まで。最初の遠征の後は「比べる記録はまだ無い」の 1 行）
- World State: `Expedition.start[pid].hp / maxHp`（開始時点の HP）。射影した `expedition_started.expedition.self { turns, hp, maxHp }`（自分の分だけ）
- 比較はそのランの中の前の遠征と（プロフィールは V3-7）。自己最高は 確定点・最深・撃破・与ダメージ（すべての遠征と）、被ダメージの最少・手番の最短・呼び出しの最少（達成した遠征どうし）

V3-3a で足した項目（見直し 5。後方互換。規則と候補の作り方が変わったので `engineVersion` は 0.14.0、新しいイベントがあるので `eventVersion` は 9。DESIGN.md §24）:

- 目的の種類 `slay_warden`（節目に挑む）。`Offer.warden`（挑む大守護者）・`Offer.repeatNo`（同じ階の何回目の達成か）
- World State: `GuardianInfo.awaySince`・`Knowledge.guardianTried`（外れた弱点）・`Knowledge.wardenIntel`（記録庫の記憶）・`Knowledge.archive`（納めた遺物）・`PlayerBuild.offered`（候補に出た特技）。PlayerView: `wardenIntel`・`archive`・`EntityView.guardian.notWeak`
- イベント: `guardian_rested { id, guardianName, full, player }`（本人）・`archive_recalled { player, relic, depth, guardianName, memory: 'weakness' | 'vitals' | 'none', weakness?, hp?, maxHit? }`（本人）・`guardian_intel.miss`
- 観測: `visible.monsters[].guardian.not_weak`・`camp.milestone.memory`・`camp.archive { delivered, total }`・`expedition.milestone.memory`。候補の文に「節目に挑む」「この階は N 回目」「納めると、記録庫が…の記憶を 1 つ返す（残り K）」。fight の結果に「初被弾」と hp_risk のヒント
- コンテンツ: `balance.guardian.awayHealPct`・`warden.maxHpBase / maxHpPerDepth / levelBonus`・`expedition.repeatPct`・`fight.firstHitStopPct / recordedKills`、効果 `heal` の `minPct`、弱点の `short`、格 1 の `types: 1`。公開カタログ: `rules.guardianAwayHealPct`・`rules.milestone.levelBonus`・`rules.expedition.repeatPct`・`rules.fightFirstHitStopPct / fightRecordedKills`・弱点の `short`

V3-3 の後の AI 評価の修正で足した項目（後方互換。`engineVersion` は 0.13.1。DESIGN.md §23.1）:

- マクロの停止理由: `hit_and_run`（fight: 待つ間に標的に殴られたが、標的は隣にいない）・`no_progress`（移動マクロが同じ 2 マスを往復した）。`target_not_approaching` は 3 手番続けて近づかないときにも出る
- World State: `Offer.passesWarden`（途中で倒す節目の大守護者。公開）・`healed.resetSeen`（キャンプで落ち着いた敵の、見ていた与ダメの累計を戻す）
- 観測: `self.floor.floor_type_id`・`camp.offers[].text` の「途中の地下N階で大守護者…」・身をかわすの `use_ability slip <dir|dir>`・届かない階段の「不可」の行。守護者には `hp_left_est` を出さない
- コンテンツ: 条件の `excludes`。公開カタログの地物の `afterInteract`

V3-3 の 4 段目で足した項目（物語の文。同じく後方互換。新しいイベントがあるので `engineVersion` は 0.13.0、`eventVersion` は 8。DESIGN.md §23）:

- World State: `Expedition.story`（ブリーフィングの物語の 1 文。公開）。PlayerView: `ExpeditionView.story`
- イベント: `story { reason: 'guardian_slain' | 'warden_slain' | 'relic_delivered', line }`（全員）。`turn.changes` の `story`
- 文: ブリーフィングに物語の 1 文。遺物の説明の前に由来の 1 文。get_rules topic=all の先頭に世界の枠
- コンテンツ: `lore.json`（`kind`・`when`・`weight`・`text`）、アイテムの `origin`。公開カタログ: `lore.frame`

V3-3 の 3 段目で足した項目（節目の大守護者。同じく後方互換。生成と下り階段の規則が変わったので `engineVersion` は 0.12.0、新しいイベントとコマンドがあるので `eventVersion` は 7。DESIGN.md §22）:

- コマンド: `choose_boon { option }`（手番を消費しない。`FREE_COMMANDS`）。MCP ツール `choose_boon`。行動のエラーコード `sealed`（封じられた下り階段）
- World State: `World.milestones { cleared: number[] }`・`CampState.milestone`・`Expedition.milestone`（`MilestoneInfo { depth, name, title?, types }`。公開）・`GuardianInfo.warden`・`Entity.boonChoice { options, source, depth }`
- PlayerView: `milestonesCleared`・`self.boonChoice`・`ExpeditionView.milestone`・`EntityView.guardian.warden`
- イベント: `warden_slain { depth, id, guardianName, by }`（全員）・`boon_offered { target, options, source, depth }`（本人だけ。候補は put の boonChoice）
- 観測: `camp.milestone`・`expedition.milestone { depth, name, types, cleared, text }`・`self.boon_choice { depth, options: { option, id, name, desc }[] }`・alerts の `boon_pending`・valid_actions の `choose_boon N (…)` と封じられた use_stairs の「不可: …」・敵の行の「[大守護者・賞金 N]」・キャンプの文と【遠征】の行の「次の節目: …」
- コンテンツ: floorType の `priority`・`rules.warden`、レイアウト `core:warden_hall`、`balance.guardian.warden { hpPct, minHpBase, minHpPerDepth, bountyPct, types, boonOptions }`。公開カタログ: `rules.milestone { every, min, boonOptions }`

V3-3 の 2 段目で足した項目（遺物と加護。同じく後方互換。遺物の種類と加護が入ったので `engineVersion` は 0.11.0、新しいイベントがあるので `eventVersion` は 6。DESIGN.md §21）:

- World State: `Entity.boons: string[]`（加護。ランの終わりまで残る）・`Entity.boonUsed: Record<加護, 遠征の通番>`（遠征に 1 回の加護）・`RelicInfo { kind, name, boon, boonName?, boonDesc?, owned? }` を `Offer.relic`・`Expedition.relic` に（公開）
- PlayerView: `self.boons`・`self.boonUsed`・`ExpeditionView.relic`
- イベント: `boon_granted { target, boon, source }`（本人だけ。source は遺物の種類）・`boon_triggered { actor, boon, effect: 'last_stand' | 'returned' | 'haste', item?, itemKind? }`（本人だけ。状態の変化は `put`）
- 観測: `self.boons: { id, name, desc, used? }[]`・`camp.offers[].relic { kind, name, boon, boon_name?, boon_desc?, owned? }`・`turn.changes` の `boon`。足元の遺物の valid_actions は `pickup（遺物を拾うと階が目覚める: …）`。候補とブリーフィングの文に遺物と加護。盤面・キャンプの文に「加護: …」
- コンテンツ: `boons.json`（`mods`・`hooks`）、アイテムの `boon`（`category: relic`）。公開カタログ: `boons { name, desc, hooks }`・`items[*].boon`。get_rules topic=classes に加護の一覧

V3-3 の 1 段目で足した項目（守護者の型・予備動作・弱点・棲み処。同じく後方互換。守護者の振る舞いが変わったので `engineVersion` は 0.10.0、新しいイベントがあるので `eventVersion` は 5。DESIGN.md §20）:

- World State: `Entity.guardian { name, title?, types, weakness, summoned?, enraged?, unseen?, lurk?, struck? }`（守護者だけ。`weakness` と内部の数はプレイヤーに渡さない）・`AiState.intent { kind: 'winding_up' | 'summoning' | 'enraging', dir? }`・`Offer.guardian.name / title / types`・`Offer.guardianWeakness`（World だけ。射影で消す）・`Expedition.guardianName / guardianTitle / guardianTypes / guardianWeakness`・`Knowledge.guardianIntel: Record<守護者 id, 弱点 id>`
- PlayerView: `EntityView.guardian { name, title?, types, weakness? }`（`weakness` は知っているときだけ）・`EntityView.intent`（見えている敵だけ）・`ExpeditionView.guardian { rank, name, title?, types }`
- イベント: `guardian_state { id }`（守護者の内部の状態。`put`。誰にも見せない）・`guardian_acted { id, kind, guardianName, act: 'summoned' | 'charged' | 'missed' | 'enraged', count? }`（見えている者だけ）・`guardian_intel { player, guardian, guardianName, weakness }`（本人だけ）。予備動作は `ai_state_changed` の `ai.intent`
- 観測: `visible.monsters[].guardian { name, types: { id, name }[], weakness?: { id, name } }`・`visible.monsters[].intent { code, dir?, on_line?, text }`・alerts の `intent`（`data { kind, dir?, on_line? }`）・`turn.changes` の `guardian`（守護者のしたこと）と `intel`（分かった弱点）。敵の行に「名前」・型・弱点・予備動作。look に型の説明と弱点（知るまで「不明（試して確かめる）」）。候補とブリーフィングの守護者の行に「称号＋名前」
- マクロの停止理由: `intent`（見えている敵が新しく予備動作を見せた。どのマクロも止まる）
- 地物: `core:ward_fire`（護りの火。lit / out。隣で `interact`、または投げた物が落ちると消える）
- 文: 体力の記録が 5 体未満なら「個体差あり」を添え、推定残り HP の上限を出さない（「記録どおりなら残り 3 以上」）
- 公開カタログ: `guardianTypes { name, desc, strongVs, handler }`・`guardianWeaknesses { name, desc, handler, maxArmor? }`（`maxArmor` は V4-1l）。get_rules topic=classes（と all）に守護者の型と弱点の一覧

V3-4b で足した項目（同じく後方互換。点の式と休憩の規則が変わったので `engineVersion` は 0.9.0、新しいイベントがあるので `eventVersion` は 4。DESIGN.md §19）:

- コマンド: `fight` の `until: 'target' | 'clear'`・`adjacent: 'throw' | 'melee' | 'stop'`（MCP ツールの引数も同じ）・`lostOk`（内部用。PlayerPort が、直前の応答で見えていて逃げていなかった標的に付ける）。`explore` の `pickup: boolean | 'useful'`（既定 'useful'）と `toward: 'draft' | 'sense'`、`travel` の `pickup: boolean | 'useful'`
- マクロの停止理由: `rest_cap`（休憩の上限）・`target_fled`（標的が逃げて見えなくなった）・`shot_while_waiting`（待つ間に標的以外の射撃で被弾）・`cleared`（until: clear で届く追跡中の敵がいなくなった）。`cleared` と `rest_cap` は完了した停止
- イベント: `perk_triggered { actor, perk, effect, subject?, subjectKind?, amount? }`（本人だけ）・`monster_woke { id, kind, reason, by, ring, wasAsleep }`（その敵が見えている者だけ）・`player_state.relicLost`（綱で戻って遺物を失った）
- 観測: `self.rest_estimate.cap_hp`（休憩で戻る上限。`hp_to_full` は上限までの HP）。`turn.changes` の `perk`（効いた特技）・`woke`（敵が目を覚ました理由）。`expedition.haul.if_lifeline_now` は目的を除いた戦利品の半分で、遺物を持っていれば文に「（遺物は失う）」
- 文: 【遠征】の見出しは前の応答と同じなら短い形。眠っている敵と 8 マスより遠い敵の行は命中と通りの記録・射線を省く。階段への移動の見込みは敵ごとの「歩く間の攻撃回数 × 受けた最大の一撃」で、「追いつけるのは X 体・射撃 Y 体」を添える。とどめは「N ダメージを与えた（とどめ。残りは M だった）」
- 公開カタログ: `rules.restCapPct`・`rules.fightLostWait`

V3-4 で足した項目（同じく後方互換。成長・戦闘・生成が変わったので `engineVersion` は 0.8.0、新しいイベントがあるので `eventVersion` は 3）:

- コマンド: `attack { target }`・`ability { id, target?, slot? }`・`choose_perk { option }`（手番を消費しない。`FREE_COMMANDS`）・`fight` の `abilities`（V3-4a）。MCP ツール `attack`・`use_ability`・`choose_perk`
- World State のプレイヤーのエンティティに `build { perks, pending: { level, options }[], abilities: { id, readyAt, usedNo?, uses? }[] }`。`readyAt` は自分の手番数（`actor.turns`）と比べ、使った手番に `turns + 1 + cooldown` になる。PlayerView の `self.build` はその写し（自分のものだけ）
- 品物に `item.hidden`（見えていない呪いの接辞）と `item.inspected`（呪いの有無を確かめた）。`hidden` はプレイヤーに渡さない（PlayerView・観測・イベントのどこにも出ない。漏洩テストで確かめる）。ItemView の `inspected`
- イベント（状態の変化は `put`）: `perk_offered { target, level, options }`（options が空なら前の候補を選んだ後に引く）・`perk_chosen { target, perk, level, ability }`・`ability_used { actor, ability, target, cooldownLeft }`・`curse_revealed { actor, item, kind, appearanceId, affixes, via: 'equip'|'identify' }`・`item_inspected { ..., via }`・`curse_lifted { ..., affixes }`。`level_up.gains` の命中・威力・回避は常に 0（固定成長は最大 HP だけ）
- 特技の候補は状態を持たないハッシュ（`seed|perk|プレイヤー|レベル`）で引き、`perk_offered` の after 値として World に入る
- 観測: `self.perks`・`self.abilities`・`self.perk_choice`・alerts の `perk_pending`・`self.attack.acc` と `throws[].acc` に習熟と装備の命中・所持品の `curse`（`unknown` / `cursed`）と `stats`（`weapon.traits`・`armor.move_cost` / `wake_pct`・`mods`）・`valid_actions` の `choose_perk` / `use_ability` / `attack`
- 公開カタログ: `perks`・`abilities`（`handler` を含む）・`weaponTraits`（`reach`・`attackCost`）・`classes[*].proficiency / lineages / startPerks`・`classes[*].growth` は `maxHpPerLevel` だけ・`items[*].equipStats`・`affixes[*].cursed` と `itemMods` の追加項目・`rules.perkOptions` / `curseChancePct`

V3-2R3b で足した項目（同じく後方互換。守護者の動きが変わったので `engineVersion` は 0.7.0）:

- World State のエンティティに `home { x, y }`（守護者の持ち場。置かれたマス、守護者付きの遺物では遺物の隣）。プレイヤーには渡さない（PlayerView・観測・イベントのどれにも出ない。`entity_spawned` と `player_state.put` はもともと俯瞰専用・除去済み）
- 気づいていない守護者は持ち場から `balance.guardian.leash`（3）マス以内だけを動く（外にいれば持ち場へ向かう）。追跡と見失った後の捜索は今までどおりで、捜索を終えると持ち場へ戻る。遠征の開始時に再開する階を落ち着かせるとき、守護者は持ち場（ふさがっていれば範囲の中の近い空きマス）へ `entity_moved`（`mode: 'teleport'`, `seenBy: []`）で戻す
- `alerts` の `escape` の `data` に `worst_if_chased`（V3-4b からは敵ごとの「歩く間に攻撃できる回数 × 受けた最大の一撃」の合計。記録の無い敵がいれば null）と `hp`
- `valid_actions` の `travel_to stairs_*` に、追跡中の敵が届くとき「階段まで N 歩。追われたままなら最悪 M の被害（HP h）」（記録の無い敵がいれば「最悪の被害は不明」）。一番近い階段でも M が HP 以上で帰還の綱を持っていれば、綱の `use_item` を階段の候補より前に並べる（記録の無い敵がいるときは記録のある分だけの M で判断する）

V3-2R3a で足した項目（同じく後方互換。再開の規則が変わったので `engineVersion` は 0.6.0）:

- `expedition_started.expedition.start[pid].pos`（その参加者がこの遠征を始めた地点）。綱で戻った `player_state.extractPos` はこの地点
- 遠征の開始時に再開する階を落ち着かせる: その階の敵の `ai_state_changed`（追跡をやめて unaware）・`healed`（`via: 'camp'`、全快）・`entity_moved`（`mode: 'teleport'`、再開するマスが見える敵を離れた場所へ）。どれも `seenBy: []`（その時点で盤面にプレイヤーはいない）

V3-2R3 で足した項目（同じく後方互換。到達の条件・候補の基準・点の式・経験値が変わったので `engineVersion` は 0.5.0）:

- 遠征の候補 `offers[].guardian { rank, traits }`（公開）と `guardianKind`（種族。射影で伏せる: `expedition_offered` と PlayerView の `camp` から外す）。`expedition_started.expedition.guardianKind` / `guardianRank`（プレイヤーには渡さない）
- 思い出のキー: 守護者は `guardian|種族`（`memoryAfter.guardian: true`）。`memoryAfter.dmgByYou { melee?, thrown? }`（[合計, 回数]）
- `SpawnSpec.hpBonusPct`（守護者の格の体力の上乗せ）
- PlayerView の `campDepth`（目標として達成した最深の階）
- 到達（踏破型）の達成は「目標階以上の下り階段に参加者が立った」（`progressAfter.reached`）
- 撃破の経験値 = 個体の経験値 × (100 + `xp.killDepthPct` × (深度 − 1))%

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

システムの命令（`player: null` の `join` のほかに、S0 の `season_sync`）も同じ記録に入り、再実行で流す。`season_sync` は、共有層（シーズン）から来たものをランに入れる唯一の口で、中身（予算の残り・公開された階段・順位の写し・報告の結果）をそのまま持つ。再実行は記録だけで一致する（シーズンの記録を読まない）。§9.7

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
| `POST /mcp` ほか | MCP Streamable HTTP。使われていないセッション（処理中の要求も開いたままの GET の流れも無いもの）は、束縛していなければ 30 分、束縛していれば 6 時間で閉じる。閉じた・知らないセッションの ID には 404（`Unknown MCP session`。つなぎ直す）。S0b（§5 の S0b の項目、SEASON.md §7.9） |
| `GET /api/runs` | ラン一覧（進行中・終了済み）。サーバーの起動時に復旧できなかったランには `recoveryFailed: { reason, at }`（V4-1m。理由の 1 行と時刻。`live: false`・`joinable: false`）。人間の画面のランの一覧にも出す |
| `GET /api/runs/:id/meta` | meta（終了前はシード無し） |
| `GET /api/runs/:id/events?from=&to=` | イベント範囲（JSONL） |
| `GET /api/runs/:id/keyframes` / `/:seq` | キーフレーム一覧／取得（進行中は secret 除去） |
| `GET /api/runs/:id/index` | リプレイ用マーカー索引（フロア移動・撃破・死亡・遠征の開始／目的達成／終了などの seq）と `expeditions`（遠征単位の選択用） |
| `GET /api/leaderboard` | 記録の一覧。各項目に `scoreVersion`（1 / 2）。版 2 を先に、版 2 は確定点 → 達成した遠征の数 → 最深、版 1 は達成した遠征の数 → 最深 → スコアの順。キャンプ中の途中経過（`ongoing`）も含む（`controller.kind` は表示用）。版の違う記録は別の表として扱う |
| `GET /api/player/feed` | **ターンフィード**（SSE、v2）。`Authorization: Bearer <player_token>` か `?token=`。下記 |
| `GET /api/health` / `GET /api/config` | 生存確認 / `spectatorPolicy` |
| `GET /api/content/catalog` | 公開カタログ |
| `POST /api/runs` / `POST /api/runs/:id/join` | ランを開始・参加（`{ name, classId?, seed?, mode?, locale?, objective?, controller?, season?, profileToken? }`。`season` は S0 §9.1 → `{ runId, playerId, token }`。`controller` を省くと `{ kind: 'unknown' }`。V4-1g。ブラウザの画面は `human` を送る。参加はキャンプから始まる）。開始時は最初の遠征まで始める |
| `GET /api/runs/:id/commands` | commands.jsonl（AI パネルのツール呼び出し・thought 表示用） |
| `GET /api/runs/:id/summary` | 終了時サマリー |
| `GET /api/seasons` / `GET /api/seasons/:id` | S0（§9.8）。シーズンの一覧 / 1 つのシーズンの順位の表・確定した結果・坑の断面（S2 §9.11。公開された階段の位置は出さない） |

### 8.1 ターンフィード（`GET /api/player/feed`）

ホスト（AI を動かす側のループ）が「手番が来た」を外部から受け取る経路。ゲームの進行には影響しない（ソロでは手番を自動で進めない）。SSE の `event:` 名と `data:` の JSON（`FeedEvent`、`protocol.ts`）:

| event | data | いつ |
|---|---|---|
| `hello` | runId, playerId, seq, turn | 接続直後 |
| `turn` | …, turn, observation_text（brief。変化と状態行付き） | 自分の手番が来た（同じ手番では 1 回。マクロ展開中は送らない） |
| `idle` | …, seconds, turn | 手番のまま `idleNoticeMs`（既定 60 秒、`MUSE_IDLE_NOTICE_MS`）入力が無い。その間隔ごと |
| `ended` | …, scope: 'expedition' \| 'run', turn, text, summary | 遠征の終了（キャンプ）またはランの終了 |

参照ドライバ `npm run drive`（`packages/tools/src/drive.ts`）がこのフィードを購読し、差し替え可能な「エージェント呼び出し」（任意のコマンド実行／HTTP POST／内蔵ダミー）を呼ぶ。MCP のリソース購読通知は実装していない（任意項目）。

---

## 9. シーズン（S0。SEASON.md §2）

シーズンのランだけの決まり。**シーズンでないランは何も変わらない**（SEASON.md §1.2 の 5。生成・候補・観測・出来事のどれも）。版は `engineVersion` 0.38.0・`eventVersion` 22（S1 で 0.39.0・23、S1a で 0.39.1・24、S1b で 0.40.0・25、S1c で 0.41.0・26（シーズン）と 0.42.0・27（すべてのラン）。§5 のそれぞれの「変えた項目」）。

### 9.1 シーズンと参加

- **開く**: 運用者が `npm.cmd run season -- open --id <id> --seed <seed> --ends "<ISO 8601 の時刻>" [--name <名前>] [--budget 3000]`（PowerShell では `npm` でなく `npm.cmd` と書き、カンマや `+` を含む値は引用符でくくる。`npm run` だと名前付きの引数が消える。道具は、使われなかった引数があればそう知らせる）。定義はサーバーの記録の置き場所の `seasons/<id>/season.json`（既定は `runs/seasons`。`MUSE_SEASONS_DIR` で変えられる）。動いているサーバーは、知らない ID を聞かれたときに読み直すので、起動し直さなくてよい。
  - `SeasonDef { id, name, seed, engineVersion, contentVersion, budget, endsAt, openedAt }`。`engineVersion`・`contentVersion` は開いたときの版。サーバーの版と違えば、そのシーズンのランは始められない（SEASON.md §2.1: 開いている間、版は変えない）。
  - ほかに `season -- list`・`season -- standings --id`・`season -- close --id`（すぐ確定する）・`season -- wardens --seeds "a,b,c"`（シードごとの地下 5 階の大守護者の種族と装甲の目安。§2.8 のシード選び）。
- **招く**（S0a。SEASON.md §4.1）: 運用者が `npm.cmd run season -- invite --id <id> --name <表示名> [--profile-token <今あるトークン>]`。
  - `--profile-token` を省くと、その表示名で新しいプロフィールを作り、そのトークンを**この 1 回だけ**表示する。運用者が参加者へ手で渡す。渡すと、今あるプロフィールを招く（トークンは表示しない）。
  - 表示名は、同じシーズンの中で重ならないこと（前後の空白を除き、大文字と小文字・全角と半角を区別しないで比べる）。重なれば断る。同じプロフィールを 2 回は招けない。
  - 招いた者は `seasons/<id>/invites.json`（`{ profileId, name, invitedAt }[]`。トークンは入れない）。このファイルを書くのは運用の道具だけで、サーバーは参加のたびに読み直す（起動し直さなくてよい）。
  - `season -- invites --id <id>`: 招いた者の一覧（表示名・プロフィールの ID・ランの数。トークンは出さない）。
  - **招きの取り消し**（S0b。SEASON.md §6.2 の 5）: `season -- uninvite --id <id> --name <表示名>`（招いたときと同じ比べ方）か `--profile <profile_id>`。**このシーズンのランを 1 回も始めていない者だけ**（始めた者は、順位と予算の記録があるので断る）。`invites.json` から外し、`log.jsonl` に `uninvited`。プロフィールそのものは消さない（そのトークンでは、もうこのシーズンのランを始められない。シーズンでないランには使える）。外した表示名は、また使える。確定したシーズンでは断る。
- **参加**: `new_run { season: <id>, profile_token }`（HTTP は `POST /api/runs { season, profileToken }`）。`profile_token` は必須で、そのシーズンに招かれたプロフィールのものだけ。1 つのプロフィールが、1 つのシーズンに 1 人の参加者で、順位の表の名前は招いたときの表示名（`character_name` はキャラクターの名前で、順位には使わない）。倒れた後の新しいランも、同じトークンで同じ参加者として数え、予算は続きから。
- トークンは、リポジトリ・ランの記録・シーズンの記録・観測・順位の表のどれにも出さない（プロフィールのファイルにはハッシュだけ）。
- シーズンのランは**ソロ**。シーズンのシードで、Lv1 のキャンプから始まる（`seed`・`mode`・`objective` は使わない）。継承（V3-7）は受けない。シーズンのランの記録は、後のランの継承に使わない。記録・図鑑・実績は付く。
- 同じ参加者のシーズンのランは、同時に 1 つ。倒れる・引退でランが終わったら、同じシーズンで新しいランを Lv1 から始められる（回数の上限は無い）。
- 断るとき（`season_unavailable`。理由は message）: `profile_token` が無い・知らないトークン・そのシーズンに招かれていない（運用者に招いてもらうよう書く）・知らないシーズン・終わったシーズン（終わりの時刻を過ぎた）・版が違う・予算が残っていない・進行中のシーズンのランがある。
- RunMeta に `season?: { id, name }`（ランの始まりから。俯瞰とプレイヤーの両方に見える）。ランの一覧（`RunListing`）にも `season?`。

### 9.2 行動予算

- 参加者 1 人につき、シーズンを通して**自分の手番 `budget` 個**（既定 3,000）。迷宮の中の自分の手番だけを数え、マクロの中の手番も 1 つずつ数える。キャンプでは減らない。ランをまたいで 1 つ（倒れてやり直しても戻らない）。
- ランの中の残り = 最後に取り込んだときの残り `season.budget.left` −（今の自分の手番 − 取り込んだときの自分の手番 `season.budget.at`）。サーバーは取り込みのたびに、その参加者のすべてのシーズンのランの手番の合計から `left` を決める。
- **残りが 0 になった手番の終わりに、その遠征は時間切れで終わる**: `player_state { state: 'at_camp', reason: 'time_up' }`、`expedition_ended { reason: 'time_up' }`。未確定の戦利品は失い（`lost` に入る。確定 0）、持ち物は残る（宝・遺物も持ったまま）。倒れた扱いにしない（生還賞は残る）。マクロの途中なら、マクロは `time_up` で止まる。
- 予算が残っていなければ、`start_expedition` は `budget_exhausted` で断る。キャンプでの操作・報告・引退はできる。
- 終わりの時刻を過ぎたら（キャンプで取り込んだ `season.ended`）、`start_expedition` は `season_ended` で断る。出ている遠征は、帰るか倒れるまで続けてよい（その分も順位に数える）。

### 9.3 階段の位置

- シーズンのランでは、同じ階の入口（上り階段）と下り階段の位置は、だれが・いつ・どの遠征で作っても同じ（シーズンのシードと版だけで決まる）。テストで守る。そのために、シーズンのランでは:
  1. 宝物庫を開ける遠征（`open_vault`）を候補に出さない。
  2. 賞金首の遠征の目標階は、異変を「賞金首」に置き換えずに、賞金首を**足す**。本来の異変はそのまま（地形・敵と品の数・巡回の強敵・眠りも）で、賞金首はその後で入口から 8 マスより遠いマスに置く。異変の札（到着の文）は本来の異変のもので、本来の異変が無ければ「賞金首」（SEASON.md §2.3 の 2 の「置き換えても地形が変わらない作り」。実装メモは SEASON.md §3.1）。
  3. 生成の検査（階段への道の長さ・入口のそばに敵がいない など）を、遠征の目的（守護者・遺物・棲み処）を置く前に済ませる。目的を置けなかったときは、作り直さずに目的のない階にする（置けないのは入口から 8 マスより遠い床が無いときだけで、今の生成では起きない）。
- 守護者の棲み処の地形（柱・浅い水）と、条件による格子扉の違いは残る（階段は変わらない）。

### 9.4 報告と公開された階段

- **`report_stairs`**（MCP のツール、WS の `{ type: 'report_stairs' }`）。キャンプでだけ。手番を使わない。このランで**自分の目で見た**下り階段と特別な場所（S1c。下）（地図の巻物や公開で知っただけのものは入らない）のうち、このランでまだ報告していないものを全部送る。サーバーに届いた順で、その階の下り階段・そのマスの特別な場所を最初に報告した参加者に**貢献 1**（その場で付く）。2 人目からは付かない。
- 結果: 出来事 `stairs_reported { player, stairs: { depth, x, y, first }[], spots?: { depth, x, y, kind, first }[], gained }`（本人だけ。`gained` は両方の最初の報告の数）と、取り込み（`season_synced`）。
- 断る: シーズンでないラン（`bad_request`）、キャンプでない（`not_at_camp`）、送るものが無い（`nothing_to_do`）。倒れた・ランが終わった後は送れない（そのランの報告していないものは、報告できなくなる）。
- **特別な場所**（S1c。SEASON.md §14.5・§15）: 種類 `core:altar`・`core:gamble_altar`・`core:inscription`（shared の `SEASON_SPOT_KINDS`）の地物のうち、**部屋の作り（prefab）の中にあるもの**（節目の階は除く。S1d）（`isSeasonSpot`: 階の `regions` の `kind: 'prefab'` の範囲。守護者の棲み処の地物 `lairOf` と野営の火は除く）。シーズンの生成では、部屋の作りは目的・条件より前に置くので、だれの世界でも同じ階の同じマスにある（`season.test.ts` の §2.3 のテストで守る）。泉は対象にしない（条件「静か」で、その遠征で初めて作る階から消える）。部屋の外にばらまかれる祭壇も対象にしない（条件の敵・品の数で場所が変わる）。
  - 自分の目で見た: そのマスを見た（覚えている地図の地形があり、地図の巻物・道しるべで知っただけの `mapped` でない）。このランで報告したものは `SeasonState.reportedSpots`（深さと座標）。
  - 公開された特別な場所は、取り込み（`season_sync` の `season.spots: { depth, x, y, kind, by }[]`。報告の順）で届き、その階に入ると、自分の世界のそのマスに同じ種類の特別な場所があれば、覚えている地図に載る（`knowledge_updated { rememberedSet: [その地物], publicSpot: <報告した者> }`。地形・途中の道は載せない。いま見えていれば、目で見て覚える）。観測の `visible.features[].public_by`（そのマスをまだ自分の目で見ていない間）と、文の「（公開: ○○ が報告）」。使い方は変えない（泉・祭壇はその世界で 1 回）。
  - キャンプの観測: `season.spots { unreported, unpublished }` と「まだ報告していない特別な場所 N（うち、まだだれも公開していないもの M）」（見つけたものがあるときだけ）。`valid_actions` の `report_stairs` に件数。
- **取り込み**は、キャンプに着いたとき（遠征の終わり）・遠征を始めるとき・報告したときだけ。取り込んだ一覧が `season.public`。遠征の途中で公開されたものは、次の遠征から見える。
- **公開されている階に入ると**、その階の下り階段のマスが覚えている地図に載る（`knowledge_updated { newlySeen, mappedAdd, publicStairs: <公開した者の名前> }`）。地図の巻物と同じ「地形は分かっているが、まだ見ていない」マス。
  - **道しるべのマスの地形**（S1c。SEASON.md §14.6 の 5・§14.10 の 2）: 階段のマスのほかは、その階の普通の床（バイオームの床）として載せる。その世界だけの浅い水・柱のそばの地形・扉（開いているか閉じているか）を載せない（棲み処の場所の手がかりにならないように）。自分の目で見たら、本当の地形に直る（知覚が見た地形と比べて `newlySeen` にする）。道の曲がり方から、その世界だけの柱の場所が推し量れることは受ける。
  - **道しるべ**（S1b。SEASON.md §12.4 の 1）: 同じ出来事で、入口（`floor.entry`。上り階段。地下 1 階は最初の入口）から公開された下り階段までの、いちばん短い道のマス（入口と階段を含む。幅 1 マス。まわりの部屋は載せない）も載せる（`publicPath: true`。`newlySeen`・`mappedAdd` は、そのうちまだ覚えていないマス）。道は**自分の世界のその階の地形**で引く（通れる地形と扉。鍵のかかった格子扉・閉じた格子扉・壁・瓦礫・柱は通らない）。敵・罠・地物は見ないので、隠れた罠の場所は道の引き方から分からない。向きの順は固定で、乱数は使わない（生成の乱数も、入口と階段も変わらない。§9.3）。引けなければ、今までどおり階段のマスだけ（`publicPath` は無い）。
  - 載せる時機: その階に入ったとき（取り込みで公開を知った後、まだその階段のマスを覚えていなければ）。作ってある階も、後で作る階も同じ。覚えている地図はその階にいるときしか見えないので、取り込みのときに載せるのと見え方は同じ。
  - 観測: `navigation.known_stairs[]` の `public_by: string`（自分の目で見るまで）。下への風（`self.floor.draft`）は、公開された階段を自分の目で見るまで出続ける（`explore { toward: 'draft' }` はその方角を探し、風が消えたら `stairs_seen` で止まる）。
  - `travel_to stairs_down` は、覚えている地図だけで道を探す。道しるべがあれば最初から通る。道しるべを引けなかった階では、途中の道が分かるまで `unreachable` で断られる（手番は使わない）。そのときのヒントに `explore { toward: 'draft' }` を出す。
- S0 で公開できるのは下り階段だけ。1 つの階の下り階段は 1 つ。

### 9.5 賞と順位

| 賞 `id` | 値 `value` | 同着のとき（少ないほうが上） |
|---|---|---|
| `adventure` 冒険賞 | シーズンで着いたいちばん深い階（ランをまたいだ最良。着いた時点で数える。帰れなくてもよい） | その階に初めて着いたときまでに使った予算 |
| `contribution` 貢献賞 | 最初に報告した階段と特別な場所（S1c）の数（シーズンの合計） | 最後の 1 つを報告したときまでに使った予算 |
| `survival` 生還賞 | シーズンで一度も倒れていない参加者の、確定した点の合計（シーズンのすべてのランの `banked`） | 使った予算 |
| `support` 支援賞（S1） | 自分の野営の火を、ほかの参加者が使った人数（延べ。火ごとに同じ参加者は 1 回。§9.10） | 使った予算 |

- 順位は値の大きい順。値も同着の決め方も同じなら同じ順位（1, 2, 2, 4）。倒れた参加者は生還賞の対象外（`value: null`・`rank: null`）。時間切れは倒れた扱いにしない。
- 順位の写しは取り込みのときに入る（キャンプで見るものが、その遠征の間の最新）。

### 9.6 観測と PlayerView

```ts
PlayerView.season?: SeasonState & { unreported: number; unpublished: number }   // シーズンのランだけ
SeasonState {
  id, name
  budget: { limit: number; left: number; at: number }   // left: 取り込んだときの残り、at: そのときの自分の手番
  ends_at: number            // 終わりの時刻（表示用。ゲームは ended だけを見る）
  ended: boolean             // 取り込んだとき、終わりの時刻を過ぎていた
  public: { depth, x, y, by }[]   // 公開された下り階段（by は最初に報告した者の名前）
  awards: SeasonAward[]
  contribution: number       // 自分が最初に報告した数
  died: boolean              // このシーズンで倒れたことがある
  reported: number[]         // このランで報告した階の深さ
  // S1 以降（どれも任意）は §9.10。S1c: spots（公開された特別な場所 { depth, x, y, kind, by }[]）・reportedSpots（このランで報告した特別な場所）・
  // fireNews（前の取り込みから新しく自分の火を使った者 { depth, x, y, names }[]。キャンプで見せるまで持ち越す）
}
SeasonAward { id: 'adventure'|'contribution'|'survival'; value: number|null; rank: number|null; entrants: number; leader: { name, value }|null; gap: number|null }

Observation.season?: {
  id, name
  budget: { left, limit }
  ended: boolean
  awards?: (SeasonAward & { text })[]          // キャンプだけ
  stairs?: { unreported, unpublished }         // キャンプだけ。報告していない階段（うち、まだだれも公開していないもの）
  spots?: { unreported, unpublished }          // キャンプだけ（S1c）。報告していない特別な場所
  fire_news?: { depth, x, y, names, text }[]    // キャンプだけ（S1c）。自分の火を新しく使った者
  support?: { placed, limit, text }            // 迷宮で、いま火を置けるマスにいるとき（S1c）。支援賞の行と自分の火の数
  text: string                                 // 予算の 1 行
}
```

- 文: 迷宮の中は 2 行目に予算の 1 行（「シーズン「S0」: 残りの予算 2,140/3,000 手番」）。順位は出さない。
- **予算の終わりぎわの知らせ**（S1b。SEASON.md §12.4 の 2）: 迷宮の中で、残りの予算が、いちばん近い着ける階段（`navigation.known_stairs` の `path_len` がある上り・下り階段。どちらでも extract できる）までの歩数の 2 倍を下回ったとき、または 100 を切ったときは、`alerts` に `budget_low`（`data: { left, stairs: 'up' | 'down' | null, path_len: number | null }`）。文は「予算の残り 37 手番。いちばん近い着ける階段（上り階段）まで 25 歩（尽きると時間切れで、未確定の戦利品を失う）」。着ける階段が分からなければ「着ける階段が分からない（既知の道で届く階段が無い。…）」、階段の上なら「いま上り階段の上にいる（ここで extract できる。…）」。キャンプとシーズンでないランには出さない。
- キャンプは、予算の 1 行・賞ごとの 1 行（自分の値と順位、1 位の名前と値、1 位との差）・「まだ報告していない階段 N（うち、まだだれも公開していないもの M）」。`valid_actions` に `report_stairs`（報告できるものがあるとき）。予算が無いか終わりの時刻を過ぎたら、候補の代わりにその 1 行。
- 参加したときの最初の観測（briefing）に、シーズンの決まりを短く出す。

### 9.7 記録と再生

- 共有層から来るもの（予算の残り・公開された階段・順位の写し・報告の結果）は、システムの命令 `season_sync` として commands.jsonl に残し、engine が出来事 `season_synced`（と `stairs_reported`）にして `applyEvent` で World（`world.season`）に入れる。予算が尽きたこと（時間切れ）は、engine が取り込んだ値から手番ごとに決める。どれも再生は記録だけで一致する。

```ts
SeasonSyncCommand {
  type: 'season_sync'
  reason: 'join' | 'camp' | 'start' | 'report'
  season: Omit<SeasonState, 'reported' | 'budget'> & { budget: { limit, left } }   // at は engine が今の手番で埋める
  report?: { stairs: { depth, x, y, first }[]; spots?: { depth, x, y, kind, first }[] }   // spots は S1c
}
// S1c: season.spots（公開された特別な場所）、season.fires[].users（自分の火を使った参加者の表示名。数えた順）
// 記録: player はその参加者、source は 'system'（報告のときは送った者の source と thought）
```

- シーズンの側の記録は `seasons/<id>/` に残す: `season.json`（定義）・`participants.json`（参加者ごとのラン・使った予算・最深とそのときの予算・最初の報告の数（階段と特別な場所）・倒れたか）・`public.json`（公開された階段と報告の順）・`spots.json`（S1c。公開された特別な場所 `{ order, depth, x, y, kind, by, profileId, runId, used, wall }`）・`log.jsonl`（参加・ランの始まりと終わり・報告・取り込み・順位の移り変わり・確定）・`result.json`（確定した結果）。
- 確定: 終わりの時刻の後、参加者の全員が迷宮にいない（キャンプにいるかランが終わった）か、終わりから 1 時間たったら。確定の後は記録を変えない。
- 観戦: シーズンのランは `follow_only`（サーバーの `spectatorPolicy` によらない）。俯瞰の観戦から公開されていない階段が分からないように。

### 9.8 HTTP

- `GET /api/seasons` → `{ seasons: { id, name, budget, endsAt, status: 'open'|'ended'|'final', participants, invited }[] }`（`participants`: 1 回でもランを始めた数、`invited`: 招いた数）
- `GET /api/seasons/:id` → `SeasonStandingsResponse { season, standings: SeasonStandingRow[], result?: SeasonResultView, section: SeasonSectionRow[] }`（公開された階段の位置は出さない。人間の画面のロビーの順位の表と、結果の画面。S2 §9.11）
  - `SeasonStandingRow { name, runs, used, died, adventure: { value, rank }, contribution: { value, rank }, survival: { value, rank } | null, support?, banked?, titles? }`。`banked`（S2）は確定した点の合計（倒れた者も。火の費用を引いた後）。`titles`（S2）は、その参加者が確定したすべてのシーズンで得た称号（`SeasonTitle`）。
  - `result`（確定したシーズンだけ）: `{ finalizedAt, reason, winners, standings, titles?: (SeasonTitle & { holder })[], deeds?: { depth, name }[] }`。
  - `section`（S2。坑の断面）: 階ごとの `{ depth, deepest: string[], stairs: { by } | null, spots: { kind, by }[], fires: { by, uses }[], firstWarden? }`。位置は出さない（階だけ）。`deepest` は順位の表の冒険賞の値、`stairs`・`spots` は公開されたもの、`fires` は共有層に載った火（取り合いで載らなかった火 `dup` は除く）、`firstWarden` は確定したシーズンだけ。進行中のシーズンでも同じ決まり（公開されていないものは出さない）。
  - プロフィールの ID・トークンは出さない。

### 9.9 規則の文

`get_rules { topic: 'season' }`（`all` にも入る）: シーズン・予算と時間切れ・階段と特別な場所の報告と公開・4 つの賞と同着の決め方・野営の火（S1。置いた本人の得を先に書き、ほかの者に使われると支援賞に数えることを後に書く。S1c）・火から帰る。

### 9.10 野営の火と支援賞（S1。SEASON.md §8）

**置く本人の得**（S1c。SEASON.md §14.3）: 火の上か隣から帰還・撤退できる（下の「帰る」）・火から帰ると次の遠征はそこから始まる・休憩の上限まで回復（下の「使う」）。ほかの者に使われると支援賞に数える。

**置く**（`place_fire`。迷宮の中・1 手番・自分のいるマス）:

- 費用: 階の深さ × `balance.season.fireCostPerDepth`（S1 は 200、**S1c から 100**）点を、**このランの確定した点**（`stats.banked`）から払う。払った点は戻らない（生還賞の数字も下がる）。
- 断る（手番を使わない。`message` に理由と足りないもの）: シーズンのランでない（`bad_request`）・節目の階（5 の倍数の深さ）・階段・扉・格子扉の上・ほかの地物か罠のあるマス・ほかの火（だれのものでも。この世界にある火）から `fireSpacing`（5）マス以内（チェビシェフ距離）・追ってくる敵が見えている（`hostile_in_view`。休憩と同じ判定。S1a）・この深さに自分の火がもうある・シーズンを通して `firesPerSeason`（3）つ置いた（取り込んだ自分の火＋このランでまだ載っていない火）・確定した点が足りない（`cannot_use`）。
- 出来事: `entity_spawned { reason: 'fire_placed', entity: { kind: 'core:camp_fire', feature: { state: 'lit' }, campfire: { by } } }`・`player_stats`（`banked` が減る）・`fire_placed { player, depth, x, y, cost, placedAfter }`（`placedAfter` は `SeasonState.placed` の after 値）。置いた本人の世界には、その手番からある。
- 共有層へ載るのは、**その者がキャンプに着いたとき**（遠征の終わり）か、**そのランが終わったとき**（倒れた・引退）。サーバーが `SeasonState.placed` を読んで載せる。同じマスにほかの者の火がもう載っていれば、ほかの者には渡さないが、置いた者の火として `dup: true` で残す（`log.jsonl` に `fire_duplicate`。費用は戻らない。S1a）。5 マスの決まりは、置く者の世界で見るだけ（ほぼ同時に近くへ置かれた火は、どちらも載る）。

**届く**: 取り込み（`season_sync` の `season.fires: { depth, x, y, by, mine?, uses? }[]`。`mine` は自分の火、`uses` は自分の火が支援賞に数えられた回数）で届く。engine は取り込みのときに、作ってある階のすべてに、まだその階のそのマスに火が無ければ、火を置く（`entity_spawned { reason: 'season_fire' }`）。まだ作っていない階には、その階を作ったとき（生成の後。生成の乱数は使わないので、入口と階段は変わらない。§9.3）に置く。**どの世界でも、同じ階の同じマスに置く**。

- そのマスの世界ごとの違い（決めたこと。SEASON.md §9.4）: 品・敵がいても置く（同じマスにいてよい）。ほかの地物・罠と重なっても置き、その世界の地物・罠は今までどおり働く（火は、地物の判定 `featureAt` に入らない。罠も踏めば働く）。立てない地形（棲み処の柱など）でも置き、隣から使える。
- その階に入ると、火が覚えている地図に載る（`knowledge_updated { rememberedSet, publicFire: <置いた者> }`。火があることだけで、そのマスの地形と途中の道は分からない。S1a）。

**帰る**（S1c。SEASON.md §14.3 の 1・2）: 階段の上でなく、野営の火の上か隣（チェビシェフ距離 1 以内）で `extract`（撤退なら `confirm: true`）。

- 断る（手番を使わない）: 追ってくる敵が見えている（`hostile_in_view`。休憩と同じ判定: 隣にいない動かない敵は数えない。文に「階段の上なら、追われていても帰れる」）・予算の残りが帰り支度の手番に足りない（`cannot_extract`）・目的が未達成で `confirm` が無い（`confirm_required`。階段と同じ）。
- 帰り支度: `balance.season.fireReturnTurns`（5）手番（`extract` の手番を含む）。`extract` の手番に `fire_return { phase: 'start', turns }` と状態 `core:fire_return`（行動できない。残り `turns − 1`。`power` は `confirm` なら 1）。残りの手番は行動できずに過ぎ（1 回の `extract` の呼び出しで済む）、状態が切れた手番に `fire_return { phase: 'done', completed }` と、階段と同じ確定（`player_state { state: 'at_camp', reason: 'extracted' | 'withdrew' }`。綱ではない。遺物は納める）。
- 取りやめ: 帰り支度の手番の始めに、追ってくる敵が見えた（休憩と同じ判定）・火のそばから離された・（切れたときに）目的が未達成で `confirm` が無かった、帰り支度の間に被害を受けた（S1d。毒も・見えない相手に撃たれた場合も）、なら `fire_return { phase: 'cancel', reason: 'hostile' | 'moved' | 'not_complete' | 'damaged' }` で状態を外し、その手番から行動できる。過ごした手番は戻らない。もう一度帰るなら、最初から。
- 次の遠征は、帰ったマス（火の上か隣。`player_state.extractPos`）から始まる（階段で帰ったときと同じ決まり）。
- 階段での帰還は、今までどおり、追われていてもすぐできる。階段の上なら階段が先（隣に火があっても）。置いた本人の火でも、ほかの者の火でも同じ。帰還は遠征に 1 回なので、回数の上限は無い。
- 観測: `expedition.can_extract`・`extract_via { type: 'fire', by, turns }`・`extract_blocked_by`（`hunted_at_fire`・`budget_at_fire`）。`valid_actions` の `extract` の行に「○○ の野営の火から。帰り支度 5 手番（この手番を含む。その間に追ってくる敵が見えたら取りやめ）・次の遠征はこのマスから始まる」。

**使う**（`interact`。火の上なら `dir` を省く、隣なら火の方向）:

- HP が休憩の上限（最大 HP × `rest.capPct`%。`restCapHp`）まで戻る（`healed { via: 'fire' }`・`fire_used { player, depth, x, y, by, amount, maxHp, usesAfter }`）。1 手番。
- 使えない（手番を使わない）: HP がもう上限以上・追ってくる敵が見えている（休憩と同じ判定）・**この遠征で、この階の火をもう使った**（`SeasonState.fireUses` の `{ no, depth }`。火がいくつあっても、だれの火でも）。
- 同じマスにその世界の地物があるとき: 火が今使えるなら火を使い、使えないなら、その世界の地物を今までどおり操作する。

**支援賞**（`support`）: 自分の火を、ほかの参加者が使った人数（延べ。S1c で改めた）。数えるのは、(1) 置いた本人でない、(2) その参加者がその火で数えられるのはシーズンを通して 1 回だけ、(3) 「使った」＝その使用で最大 HP の `supportMinHealPct`（10）% 以上が戻った（`fire_used`）か、**その火から帰還・撤退し、それで確定した点が 1 以上**（`fire_return` の `done` と、続く `expedition_ended` の `payout`。S1c・S1d）、のすべてを満たす使用だけ。火から帰った者は、その場でキャンプに着くので、その場で数える。サーバーが、使った者がキャンプに着いたとき（遠征の終わり）か、そのランが終わったときに、そのランの `fire_used` をまとめて数える（S1a。その場では数えない: 置いた者に「今その階にだれかいる」と分からないように）。同着は使った予算の少ないほう。共有層の火は `seasons/<id>/fires.json`（`{ order, depth, x, y, by, profileId, runId, wall, used, uses, users, dup? }`）。参加者ごとの支援の数は、ここの `uses` から作る（S1a）。

観測: 火は `visible.features`（`by`）と覚えている地図に出る。`valid_actions` に `place_fire（置いた本人の得・費用・確定点・残りの数。置けないときは不可と理由）`、火の隣と上で `interact <dir>（野営の火: HP を N まで戻す）`。迷宮では `season.fire_used`（この遠征で火を使った階）と、いま火を置けるマスにいれば `season.support`（支援賞の行と「あなたの火 N/3・あと M つ置ける」。S1c）。キャンプでは `season.fires`（自分の火ごとに、使われた回数。まだ載っていない火も）・`season.fire_news`（S1c。「知らせ: あなたの野営の火（地下4階 (x,y)）を ○○ が使った（支援賞 +1）」。前の取り込みから新しく使った者。遠征を始める取り込みで、キャンプで見せた分を捨てる）と、賞の 4 行（支援賞の行に自分の火の数）。

### 9.11 称号と結果（S2。SEASON.md §18.2・§18.3）

**ゲームの規則は変えない**（観測・出来事の形も変えない。`engineVersion`・`eventVersion` はそのまま）。称号は表示だけで、力は足さない。

- **賞の称号**: シーズンの結果が確定したとき（`finalize`）、4 つの賞ごとに 1 位の参加者（同じ順位の 1 位は全員）に、その賞の称号（「冒険賞（シーズンの名前）」）。**ランを始めた参加者が 2 人に満たないシーズンでは付けない。** 値が 0 の賞・対象外（倒れた者の生還賞）にも付けない。
- **初討伐**（一度きりの偉業。順位の賞にしない）: そのシーズンで、節目の大守護者を倒した後に、**最初にキャンプへ着いた**参加者に、階ごとに称号（「地下5階の初討伐（シーズンの名前）」）。サーバーは、参加者がキャンプに着いたコミット（と、起動し直して復旧したキャンプのラン）で、そのランの `world.milestones.cleared` のうち、まだだれの記録にも無い階を `seasons/<id>/deeds.json`（`{ depth, profileId, name, runId, used, wall, order }`）に残す（`log.jsonl` に `first_warden`）。倒して帰る前に倒れた討伐は数えない。称号は確定のときに付ける（参加者 2 人の決まりも同じ）。
- **名前**: データ `packages/content/data/core/seasonTitles.json`（`{ id, kind: 'award' | 'first_warden', award?, name: { ja, en } }`。`{season}` はシーズンの名前、`{depth}` は階）。コンテンツの版のハッシュには入れない（実績と同じ。表示だけなので、開いているシーズンの版を変えない）。確定のときに名前を作り、結果に残す（後でデータを変えても、付いた称号の名前は変わらない）。
- **残す場所**: 確定した結果 `seasons/<id>/result.json` の `titles`（`SeasonTitle & { profileId, holder }`）。プロフィールのファイルには書かない（運用の道具の `close` とサーバーは別のプロセスで、両方がプロフィールのファイルを書くと上書きし合うため）。プロフィールの称号は、確定したすべてのシーズンの結果から作る（`SeasonService.titlesOf`）。

```ts
SeasonTitle { id, season, seasonName, kind: 'award' | 'first_warden', award?, depth?, name: { ja, en }, at }
```

- **見える所**: 順位の表（`GET /api/seasons/:id` の `standings[].titles`。人間の画面のロビーでは名前の横）・プロフィール（MCP の `profile` の文に「称号: …」と `titles: { name, season, season_name, kind, award?, depth? }[]`。HTTP の `GET /api/profile` も同じ。人間の画面のロビーの「記録と図鑑」）・結果の画面（`result.titles`）・運用の道具（`standings` の名前の横、`close` の出力）。キャンプの観測の賞の行（取り込み）には出さない（取り込みの形を変えない）。
- **結果を見返す**: `GET /api/seasons/:id` の `result`・`standings[].banked`・`section`（§9.8）。人間の画面は `#/season/<id>`。
