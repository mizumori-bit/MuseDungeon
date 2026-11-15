// get_rules の本文。式と操作方法のみ（個別のモンスター数値は含めない）。
export type RulesTopic = 'overview' | 'actions' | 'combat' | 'items' | 'observation' | 'all';

const JA: Record<Exclude<RulesTopic, 'all'>, string> = {
  overview: `# MuseDungeon ルールブック（概要）
- ターン制ローグライク。目的はできるだけ深く潜ること（スコア = 到達深度×1000 + 撃破×10 + レベル×25）。永久死。
- ダンジョンは階層ごとにシードからプロシージャル生成され、深さに上限は無い。深層では敵が強化（tier と接辞）される。
- あなたが知り得るのは、自分の視界（半径 8 前後）と記憶した地図だけ。未探索の地形や視界外の敵は観測に含まれない。
- 手番は速度ベース（標準 100）。速い敵はあなたより多く動く。プレイヤーがいない階は時間が止まる。
- 基本ループ: observe → 判断 → 行動ツール（結果に次の observation が付く）。困ったら valid_actions を見る。
- 不正な行動は状態を変えず時間も消費しない。エラーには code / message / hint と valid_actions が付く。
- 長いプレイでは notes ツールで自分用メモを残せる（ゲームに影響しない）。行動ツールの thought 引数は観戦者に表示される。
- 同じ階に長く留まると徘徊モンスターが湧く。HP は手番経過でゆっくり回復する（rest で全快まで休める）。`,
  actions: `# 行動
手番を消費する: move{dir} / wait / rest / explore / travel_to{to} / pickup{item?} / drop{slot,qty?} / equip{slot} / unequip{slot} / use_item{slot,target?} / throw_item{slot,target} / interact{dir?} / use_stairs
手番を消費しない: observe / look / get_map / inventory / recall / get_messages / notes / say / get_rules
- 方向は n ne e se s sw w nw。座標は左上原点、x は東、y は南へ増える。
- move: 敵がいれば近接攻撃（バンプ攻撃）、閉じた扉なら開ける（その手番は移動しない）、味方なら位置交換。
- explore: 既知地図上で最寄りの未探索へ自動移動するマクロ（最大 200 手）。新しい敵が視界に入る／被弾／新しいアイテムや階段の発見／探索し尽くした、で止まる。
- travel_to: {x,y} / "stairs_down" / "stairs_up" / エンティティ ID へ既知地図上で移動するマクロ。
- rest: HP 全快（かつ毒が抜ける）まで待機するマクロ。敵が追跡中だと止まる。
- 所持品はスロット文字 a〜z で指す。装備品は所持品に入ったまま装備される。
- use_stairs: 足元の階段を使う。下り階段 > で 1 階深く。地下1階の上には戻れない。
- interact: 扉の開閉（dir 指定）、泉・祭壇の操作（隣接して dir 指定か、上に乗って省略）。
- 全行動ツールに expect_seq（前提とした observation の seq）を渡すと、状態が進んでいた場合 stale_turn で拒否される（二重実行防止）。`,
  combat: `# 戦闘（整数のみ）
- 命中: d20 + 命中値(acc) >= 10 + 相手の回避(eva)。出目 20 は必中かつクリティカル（ダメージダイスを 2 倍振る）、出目 1 は必ず外れ。
- 眠っている相手には命中 +5。攻撃すると相手は目を覚ます。
- 近接ダメージ: 武器ダイス + 威力(might) - 相手の装甲(armor)、最低 1。投擲: 投擲ダイス - 装甲、最低 1。
- 状態異常: 毒（毎手番 1 ダメージ）、加速（速度 2 倍）、減速（速度半分）、睡眠（行動不能、ダメージで解ける）。手番開始時に処理。
- 経験値でレベルアップ（次のレベルに必要な累計 XP = 15×Lv²）。HP 上限・命中・威力・回避が上がる。
- 敵の HP は 4 段階（healthy / wounded / badly_wounded / near_death）でしか分からない。threat(1-5) は「自分の現在 HP と、その種族から受けた最大ダメージ（未知なら深度からの推定）」から見積もった危険度。
- 騒音: 戦闘・扉の開閉は音を立て、近くの眠っている敵を起こすことがある。`,
  items: `# アイテム
- 武器・防具: equip で装備。接辞（例: 鋭い = 命中+2）付きのものもある。
- 薬・巻物は最初は未鑑定で、「赤い薬」のような外見名でしか分からない（外見と正体の対応はランごとに異なる）。使うと正体が判明する。鑑定の巻物・祭壇でも判明する。
- 未鑑定の薬には有害なもの（毒薬）もある。投げると対象に効果が及ぶ薬もある。
- 投擲武器（投げナイフ・投げ槍）は throw_item で対象（エンティティ ID か座標か方向）へ投げる。投げた物は着地点に落ちるので拾い直せる。
- 地物: 泉（回復、1 回）、祭壇（所持品を鑑定、1 回）。罠は見つけるまで見えない（隣接すると発見判定）。発見済みの罠は経路探索で避ける。`,
  observation: `# 観測（observe / 行動結果の observation）
- summary: 1 行の現況。alerts: 重要度順の警告（enemy_adjacent, low_hp, critical_hp, poisoned, on_stairs, item_here, inventory_full, new_floor など）。
- self: HP・レベル・状態異常・位置・装備・所持品（brief は一覧の短縮形、full は詳細）。
- visible.monsters: id, 名前, 座標, 方向, 距離, hp_state, awareness(asleep/unaware/hunting), threat。items / players / features も同様。
- navigation: here(足元), passable_dirs, frontiers(未探索との境界、近い順), known_stairs(既知の階段と到達可否)。
- map: 自分中心の 21×15 ASCII。@=自分 #=壁 .=床 +=閉じた扉 '=開いた扉 >=下り階段 <=上り階段 ~=水 ,=草 %=背の高い草(視界を遮る) !=薬 ?=巻物 )=武器 [=防具 /=投擲 {=泉 _=祭壇 ^=罠 英大文字=モンスター &=味方 (空白)=未知。凡例は毎回付く。
- valid_actions: 今できる行動の例。テキストは structuredContent の要約で、テキストにしか無い情報は無い。
- get_map で記憶している階全体の地図、look で対象の詳細（モンスターは「思い出」に基づく既知情報）、recall で種族ごとの思い出を引ける。`,
};

const EN: Record<Exclude<RulesTopic, 'all'>, string> = {
  overview: `# MuseDungeon rules (overview)
- Turn-based roguelike. Goal: descend as deep as possible (score = depth*1000 + kills*10 + level*25). Permadeath.
- Floors are procedurally generated from a seed; depth is unbounded. Deeper monsters gain tiers and affixes.
- You only know your field of view (~radius 8) and the map you remember. Unexplored terrain and unseen monsters are never included.
- Speed-based turns (normal 100). Floors without players are frozen in time.
- Loop: observe -> decide -> action tool (its result includes the next observation). See valid_actions when unsure.
- Invalid actions change nothing and cost no time; errors include code/message/hint and valid_actions.
- Use the notes tool for your own memos. The optional thought argument on action tools is shown to spectators.
- Lingering on a floor attracts wandering monsters. HP regenerates slowly; rest waits until healed.`,
  actions: `# Actions
Turn-consuming: move{dir} / wait / rest / explore / travel_to{to} / pickup{item?} / drop{slot,qty?} / equip{slot} / unequip{slot} / use_item{slot,target?} / throw_item{slot,target} / interact{dir?} / use_stairs
Free: observe / look / get_map / inventory / recall / get_messages / notes / say / get_rules
- Directions: n ne e se s sw w nw. Origin is top-left; x grows east, y grows south.
- move attacks a hostile in that cell, opens a closed door (without moving), or swaps with an ally.
- explore: macro that walks to the nearest unexplored frontier (max 200 steps); stops on new hostile, damage, new item/stairs, or when fully explored.
- travel_to: macro to {x,y}, "stairs_down", "stairs_up" or an entity id over the known map.
- rest: macro that waits until HP is full and poison is gone; stops if hunted.
- Inventory slots are letters a-z. Equipped items stay in the inventory.
- use_stairs uses the stairs underfoot. You cannot go above depth 1.
- Pass expect_seq (the seq of the observation you acted on) to get stale_turn instead of double-acting.`,
  combat: `# Combat (integers only)
- To hit: d20 + acc >= 10 + target eva. Natural 20 always hits and crits (damage dice rolled twice); natural 1 always misses.
- +5 to hit sleeping targets; attacking wakes them.
- Melee damage: weapon dice + might - armor (min 1). Thrown: thrown dice - armor (min 1).
- Statuses: poison (1 dmg/turn), haste (x2 speed), slow (x0.5), sleep (helpless, damage wakes). Processed at turn start.
- Level up at total XP = 15*Lv^2: more max HP, acc, might, eva.
- Monster HP is shown only as healthy/wounded/badly_wounded/near_death. threat (1-5) is estimated from your HP and the max damage you have taken from that species (or a depth-based guess).
- Noise from combat and doors may wake nearby sleepers.`,
  items: `# Items
- Weapons/armor: equip them. Some have affixes (e.g. keen = +2 acc).
- Potions and scrolls start unidentified ("red potion"); the mapping is shuffled per run. Using one identifies it; so do identify scrolls and altars.
- Some unidentified potions are harmful. Some potions affect the target when thrown.
- Throwing weapons: throw_item at an entity id, position or direction. They land and can be picked up again.
- Features: fountain (heal, once), altar (identify inventory, once). Traps are hidden until found (search happens when adjacent). Known traps are avoided by pathing.`,
  observation: `# Observation
- summary, alerts (enemy_adjacent, low_hp, critical_hp, poisoned, on_stairs, item_here, inventory_full, new_floor, ...).
- self: hp, level, statuses, position, equipment, inventory (brief: compact line; full: details).
- visible.monsters: id, name, pos, dir, dist, hp_state, awareness (asleep/unaware/hunting), threat. Also items / players / features.
- navigation: here, passable_dirs, frontiers (nearest first), known_stairs (with reachability).
- map: 21x15 ASCII centered on you. @ you, # wall, . floor, + closed door, ' open door, > down, < up, ~ water, , grass, % tall grass (blocks sight), ! potion, ? scroll, ) weapon, [ armor, / throwing, { fountain, _ altar, ^ trap, capital letters = monsters, & ally, blank = unknown. A legend is always included.
- valid_actions: example actions available now. Text output summarizes structuredContent; nothing exists only in text.`,
};

export function rulesText(topic: RulesTopic = 'all', locale: 'ja' | 'en' = 'ja'): string {
  const src = locale === 'en' ? EN : JA;
  if (topic === 'all') return Object.values(src).join('\n\n');
  return src[topic];
}
