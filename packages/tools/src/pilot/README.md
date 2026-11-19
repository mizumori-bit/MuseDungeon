# pilot — 代行 bot の作例

AI のプレイヤーとゲームの間に置く、小さな常駐プログラムです（設計は `docs/IMPROVEMENTS_V4.md` §10）。

- **速いループ（pilot）**: 1 手ずつ速く動かす。探索する、追ってくる雑魚と戦う、階段を下りる、拾う、休む。
- **遅いループ（AI）**: pilot に起こされたときだけ、要約（`state.json`）を読んで方針（`orders.json`）を書き直す。

協力プレイでは、AI の応答の遅れ（1 手に数十秒）が人間の速さと合いません。pilot を間に置くと、AI が考えている間も毎手番すぐに答えられます。ソロでも、AI を呼ぶ回数（費用）を減らせます。

pilot はただのプレイヤーです。人間や AI と同じ命令を、同じ口（MCP）から出します。ゲームの側に pilot だけの口はありません。

**pilot は判断しません。** やるのは「方針の範囲で続ける」か「起こす」かだけです。迷ったら起こします。種族の名前や数値などの規則の知識も持ちません。決めるのに使うのは、観測の `alerts`、マクロの止まった理由、観測の構造化された項目だけです。作例の役目は「形」を示すことで、強さではありません。強くしたいときは、`orders.json` の方針と `queue` で AI に任せるか、このフォルダを手本に書き直してください。

## 起動

サーバー（`MuseDungeon.cmd` か `npm run server`）を立ててから、別の窓で次のどちらかを実行します。PowerShell では `npm.cmd` と書きます（`npm` だと `--` の後のオプションが届きません）。

```powershell
npm.cmd run pilot -- --new-run Pilot
```

```powershell
npm.cmd run pilot -- --token <player_token> --wake-cmd "node my-ai.mjs"
```

| オプション | 意味 |
|---|---|
| `--token <player_token>` | つなぐプレイヤー（`new_run` の応答や、ロビーで出るトークン） |
| `--new-run <名前>` | 新しいランを作って始める（`--class warrior` などで職業、`--mode coop` で協力プレイのラン） |
| `--dir <フォルダ>` | 3 つのファイルの置き場所（既定 `./pilot-data/<run_id>/`。リポジトリの外でもよい） |
| `--wake-cmd "<コマンド>"` | 起こすときに実行するコマンド。標準入力に `summary`、環境変数に `MUSE_PILOT_STATE`（state.json のパス）・`MUSE_PILOT_ORDERS`（orders.json のパス）・`MUSE_PILOT_LEVEL`（`wake` か `notify`）・`MUSE_PILOT_REASON`（理由） |
| `--wake-url <URL>` | 起こすときに POST する先（本文は `{ level, reason, summary, state_path, orders_path, state }`） |
| `--mode solo\|coop` | ソロか協力か（省くとランのモードから） |
| `--server <URL>` | サーバーの番地（既定 `http://127.0.0.1:7777`。別の機械なら Tailscale の番地など） |
| `--max-actions` / `--max-minutes` / `--max-errors` | 安全装置（既定 5000 命令・360 分・エラー 5 回の連続）。達したら `safety` で起こして終える。遠征は終わらせない |

`--wake-cmd` も `--wake-url` も無ければ、起こすのはファイルと画面の表示だけです（人間が `orders.json` を手で書くとき）。

**pilot は、起こした相手の終了を待ちません。** 待つのは `orders.json` の `rev` が変わることだけです。

## 3 つのファイル

### orders.json（AI が書く。pilot は読むだけ）

最初の起動で、無ければ既定値で作ります。

```jsonc
{
  "rev": 3,                        // 書き換えるたびに増やす。pilot は rev が変わったら読み直す
  "mode": "auto",                  // "auto"＝方針どおり / "hold"＝持ち場の動きだけ / "stop"＝pilot を終える
  "queue": [                       // 先にやる 1 回きりの命令。上から 1 つずつ。空になったら方針に戻る
    { "tool": "travel_to", "args": { "x": 22, "y": 4 } }
  ],
  "policy": {
    "wake_hp_pct": 50,             // HP がこの割合を切ったら起こす（pilot の fight の hp_floor にも使う）
    "rest_below_pct": 70,          // 敵がいなくて HP がこの割合を切っていたら休む（10 手番の wait）
    "max_chasers": 2,              // 追ってくる敵がこの数を超えたら起こす
    "fight": true,                 // 役割の無い敵（守護者・強敵・賞金首でない敵）と戦ってよいか
    "approach": "wait",            // pilot の fight にそのまま渡す: "wait"＝隣に来るまで待つ / "advance"＝寄っていく（pilot は自分で切り替えない）
    "collect": true,               // 品を拾ってよいか（遺物は拾わない）
    "descend": true,               // 目的の階へ向けて階段を下りてよいか
    "after_objective": "wake",     // 目的を果たした後: "wake" / "extract"（階段へ戻って帰る）
    "allow_extract": true,         // 危ないとき、階段の上なら帰ってよいか
    "allow_lifeline": false,       // 危ないとき、帰還の綱を使ってよいか
    "notify_every_turns": 100,     // この手番ごとに経過を知らせる（0＝知らせない）
    "hold_max_turns": 40           // 協力プレイで起こして待つ間、この手番ごとにもう一度起こす
  },
  "camp": { "auto_start": null }   // null＝キャンプでは必ず起こす / "safe"・"standard"・"ambitious"＝その枠で自動で出発
}
```

- 書くときは、別の名前で書いてから置き換えてください（書きかけを読ませないため）。壊れた JSON は読まずに、前の方針のまま起こします（理由 `orders_invalid`）。
- 知らない項目は無視します。無い項目・型の違う項目は既定値です。既定値は**手綱の短い側**です（綱を使わない、遠征を選ばない、目的を果たしたら起こす）。
- `queue` には、手番を使うすべての行動を書けます（装備の付け替え、薬・巻物、投擲、地物、特技・加護の選択、`start_expedition` など）。AI が明示した命令だからです。**失敗したら残りを捨てて起こします**（`queue_failed`）。マクロが pilot なら起こす止まり方で止まったとき（`fight` が倒す前に止まった、など）も、残りを捨ててその理由で起こします。
- `rev` を上げると、`queue` は書いた内容で置き換わります（前の残りは捨てます）。
- 起こされた理由に何もしなくてよいときは、`rev` だけ上げてください（「わかった、続けて」）。同じ条件が続く間は、同じことでは起こしません。

### state.json（pilot が書く。AI は読むだけ）

マクロが 1 つ終わるたびと、起こすたびに書き直します。中身は観測の写しと、pilot 自身の状態だけです。`summary` と `wake.detail` は観測の文の該当する行をそのまま使い、pilot が言い換えることはしません。

```jsonc
{
  "run_id": "…", "expedition_no": 23, "turn": 1234, "orders_rev": 3,
  "status": "running",             // "running" / "waiting"（起こして待っている）/ "holding"（協力プレイで持ち場）/ "camp" / "ended"
  "wake": { "reason": "guardian_seen", "level": "wake", "turn": 1230, "detail": "- 守護者ゴブリン [守護者] e_y04fyo (35,18) 東2南4 …" },
  "self": { "level": 26, "hp": 213, "max_hp": 213, "floor": 16, "pos": [22, 4] },
  "objective": { "type": "slay_guardian", "target_depth": 16, "text": "…" },
  "last": { "tool": "explore", "args": {}, "stopped": "hostile_in_view", "turns": 14, "source": "pilot" },
  "summary": "観測の要約の行 / 最後の命令の結果 / 起こした理由の行"
}
```

### log.jsonl（pilot が追記する）

命令 1 つにつき 1 行（時刻・手番・出したのが pilot か queue か・道具・引数・成否・止まった理由・進んだ手番・HP）と、起こした・知らせた記録、`orders.json` を読み直した記録です。あとで振り返るためのものです。

`pilot-data/` は `.gitignore` に入っています。

## pilot が 1 手番にやること

上から順に見て、最初に当てはまったものを 1 つだけやります。

| # | 条件 | すること |
|---|---|---|
| 1 | ランが終わった | 起こして（`ended`）終える |
| 2 | キャンプにいる | `camp.auto_start` の枠で出発。無ければ起こす（`camp`。遠征のレポートの要点つき） |
| 3 | `orders.json` の `rev` が変わった | 読み直す。`mode: "stop"` なら終える |
| 4 | `queue` に命令がある | 先頭を 1 つ実行する |
| 5 | `mode: "hold"`、または協力プレイで起こして待っている | 持ち場の動き（下） |
| 6 | 特技・加護の選択が待っている | 起こす（選ばない） |
| 7 | `lethal_range` か `critical_hp` | 退いてから起こす（`danger`） |
| 8 | HP が `wake_hp_pct` を切った | 起こす（`low_hp`） |
| 9 | この遠征の目的の役割のある敵（守護者・大守護者・名前付きの強敵・賞金首。観測の `objective`）が見えている | 起こす（挑まない）。目的でない役割のある敵は、同じ階にいる間に 1 回だけ知らせて（`notify`）続ける。挑まないのは同じ |
| 10 | この遠征の目的の遺物（`objective`）が見えている | 起こす（拾わない。いっぺんに見えた遺物はまとめて 1 回）。前の遠征の遺物など目的でない遺物は、同じ階にいる間に 1 回だけ知らせて続ける |
| 11 | 追ってくる敵が `max_chasers` を超えた／`fight: false` で追われている | 起こす（`too_many`／`chased`） |
| 12 | 追ってくる敵（追跡中・逃げていない・「動かない」でない）がいる | いちばん近い敵に `fight`（方針の `approach` を渡す）。倒した以外で止まったら起こす |
| 13 | 敵がいなくて HP が `rest_below_pct` を切っている | `wait`（10 手番） |
| 14 | 遠征の目的を果たした | `after_objective` のとおり（起こす／階段へ行って帰る） |
| 15 | 目的の階より浅く、封じられていない下り階段を知っている | 階段へ行って下りる（踏破の目的なら、目的の階の下り階段まで）。封じられた下り階段（`known_stairs[].sealed`。大守護者を倒していない節目の階）へは行かない |
| 16 | 引数なしの `collect` が拾いに行く品がある（観測の `navigation.collectable`） | `collect` |
| 17 | 探索できる所が残っている | `explore`（目的の階より浅くて下り階段を知らなければ、下への風の方角へ） |
| 18 | 何も残っていない | 起こす（`nothing_to_do`。移動が断られて残らなかったなら `refused_<code>`） |

- 移動の道具（`collect`・`explore`・`travel_to`・`use_stairs`）が断られたら、その手番の間は外して表の次の行へ進みます（経路がふさがれている、遠すぎて拾えない、など）。何も残らなかったら、断られた理由で起こします。
- pilot が自分から使う道具は、`explore`・`travel_to`・`collect`・`fight`・`wait`・`use_stairs`・`extract`・（`allow_lifeline` のときだけ）帰還の綱・（`camp.auto_start` のときだけ）`start_expedition`・（持ち場の動きのときだけ）1 手の攻撃と 1 歩の移動だけです。
- 命令の `thought` には `[pilot] explore` のように書きます（観戦している人に、bot が動かしていると分かるように）。

**退く**（`danger` のとき。上から順）: 階段の上で `allow_extract` なら帰る → `allow_lifeline` で綱を持っていれば綱 → 知っている階段まで「着ける」見込み（観測の `escape`）なら階段へ `travel_to`（`mode: flee`）→ どれもできなければ、ソロは止まって待つ。協力プレイは持ち場の動き。

**持ち場の動き**（協力プレイで起こして待っている間・`mode: "hold"`）: 毎手番すぐに、危なければ退く → 起きている敵が隣にいればその敵に 1 回攻撃 → 追ってくる敵と仲間が見えていれば仲間の方へ 1 歩 → それ以外は 1 手番待つ。探索・拾う・階段は使いません。

**ソロでは、起こしたら止まって待ちます**（ソロは手番の制限時間がありません）。協力プレイでは止まれないので、持ち場の動きで答え続けます。

## 起こす理由

`level` は 2 段です。`notify` は知らせるだけで pilot は止まりません（`periodic`: `notify_every_turns` ごとの経過、目的でない遺物・役割のある敵が見えた）。ほかはすべて `wake`（AI の判断が要る）です。

| 理由 | いつ |
|---|---|
| `camp` | キャンプにいる（遠征の選択） |
| `perk_pending` / `boon_pending` | 特技・加護を選べる |
| `danger` | `lethal_range`・`critical_hp`（退いてから起こす） |
| `low_hp` | HP が `wake_hp_pct` を切った |
| `guardian_seen` / `warden_seen` / `elite_seen` | この遠征の目的の守護者・大守護者・名前付きの強敵か賞金首が見えた（追ってきていれば `_hunting` が付く。鍵に相手の ID）。目的でなければ同じ理由の `notify` を 1 回 |
| `relic_seen` | この遠征の目的の遺物が見えた（鍵に遺物の ID）。目的でない遺物は同じ理由の `notify` を 1 回 |
| `too_many` / `chased` | 追ってくる敵が多い／戦わない方針で追われている |
| `fight_<止まり方>` | pilot の `fight` が倒す前に止まった（`fight_hp_risk`・`fight_target_shooting`・`fight_target_moved` など。止まり方の名前はマクロのもの） |
| `<止まり方>` | ほかのマクロが、表を見直すだけでは済まない止まり方で止まった（`blocked`・`no_progress`・`unreachable`・`target_gone`・`trap_ahead` など） |
| `refused_<code>` | 命令が断られた（`refused_hp_floor`: 戦う前に hp_floor を割る見込み、`refused_hostile_adjacent`: 隣に起きている敵がいて動けない、`refused_blocked`: 経路が敵にふさがれている、など。見えている者の行を添える） |
| `objective_done` | 遠征の目的を果たした（`after_objective: "wake"` のとき） |
| `nothing_to_do` | 表に当てはまるものが何も残っていない |
| `queue_failed` | `queue` の命令が失敗した（残りは捨てた） |
| `orders_invalid` | `orders.json` が壊れている（前の方針のまま） |
| `stuck` | 同じことで何度起こしても手番が進まない／同じ命令が同じ止まり方で 4 回止まった |
| `still_waiting` | 協力プレイで、起こしてから `hold_max_turns` 手番が過ぎても返事が無い |
| `unknown_stop` | 知らない止まり方・知らないエラー |
| `safety` | 安全装置に達した（pilot を終える） |
| `ended` | ランが終わった（pilot を終える） |

## orders.json の書き方の例

いずれも、前の `rev` から 1 つ上げて書きます。

**守護者が見えたので挑む**（`state.json` の `wake.detail` に守護者の行と ID がある）:

```json
{ "rev": 8, "mode": "auto",
  "queue": [{ "tool": "fight", "args": { "target": "e_y04fyo", "hp_floor": 0, "abilities": ["bash"] } }],
  "policy": { "after_objective": "extract" } }
```

**帰る**（綱で。階段の上なら `{ "tool": "extract", "args": { "confirm": true } }`）:

```json
{ "rev": 9, "mode": "auto", "queue": [{ "tool": "use_item", "args": { "slot": "lifeline" } }] }
```

**撃ってくる相手に寄って戦う**（`fight_target_shooting` で起こされたとき。`approach: "advance"` の fight は、歩く間に撃たれても止まらない）:

```json
{ "rev": 10, "mode": "auto", "queue": [{ "tool": "fight", "args": { "target": "e_1vc5a5", "approach": "advance" } }] }
```

いつも寄って戦わせるなら、方針に `"approach": "advance"` を書きます。

**いったん任せるのをやめる**（`"hold"` なら持ち場の動きだけ続ける。`"stop"` なら pilot が終わるので、その後は AI が直接ゲームに命令を出せる）:

```json
{ "rev": 11, "mode": "stop" }
```

**キャンプで、いつも「安全」の枠で出発させる**:

```json
{ "rev": 12, "mode": "auto", "camp": { "auto_start": "safe" } }
```

`policy` に書かなかった項目は既定値に戻ります。前の方針を残したいときは、前の `orders.json` を読んで書き換えてください。

## AI への渡し方

pilot を動かしている間、**AI はゲームに直接命令を出しません**（同じプレイヤーへ 2 か所から命令が飛ぶのを防ぐため）。AI がするのは `state.json` を読むことと、`orders.json` を書くことだけです。AI にはたとえば次のように伝えます。

> MuseDungeon を、代行 bot の pilot と一緒に遊んでください。pilot が 1 手ずつ動かし、あなたの判断が要るときだけ起こします。
> まず `packages/tools/src/pilot/README.md` を読んでください。
> 起こされたら `<フォルダ>/state.json` を読み、`wake.reason` と `wake.detail`・`summary` を見て、`<フォルダ>/orders.json` を書き換えてください（`rev` を 1 つ上げる）。何もしなくてよければ `rev` だけ上げてください。
> ゲームの MCP は直接呼ばないでください。細かい 1 手を指定したいときは `queue` に書いてください。

起こす経路の手本は `responder.ts` です。起こされたら `orders.json` を書くだけの簡単な相手で、目的の敵には挑み、危ないときは帰ります（テストと計測に使っています）。`--wake-cmd` の先に置くプログラムを書くときの参考にしてください。

## このフォルダ

| ファイル | 中身 |
|---|---|
| `pilot.ts` | 速いループ（MCP のクライアントとターンフィードの購読は `../drive.ts` のものを使う） |
| `decide.ts` | 1 手番の判断の表・退く・持ち場の動き（観測だけから決める純粋な関数） |
| `orders.ts` | `orders.json` の形・既定値・読み書き |
| `responder.ts` | 自動で返事をする簡単な相手（手本・計測用） |

テストは `packages/tools/test/pilot.test.ts` です。
