# pilot — 代行 bot の作例

AI のプレイヤーとゲームの間に置く、小さな常駐プログラムです（設計は `docs/IMPROVEMENTS_V4.md` §10、§14 で見直し）。

- **速いループ（pilot）**: 1 手ずつ速く動かす。探索する、追ってくる雑魚と戦う、階段を上り下りする、拾う、休む。決着しない戦いを諦める、HP が減ったら立て直す。
- **遅いループ（AI）**: pilot に起こされたときだけ、要約（`state.json`）を読んで方針（`orders.json`）を書き直す。

協力プレイでは、AI の応答の遅れ（1 手に数十秒）が人間の速さと合いません。pilot を間に置くと、AI が考えている間も毎手番すぐに答えられます。ソロでも、AI を呼ぶ回数（費用）を減らせます。

pilot はただのプレイヤーです。人間や AI と同じ命令を、同じ口（MCP）から出します。ゲームの側に pilot だけの口はありません。

**決められることは pilot が決めて知らせ（`notify`）、AI にしか決められないことだけ起こします（`wake`）。** 起こしてから返事が来るまでの約 1 分は、いちばん危ない時間を受け身で過ごすことになるからです。起こして待つ間も、身を守る動きは pilot が自分でやります。

pilot は規則の知識を持ちません（種族の名前や数値を覚え込ませていません）。決めるのに使うのは、観測の構造化された項目（`alerts`・見えている敵・階段など）、マクロの止まった理由、pilot 自身の記録（歩いた跡、同じ相手に何回止まったか）だけです。作例の役目は「形」を示すことで、強さではありません。強くしたいときは、`orders.json` の方針と `queue` で AI に任せるか、このフォルダを手本に書き直してください。

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
| `--wake-cmd "<コマンド>"` | 起こす・知らせるときに実行するコマンド。標準入力に `summary`、環境変数に `MUSE_PILOT_STATE`（state.json のパス）・`MUSE_PILOT_ORDERS`（orders.json のパス）・`MUSE_PILOT_LEVEL`（`wake` か `notify`）・`MUSE_PILOT_REASON`（理由）。`notify` で AI を呼びたくなければ、`MUSE_PILOT_LEVEL` を見て何もせずに終える |
| `--wake-url <URL>` | 起こす・知らせるときに POST する先（本文は `{ level, reason, summary, state_path, orders_path, state }`） |
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
  "mode": "auto",                  // "auto"＝方針どおり / "hold"＝持ち場の動きだけ / "stop"＝その場で終える / "stop_at_camp"＝帰ってから終える
  "queue": [                       // 先にやる 1 回きりの命令。上から 1 つずつ。空になったら方針に戻る
    { "tool": "travel_to", "args": { "to": { "x": 22, "y": 4 } } }
  ],
  "policy": {
    "wake_hp_pct": 50,             // HP がこの割合を切ったら立て直しの段へ（起こさない）。pilot の fight の hp_floor にも使う
    "rest_below_pct": 70,          // 敵がいなくて HP がこの割合を切っていたら休む（立て直しもここまで休む）
    "max_chasers": 2,              // 追ってくる敵がこの数を超えたら知らせる（止まらない）
    "fight": true,                 // 役割の無い敵（守護者・強敵・賞金首でない敵）と戦ってよいか
    "approach": "auto",            // fight の寄り方: "auto"＝最初は待ち、離れて撃ってくる・寄ってこない相手には寄ってやり直す / "wait" / "advance"
    "give_up_after": 2,            // 同じ相手に、決着しないまま止まったのがこの回数になったら、その階にいる間は相手にしない
    "engage_objective": false,     // この遠征の目的の相手・品が見えたら、起こさずに挑む・拾う
    "perk": "wake",                // 特技・加護: "wake"＝起こす / "first"＝起こさずに最初の候補
    "collect": true,               // 品を拾ってよいか（遺物は拾わない）
    "descend": true,               // 目的の階へ向けて階段を上り下りしてよいか
    "after_objective": "extract",  // 目的を果たした後: "extract"（階段へ戻って帰る）/ "wake"（起こす）/ "continue"（そのまま先へ）
    "allow_extract": true,         // 危ないとき・返事が無いとき、階段の上なら帰ってよいか
    "allow_lifeline": false,       // 危ないとき・stop_at_camp のとき、帰還の綱を使ってよいか
    "allow_heal": true,            // 回復の手段（観測の self.recovery）を使ってよいか: 能動技は立て直しの最初に、品は倒されうるのに退く手が無いときだけ
    "retreat_via_stairs": null,    // 立て直しで階を移って休んでよいか（null＝ソロは使う・協力プレイは仲間が見えている間は使わない）
    "queue_on_fail": "discard",    // queue の命令が失敗したとき: "discard"＝残りを捨てる / "skip"＝その命令だけ捨てる
    "ignore": [], "unignore": [],  // 相手にしない敵の ID を足す・外す（rev を上げたときに一度だけ効く）
    "notify_every_turns": 100,     // この手番ごとに経過を知らせる（0＝知らせない）
    "hold_max_turns": 40           // 起こしてからこの手番が過ぎても返事が無ければ、階段へ行って帰る側へ倒す
  },
  "camp": { "auto_start": null }   // null＝キャンプでは必ず起こす / "safe"・"standard"・"ambitious"＝その枠で自動で出発
}
```

- 書くときは、別の名前で書いてから置き換えてください（書きかけを読ませないため）。壊れた JSON は読まずに、前の方針のまま起こします（理由 `orders_invalid`）。
- 知らない項目は無視します。無い項目・型の違う項目は既定値です。綱は使わない・遠征と特技は選ばない・目的の相手では起こす、が既定です。回復の手段は使います（`allow_heal`）。
- `queue` には、手番を使うすべての行動を書けます（装備の付け替え、薬・巻物、投擲、地物、特技・加護の選択、`start_expedition` など）。AI が明示した命令だからです。
  - **`fight` に `hp_floor` を書かなければ、方針の `wake_hp_pct` の値を使います**（ゲームの既定と同じく、最大 HP の半分）。死んでも挑むなら `"hp_floor": 0` と書きます。
  - 敵のせいで断られたとき（隣に起きている敵がいる・追跡中の敵が見えている）は、失敗にしません。その手番は表のとおりに敵へ対応し、次の手番で同じ命令をやり直します（3 回まで。`queue_retry` を知らせる）。
  - 失敗したら（`fight` が倒す前に止まったときも）、`queue_on_fail` のとおりに捨てて知らせます（`queue_failed`）。起こしはしません。
- `rev` を上げると、`queue` は書いた内容で置き換わります（前の残りは捨てます）。
- 起こされた理由に何もしなくてよいときは、`rev` だけ上げてください（「わかった、続けて」）。同じ条件が続く間は、同じことでは起こしません。
- **`"stop"` と `"stop_at_camp"` の違い**: `"stop"` はその場で pilot を終えます（遠征は続いたまま残り、次に起動すると続きから）。`"stop_at_camp"` は階段へ行って帰り（`allow_lifeline` なら綱も使う）、キャンプに着いてから終えます。

### state.json（pilot が書く。AI は読むだけ）

マクロが 1 つ終わるたびと、起こす・知らせるたびに書き直します。中身は観測の写しと、pilot 自身の記録だけです。`summary` と `wake.detail` は観測の文の該当する行をそのまま使い、pilot が言い換えることはしません。起こして返事を待つ間は、`wake` に待っている起こし方が残ります。

```jsonc
{
  "run_id": "…", "expedition_no": 23, "turn": 1234, "orders_rev": 3,
  "status": "running",             // "running" / "waiting"（起こして待っている）/ "holding"（協力プレイで持ち場）/ "camp" / "ended"
  "wake": { "reason": "guardian_seen", "level": "wake", "turn": 1230, "detail": "- 守護者ゴブリン［目的］ [守護者] e_y04fyo (35,18) 東2南4 …" },
  "self": { "level": 26, "hp": 213, "max_hp": 213, "floor": 16, "pos": [22, 4] },
  "objective": { "type": "slay_guardian", "target_depth": 16, "text": "…" },
  "last": { "tool": "explore", "args": {}, "stopped": "hostile_in_view", "turns": 14, "source": "pilot" },
  "hostiles": [{ "id": "e_y04fyo", "name": "守護者ゴブリン", "pos": [35, 18], "dist": 4, "hp_state": "healthy", "hunting": true, "role": "guardian", "objective": true, "ignored": false }],
  "stairs": [{ "type": "up", "pos": { "x": 3, "y": 8 }, "dist": 12, "reachable": true, "path_len": 14 }],   // 観測の known_stairs そのまま（sealed も）
  "target": { "id": "e_1vc5a5", "stops": 1 },   // いま戦っている相手と、決着しないまま止まった回数
  "ignored": ["e_1vc5a5"],          // 相手にしないと決めた敵
  "recovering": false,              // 立て直しの段の途中か
  "camp": { "next_no": 24, "offers": [{ "index": 1, "slot": "safe", "type": "reach_depth", "target_depth": 16, "points": 500, "recommended_level": 25, "text": "…" }] },   // キャンプにいる間だけ
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
| 2 | キャンプにいる | `camp.auto_start` の枠で出発。無ければ起こす（`camp`。遠征のレポートの要点と候補の文つき）。`stop_at_camp` なら終える |
| 3 | `orders.json` の `rev` が変わった | 読み直す。`mode: "stop"` なら終える |
| 4 | `queue` に命令がある | 先頭を 1 つ実行する |
| 5 | 起こして返事を待っている・`mode: "hold"` | 持ち場の動き（下） |
| 6 | 特技・加護の選択が待っている | 起こす。`perk: "first"` なら最初の候補を選ぶ |
| 7 | `lethal_range` か `critical_hp` | 退いて知らせる（`danger`）。退く手が無ければ回復の手段（能動技を先に、品は最後の手）を使って知らせ（`healed`）、品を使ったら起こす（`danger`）。それも無ければ起こす |
| 8 | HP が `wake_hp_pct` を切った・fight が HP の下限で止まった・断られた・`steady` が被害で止まった | 立て直しの段（下）。知らせる（`recovering`） |
| 9 | 役割のある敵（守護者・大守護者・名前付きの強敵・賞金首）が見えている | この遠征の目的の相手（観測の `objective`）なら起こす。`engage_objective` なら起こさずに挑む。目的でなければ同じ階で 1 回知らせて続ける（挑まない） |
| 10 | 遺物が見えている | 目的の遺物なら起こす。`engage_objective` なら拾いに行く。目的でない遺物は同じ階で 1 回知らせる |
| 11 | 追ってくる敵が `max_chasers` を超えた／`fight: false` で追われている | 同じ階で 1 回知らせて（`too_many`／`chased`）続ける |
| — | 相手にしない敵が、起きていて隣にいる | 1 回殴る |
| 12 | 追ってくる敵（追跡中・逃げていない・「動かない」でない。相手にしない敵を除く）がいる | いちばん近い敵に `fight`（寄り方は `approach`）。倒す前に止まったら知らせて続ける（下の「決着しない戦い」） |
| 13 | 敵がいなくて HP が `rest_below_pct` を切っている | 休む（`rest`） |
| 14 | 目的を果たした（`after_objective: "extract"`）・`stop_at_camp` | 階段へ行って帰る（階段を知らなければ探して探索する）。`"wake"` なら起こす、`"continue"` なら先へ |
| 15 | 目的の階より深い所にいる／浅い所にいる | 上り階段で上がる／封じられていない下り階段で下りる（踏破の目的なら、目的の階の下り階段まで） |
| 16 | 引数なしの `collect` が拾いに行く品がある（観測の `navigation.collectable`） | `collect` |
| 17 | 探索できる所が残っている | `explore`（目的の階より浅くて下り階段を知らなければ、下への風の方角へ） |
| 18 | 何も残っていない | 起こす（`nothing_to_do`。命令が断られて残らなかったなら `refused_<code>`） |

- 相手にしない敵が見えている間は、`explore`・`travel_to`・`collect` を被害を受けても止まらない進み方（`mode: steady`）で使います。1 回の呼び出しの被害が最大 HP の 4 分の 1 を超えると止まり、立て直しの段へ移ります。
- 移動・休む・殴るが断られたら、その手番の間は外して表の次の行へ進みます（経路がふさがれている、遠すぎて拾えない、など）。何も残らなかったら、断られた理由で起こします。
- pilot が自分から使う道具は、`explore`・`travel_to`・`collect`・`fight`・`rest`・`wait`・`use_stairs`・`extract`・1 手の攻撃（`attack`）・（`allow_heal` のときだけ）回復の手段（観測の `self.recovery` にある能動技と品だけ）・（`allow_lifeline` のときだけ）帰還の綱・（`camp.auto_start` のときだけ）`start_expedition`・（`perk: "first"` のときだけ）特技・加護の選択だけです。装備の付け替え、回復でない薬や巻物を使う、未鑑定の品を使う、品を投げる、祭壇やレバーなどの地物を使うことはしません（AI が `queue` に書いたときだけ）。
- 命令の `thought` には `[pilot] explore` のように書きます（観戦している人に、bot が動かしていると分かるように）。

**決着しない戦い**: 相手ごとに、決着しないまま止まった回数を数えます（相手が離れる・撃ってくる・寄ってこない・見えなくなる・届かない。HP の止まり方は立て直しへ回し、新しい敵・予備動作・状態異常での止まり方は数えません。階を移るか、相手を倒したら 0 に戻す）。

1. `approach: "auto"` なら、離れて撃ってくる・寄ってこない相手には、次は寄って（`advance`）やり直します。
2. 同じ相手に `give_up_after` 回止まったら、その階にいる間はその相手を**相手にしません**（`gave_up` を知らせる）。数の多さにも入れず、自分からは挑みません。隣で起きていれば殴ります。この遠征の目的の相手は自分では諦めず、起こします（`gave_up`）。
3. 階の探索も撃破も進まない命令が 8 回続いたら、行き詰まりとして起こします（`stuck`）。

**立て直しの段**（起こさずに `recovering` を知らせる。上から順に、できる最初のもの）:

0. HP が `wake_hp_pct` を切っていて、回復の能動技（観測の `self.recovery` の `kind: "ability"`）が使える → 使う（使っても減らない。`healed` を知らせる）。
1. 追ってくる敵が見えていない → 休む（`rest_below_pct` まで）。
2. 追ってくる敵がいて、知っている階段へ「着ける」（観測の `escape`）→ 階段へ行き、**階を移って**休む。休んだら戻る（モンスターは階を移らない）。同じ階で 2 回まで。`retreat_via_stairs` が使えるときだけ。
3. 追ってくる役割の無い敵が隣にいて、階段にも仲間にも行けない → 殴る（離れても付いてくるので。守護者などとは HP が減ったまま殴り合わない）。
4. 協力プレイで仲間が見えている → 仲間の隣へ寄る。そうでなければ → 来た道を戻る（自分が歩いた跡の、6 マス以上離れた所へ）。
5. どれもできない → 退く（下）。それもできなければ起こす（`danger`）。

逃げる・寄るときは `mode: flee` で進みます。HP の下限は、見えている追跡中の敵の 1 手番の最悪の被害（観測の `worst_turn`）の合計の 2 倍です（何体にも撃たれながら逃げて、1 回の呼び出しの中で倒れないように）。

**退く**（`danger` のとき。上から順）: 階段の上で `allow_extract` なら帰る → `allow_lifeline` で綱を持っていれば綱 → 階段の上なら階を移る → 知っている階段まで「着ける」見込みなら階段へ → どれもできなければ、回復の手段（`allow_heal`。能動技を先に。品は使った後に起こす）→ それも無ければ起こす。

**回復の手段**（V4-1c）: 使うのは、観測の `self.recovery` にあるものだけです（使うと HP が回復する能動技と、正体の分かっている品。未鑑定の品は入らないので触れません）。品は使うと減るので、倒されうるのに退く手が無いときだけ使います。

**起こして待つ間の持ち場の動き**（ソロでも協力プレイでも。`mode: "hold"` も同じ。毎手番すぐに、上から順）:

1. `lethal_range`・`critical_hp` → 退く。退く手が無ければ回復の手段（能動技を先に、品は最後の手）。
2. 追ってきている敵が隣にいる → 1 回殴る（気づいていない敵には、自分からは挑まない）。
3. この数手番に、隣でない相手から被害を受けた・追ってくる敵が見えている → 仲間の隣へ寄る。仲間がいなければ来た道を戻る（同じ場所に立って撃たれ続けない）。
4. それ以外 → 協力プレイは 1 手番待つ。ソロは何もせずに返事を待つ（ソロは手番の制限時間がありません）。

起こしてから `hold_max_turns` 手番が過ぎても返事が無ければ、`no_reply` を 1 回知らせ、知っている階段へ行きます。`allow_extract` なら帰り、帰れなければ階段の上で待ちます。くり返し起こすことはしません。

起こしてから、隣でない相手から受けた被害の合計が最大 HP の 4 分の 1 を超えたとき（撃たれ続けている。ゲームの `steady` が止まる線と同じ）も、`hold_max_turns` を待たずに同じく帰る側へ倒します（`under_fire` を知らせる）。

## 起こす理由・知らせる理由

`level` は 2 段です。`notify` は知らせるだけで、pilot は止まりません。`wake` は AI の判断が要るときだけです。

**起こす（`wake`）**

| 理由 | いつ |
|---|---|
| `camp` | キャンプにいる（遠征の選択。`detail` に候補の文、`state.json` の `camp.offers` に候補） |
| `guardian_seen` / `warden_seen` / `elite_seen` | この遠征の目的の守護者・大守護者・名前付きの強敵か賞金首が見えた（追ってきていれば `_hunting` が付く。鍵に相手の ID） |
| `relic_seen` | この遠征の目的の遺物が見えた（鍵に遺物の ID） |
| `perk_pending` / `boon_pending` | 特技・加護を選べる（`perk: "wake"` のとき） |
| `danger` | 危ないのに、退く手も立て直す手も無い |
| `gave_up` | この遠征の目的の相手と、決着しないまま（または HP の下限で）`give_up_after` 回止まった |
| `objective_done` | 遠征の目的を果たした（`after_objective: "wake"` のとき） |
| `nothing_to_do` | 表に当てはまるものが何も残っていない（探索し終えたのに目的の相手が見つからない、など） |
| `refused_<code>` | 命令が断られて、表に残るものが無い（`refused_hostile_adjacent`: 隣の起きている敵がじゃまで動けない、`refused_blocked`: 経路が敵にふさがれている、など）。じゃまをしている敵（エラーの `details.blocked_by`）の観測の行を `detail` の先頭に、ほかの見えている者の行を後ろに添える。pilot はその敵に自分からは挑まない |
| `stuck` | 行き詰まり（同じことで何度起こしても手番が進まない、同じ命令が同じ止まり方で 4 回止まった、探索も撃破も進まない命令が 8 回続いた） |
| `unknown_stop` | 知らない止まり方 |
| `orders_invalid` | `orders.json` が壊れている（前の方針のまま） |
| `safety` / `ended` | 安全装置に達した／ランが終わった（pilot を終える） |

**知らせる（`notify`）**: `healed`（回復の手段を使った。品なら残りの数）・`fight_<止まり方>`（倒す前に止まった）・`refused_<code>`（fight・殴るなどが断られた）・`gave_up`（目的でない相手を諦めた）・`recovering`（立て直しの段に入った）・`danger`（退いた）・`too_many`・`chased`・`queue_retry`・`queue_failed`・`no_reply`・`under_fire`（返事を待つ間に撃たれ続けたので、帰る側へ倒した）・目的でない役割のある敵と遺物（`guardian_seen` など）・`blocked`・`no_progress` などの移動の止まり方・`periodic`（`notify_every_turns` ごとの経過）。

## 起こされたときの返事の例

いずれも、前の `rev` から 1 つ上げて書きます。`policy` に書かなかった項目は既定値に戻るので、前の方針を残したいときは、前の `orders.json` を読んで書き換えてください。

**キャンプ（`camp`）**: `state.json` の `camp.offers` から選んで出発する（`index` を `offer` に書く）。いつも同じ枠でよければ `camp.auto_start` を書く。

```json
{ "rev": 8, "mode": "auto", "queue": [{ "tool": "start_expedition", "args": { "offer": 2 } }] }
```

**目的の相手が見えた（`guardian_seen` など）**: 挑む。`hp_floor` を書かなければ方針の `wake_hp_pct` で止まる。以後も見つけたら起こさずに挑ませるなら `engage_objective`。

```json
{ "rev": 9, "mode": "auto",
  "queue": [{ "tool": "fight", "args": { "target": "e_y04fyo", "hp_floor": 20, "abilities": ["bash"] } }],
  "policy": { "engage_objective": true } }
```

**特技（`perk_pending`）**: 選ぶ。以後は任せるなら `"perk": "first"`。

```json
{ "rev": 10, "mode": "auto", "queue": [{ "tool": "choose_perk", "args": { "option": 2 } }] }
```

**危ない（`danger`）・行き詰まり（`stuck`）・やることが無い（`nothing_to_do`）・目的の相手を諦めた（`gave_up`）**: 帰る（綱で。階段の上なら `{ "tool": "extract", "args": { "confirm": true } }`）。あるいは薬を飲む・別の手を `queue` に書く。

```json
{ "rev": 11, "mode": "auto", "queue": [{ "tool": "use_item", "args": { "slot": "lifeline" } }] }
```

**じゃまをされて動けない（`refused_blocked` など）**: `detail` の先頭の行の敵と戦う。相手にせずに続けるなら `ignore`。

```json
{ "rev": 12, "mode": "auto", "queue": [{ "tool": "fight", "args": { "target": "e_1vc5a5", "until": "clear" } }] }
```

**任せるのをやめる**: `"stop_at_camp"` は帰ってから終える。`"stop"` はその場で終える（その後は AI が直接ゲームに命令を出せる）。`"hold"` は持ち場の動きだけ続ける。

```json
{ "rev": 13, "mode": "stop_at_camp", "policy": { "allow_lifeline": true } }
```

## AI への渡し方

pilot を動かしている間、**AI はゲームに直接命令を出しません**（同じプレイヤーへ 2 か所から命令が飛ぶのを防ぐため）。AI がするのは `state.json` を読むことと、`orders.json` を書くことだけです。AI にはたとえば次のように伝えます。

> MuseDungeon を、代行 bot の pilot と一緒に遊んでください。pilot が 1 手ずつ動かし、決められることは自分で決めて知らせ（notify）、あなたにしか決められないことだけ起こします（wake）。
> まず `packages/tools/src/pilot/README.md` を読んでください。
> 起こされたら `<フォルダ>/state.json` を読み、`wake.reason` と `wake.detail`・`summary`・`hostiles`・`stairs` を見て、`<フォルダ>/orders.json` を書き換えてください（`rev` を 1 つ上げる）。何もしなくてよければ `rev` だけ上げてください。知らせ（notify）には返事は要りません。
> ゲームの MCP は直接呼ばないでください。細かい 1 手を指定したいときは `queue` に書いてください。

起こす経路の手本は `responder.ts` です。起こされたら `orders.json` を書くだけの薄い相手です（テストと計測に使っています）。`--wake-cmd` の先に置くプログラムを書くときの参考にしてください。

## このフォルダ

| ファイル | 中身 |
|---|---|
| `pilot.ts` | 速いループと pilot 自身の記録（MCP のクライアントとターンフィードの購読は `../drive.ts` のものを使う） |
| `decide.ts` | 1 手番の判断の表・立て直し・退く・持ち場の動き（観測と pilot の記録だけから決める純粋な関数） |
| `orders.ts` | `orders.json` の形・既定値・読み書き |
| `responder.ts` | 自動で返事をする薄い相手（手本・計測用） |

テストは `packages/tools/test/pilot.test.ts` です。
