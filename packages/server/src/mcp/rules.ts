// get_rules の本文。式と操作方法のみ（個別のモンスター数値は含めない）。
// 数値は content の balance.json（catalog.rules）から作る（ルールブックと実際の挙動が食い違わないように）。
import type { CatalogRules } from '@muse/shared';

export const RULE_TOPICS = ['overview', 'expedition', 'actions', 'combat', 'items', 'observation', 'all'] as const;
export type RulesTopic = (typeof RULE_TOPICS)[number];
type Topic = Exclude<RulesTopic, 'all'>;

function ja(r: CatalogRules): Record<Topic, string> {
  const s = r.score;
  const x = r.expedition;
  const rg = r.regen;
  const [b1, b2, b3] = r.hpBands;
  return {
    overview: `# MuseDungeon ルールブック（概要）
- ターン制ローグライク。遊びは「遠征」単位で進む。遠征は、目的を達成して階段の上で extract（帰還）・撤退（extract confirm）・死亡・引退（retire）のいずれかで終わる。
- turn.state が your_turn の間は、ゲームがあなたの次の行動を待っている（行動ツールを呼ぶまで世界は止まっている）。
- turn.state が expedition_ended / at_camp / run_ended のときは、これ以上の行動は不要（ここでやめてよい）。
- ラン（1 キャラクター・1 シードの世界）は無限に続き、遠征を重ねるほど深くなる。永久死。
- スコア = 到達深度×${s.perDepth} + 撃破×${s.perKill} + レベル×${s.perLevel} + 達成した遠征の基礎点の合計。記録には達成した遠征の数が残る。
- ダンジョンは階層ごとにシードからプロシージャル生成され、深さに上限は無い。深層では敵が強化（tier と接辞）される。
- あなたが知り得るのは、自分の視界（半径 8 前後）と記憶した地図だけ。未探索の地形や視界外の敵は観測に含まれない。
- 手番は速度ベース（標準 100）。速い敵はあなたより多く動く。プレイヤーがいない階は時間が止まる。
- 不正な行動は状態を変えず時間も消費しない。エラーには code / message / hint と valid_actions が付く。
- 長いプレイでは notes ツールで自分用メモを残せる（ゲームに影響しない）。行動ツールの thought 引数は観戦者に表示される。
- 同じ階に長く留まると徘徊モンスターが湧く（フロア時間 ${r.wander.intervalMin}〜${r.wander.intervalMax} ごと。次に湧く正確な時刻は分からない）。`,
    expedition: `# 遠征
- 目的の種類: reach_depth（目標の階に着く）、slay_guardian（目標の階の守護者を倒す）、retrieve_relic（目標の階の遺物を拾い、持ったまま帰る）、endless（目的なし）。
- 目標の深度は「これまでの最深到達階 + ${x.aheadMin}〜${x.aheadMax}」（最初の遠征は地下${x.firstTargetDepth}階）。守護者・遺物の居場所は教えられない。観測では role: guardian / relic の印が付く。
- 帰還（extract）: 目的を達成したうえで、いずれかの階段（上り・下り）の上にいて、追跡中の敵が見えていないこと。遠征は「達成」で終わる。
- 撤退（extract confirm: true）: 目的が未達成でも同じ条件で extract できる。報酬なしで生還し、遠征は「撤退」で終わる。
- 達成の報酬（基礎点）: reach_depth ${x.points.reach_depth ?? 0}、slay_guardian ${x.points.slay_guardian ?? 0}、retrieve_relic ${x.points.retrieve_relic ?? 0}。目標が「最深到達 + ${x.aheadMin}」より深い 1 階ごとに +${x.pointsPerExtraDepth}。撤退は 0 点。
- 遠征が達成か撤退で終わるとキャンプに戻る。キャンプでは時間が進まず、HP は全快し状態異常は消える。次の遠征の候補 3 つから start_expedition { offer } で選ぶ（前回 extract した階段から再開）。何も選ばずにやめてもよい（resume_run で後から続けられる）。
- 接続が切れても遠征は終わらない（中断）。resume_run で続きから再開できる。
- 観測の expedition に目的・進捗・can_extract（今この場で extract できるか）が毎回付く。`,
    actions: `# 行動
手番を消費する: move{dir} / wait / rest{until_hp?,max_turns?} / explore / travel_to{to} / pickup{item?} / drop{slot,qty?} / equip{slot} / unequip{slot} / use_item{slot,target?} / throw_item{slot,target} / interact{dir?} / use_stairs / extract{confirm?}
キャンプで: start_expedition{offer} / retire
手番を消費しない: observe / wait_for_turn / expedition / look / get_map / inventory / recall / get_messages / notes / say / get_rules
- 方向は n ne e se s sw w nw。座標は左上原点、x は東、y は南へ増える。
- move: 敵がいれば近接攻撃（バンプ攻撃）、閉じた扉なら開ける（その手番は移動しない）、味方なら位置交換。
- explore: 既知地図上で最寄りの未探索へ自動移動するマクロ（最大 ${r.macroStepLimit} 手）。新しい敵が視界に入る／被弾／新しいアイテムや階段の発見／探索し尽くした、で止まる。結果に歩いた手数（distance）と経過時間（time_elapsed）。
- travel_to: {x,y} / "stairs_down" / "stairs_up" / エンティティ ID へ既知地図上で移動するマクロ。既知の階段には path_len（既知地図上の経路長）が付く。
- rest: 全快（かつ毒が抜ける）まで、または until_hp / max_turns まで休むマクロ（最大 ${r.restMaxTurns} 手）。追跡中の敵が見えると止まる。
- observe は待たずに返る。自分の番を待つには wait_for_turn（COOP 用）。
- 所持品はスロット文字 a〜z で指す。装備品は所持品に入ったまま装備される。
- use_stairs: 足元の階段を使う。下り階段 > で 1 階深く。地下1階の上には戻れない（帰還は extract）。
- interact: 扉の開閉（dir 指定）、泉・祭壇の操作（隣接して dir 指定か、上に乗って省略）。
- retire: ランを終える（キャラクターは戻らない）。遠征だけを終えるなら extract。
- 全行動ツールに expect_seq（前提とした observation の seq）を渡すと、状態が進んでいた場合 stale_turn で拒否される（二重実行防止）。`,
    combat: `# 戦闘・回復（整数のみ）
- 命中: d20 + 命中値(acc) >= 10 + 相手の回避(eva)。出目 20 は必中かつクリティカル（ダメージダイスを 2 倍振る）、出目 1 は必ず外れ。
- 眠っている相手には命中 +5。攻撃すると相手は目を覚ます。
- 近接ダメージ: 武器ダイス + 威力(might) - 相手の装甲(armor)、最低 1。投擲: 投擲ダイス - 装甲、最低 1。表示されるダメージは実際に減った HP（とどめの超過分は含まない）。
- 状態異常: 毒（毎手番 1 ダメージ）、加速（速度 2 倍）、減速（速度半分）、睡眠（行動不能、ダメージで解ける）。手番開始時に処理。
- 経験値でレベルアップ（次のレベルに必要な累計 XP = 15×Lv²）。HP 上限・命中・威力・回避が上がる。
- 自然回復: max(${rg.minInterval}, ${rg.baseInterval} - floor(Lv/${rg.levelDiv})) 手番ごとに 1 HP。追跡中の敵が見えない状態での wait（rest の各手を含む）は休息となり ${rg.restMultiplier} 倍の速さで回復する。観測の self.rest_estimate に全快までの手数・時間・その間の徘徊の目安が出る。
- 敵の HP は 4 段階でしか分からない: healthy（${b1}% 以上）/ wounded（${b2}% 以上）/ badly_wounded（${b3}% 以上）/ near_death（それ未満）。
- 敵の HP は個体ごとにダイスで決まり幅がある。接辞・深層強化（tier）で増え、守護者は通常の個体より大幅に頑丈。
- 目の前で倒した個体は最大 HP が分かり、種族ごとの「体力の記録」（recall）に残る。記録がある種族には、見ている間に与えた実ダメージの合計（damage_seen）と 4 段階表示から推定残り HP（hp_left_est）が付く。
- threat(1-5) は「自分の現在 HP と、その種族から受けた最大ダメージ（未知なら深度からの推定）」から見積もった危険度。
- 騒音: 戦闘・扉の開閉は音を立て、近くの眠っている敵を起こすことがある。`,
    items: `# アイテム
- 武器・防具: equip で装備。接辞（例: 鋭い = 命中+2）付きのものもある。
- 薬・巻物は最初は未鑑定で、「赤い薬」のような外見名でしか分からない（外見と正体の対応はランごとに異なる）。使うと正体が判明する。鑑定の巻物・祭壇でも判明する。
- 未鑑定の薬には有害なもの（毒薬）もある。投げると対象に効果が及ぶ薬もある。
- 投擲武器（投げナイフ・投げ槍）は throw_item で対象（エンティティ ID か座標か方向）へ投げる。投げた物は着地点に落ちるので拾い直せる。
- 遺物（retrieve_relic の目的の品）は効果を持たない。持ったまま階段の上で extract すると持ち帰れる。
- 地物: 泉（回復、1 回）、祭壇（所持品を鑑定、1 回）。罠は見つけるまで見えない（隣接すると発見判定）。発見済みの罠は経路探索で避ける。`,
    observation: `# 観測と turn ブロック
- 全応答の turn: state（your_turn / waiting_others / at_camp / expedition_ended / run_ended）、turn_no、reason、awaiting（action / camp_choice / nothing）、changes（前回の応答からの重要な変化）。テキストでは末尾の ▶ 行が同じ内容。
- changes のコード: new_hostile, hostile_gone, hp_dropped, hp_low, status_gained, status_lost, level_up, item_found, stairs_found, floor_changed, objective_progress, objective_complete, can_extract。alerts は「現在の状態」、changes は「前回からの差分」。
- summary: 1 行の現況。alerts: 重要度順の警告（enemy_adjacent, low_hp, critical_hp, poisoned, on_stairs, item_here, inventory_full, new_floor, can_extract, at_camp など）。
- expedition: 遠征の目的・進捗・can_extract・extract_blocked_by・extract_outcome（今 extract したら complete=達成 / withdraw=撤退）。キャンプでは camp に次の遠征の候補。
- 手負いで逃げている敵には fleeing が付く。逃走中の敵は追跡中でも extract と休息を妨げない。
- self: HP・レベル・状態異常・位置・装備・所持品（brief は一覧の短縮形、full は詳細）・turns・rest_estimate（HP が減っているとき）。
- visible.monsters: id, 名前, 座標, 方向, 距離, hp_state, awareness(asleep/unaware/hunting), threat, role, damage_seen, hp_left_est。items / players / features も同様。
- navigation: here(足元), passable_dirs, frontiers(未探索との境界、近い順), known_stairs(既知の階段と到達可否・path_len)。
- map: 自分中心の 21×15 ASCII。@=自分 #=壁 .=床 +=閉じた扉 '=開いた扉 >=下り階段 <=上り階段 ~=水 ,=草 %=背の高い草(視界を遮る) !=薬 ?=巻物 )=武器 [=防具 /=投擲 $=遺物 {=泉 _=祭壇 ^=罠 英大文字=モンスター &=味方 (空白)=未知。凡例は毎回付く。
- valid_actions: 今できる行動の例。テキストは structuredContent の要約で、テキストにしか無い情報は無い。
- get_map で記憶している階全体の地図、look で対象の詳細（モンスターは「思い出」に基づく既知情報）、recall で種族ごとの思い出を引ける。`,
  };
}

function en(r: CatalogRules): Record<Topic, string> {
  const s = r.score;
  const x = r.expedition;
  const rg = r.regen;
  const [b1, b2, b3] = r.hpBands;
  return {
    overview: `# MuseDungeon rules (overview)
- Turn-based roguelike played in expeditions. An expedition ends when you complete its objective and extract on stairs, withdraw (extract with confirm), die, or retire.
- While turn.state is your_turn the game is waiting for your next action (the world is paused until you call an action tool).
- When turn.state is expedition_ended / at_camp / run_ended, no further action is required (it is fine to stop).
- A run (one character, one seeded world) is endless; each expedition goes deeper. Permadeath.
- Score = depth*${s.perDepth} + kills*${s.perKill} + level*${s.perLevel} + base points of completed expeditions. The record keeps how many expeditions you completed.
- Floors are procedurally generated from a seed; depth is unbounded. Deeper monsters gain tiers and affixes.
- You only know your field of view (~radius 8) and the map you remember. Unexplored terrain and unseen monsters are never included.
- Speed-based turns (normal 100). Floors without players are frozen in time.
- Invalid actions change nothing and cost no time; errors include code/message/hint and valid_actions.
- Use the notes tool for your own memos. The optional thought argument on action tools is shown to spectators.
- Lingering on a floor attracts wandering monsters (every ${r.wander.intervalMin}-${r.wander.intervalMax} floor time; the exact next time is hidden).`,
    expedition: `# Expeditions
- Objective types: reach_depth (arrive on the target depth), slay_guardian (slay the guardian there), retrieve_relic (pick up the relic there and carry it out), endless (no objective).
- Target depth = your deepest depth + ${x.aheadMin}-${x.aheadMax} (the first expedition targets depth ${x.firstTargetDepth}). Guardian and relic locations are not revealed; observations mark them with role: guardian / relic.
- Extract (complete): objective done, standing on any stairs (up or down), and no hunting enemy in view. The expedition ends as completed.
- Withdraw (extract confirm: true): same conditions without the objective; you survive with no reward and the expedition ends as withdrawn.
- Base points: reach_depth ${x.points.reach_depth ?? 0}, slay_guardian ${x.points.slay_guardian ?? 0}, retrieve_relic ${x.points.retrieve_relic ?? 0}; +${x.pointsPerExtraDepth} per depth beyond deepest + ${x.aheadMin}. Withdrawal scores 0.
- After completing or withdrawing you are at camp: time does not pass, HP is restored and statuses cleared. Choose the next of 3 offers with start_expedition { offer } (you restart from the stairs you extracted on). You may stop instead and resume_run later.
- A disconnect does not end an expedition; resume_run continues it.
- Every observation includes expedition (objective, progress, can_extract).`,
    actions: `# Actions
Turn-consuming: move{dir} / wait / rest{until_hp?,max_turns?} / explore / travel_to{to} / pickup{item?} / drop{slot,qty?} / equip{slot} / unequip{slot} / use_item{slot,target?} / throw_item{slot,target} / interact{dir?} / use_stairs / extract{confirm?}
At camp: start_expedition{offer} / retire
Free: observe / wait_for_turn / expedition / look / get_map / inventory / recall / get_messages / notes / say / get_rules
- Directions: n ne e se s sw w nw. Origin is top-left; x grows east, y grows south.
- move attacks a hostile in that cell, opens a closed door (without moving), or swaps with an ally.
- explore: macro that walks to the nearest unexplored frontier (max ${r.macroStepLimit} steps); stops on new hostile, damage, new item/stairs, or when fully explored. Results include distance and time_elapsed.
- travel_to: macro to {x,y}, "stairs_down", "stairs_up" or an entity id over the known map. Known stairs carry path_len.
- rest: macro that waits until HP is full and poison is gone, or until until_hp / max_turns (max ${r.restMaxTurns} turns); stops if a hunting enemy is in view.
- observe returns immediately; use wait_for_turn to wait for your turn (COOP).
- Inventory slots are letters a-z. Equipped items stay in the inventory.
- use_stairs uses the stairs underfoot. You cannot go above depth 1 (leave with extract).
- retire ends the run (the character does not come back). To end only the expedition, extract.
- Pass expect_seq (the seq of the observation you acted on) to get stale_turn instead of double-acting.`,
    combat: `# Combat and recovery (integers only)
- To hit: d20 + acc >= 10 + target eva. Natural 20 always hits and crits (damage dice rolled twice); natural 1 always misses.
- +5 to hit sleeping targets; attacking wakes them.
- Melee damage: weapon dice + might - armor (min 1). Thrown: thrown dice - armor (min 1). Reported damage is the HP actually lost (overkill excluded).
- Statuses: poison (1 dmg/turn), haste (x2 speed), slow (x0.5), sleep (helpless, damage wakes). Processed at turn start.
- Level up at total XP = 15*Lv^2: more max HP, acc, might, eva.
- Regeneration: 1 HP every max(${rg.minInterval}, ${rg.baseInterval} - floor(Lv/${rg.levelDiv})) turns. wait with no hunting enemy in view (each rest turn too) counts as resting and regenerates ${rg.restMultiplier}x faster. self.rest_estimate shows turns/time to full and expected wanderers.
- Monster HP is shown in 4 bands: healthy (>= ${b1}%), wounded (>= ${b2}%), badly_wounded (>= ${b3}%), near_death (below).
- Monster HP is rolled per individual; affixes and tiers raise it, and guardians are far sturdier.
- When you see a monster die you learn its max HP; recall keeps an HP record per species. For recorded species, observations include damage_seen and hp_left_est.
- threat (1-5) is estimated from your HP and the max damage you have taken from that species (or a depth-based guess).
- Noise from combat and doors may wake nearby sleepers.`,
    items: `# Items
- Weapons/armor: equip them. Some have affixes (e.g. keen = +2 acc).
- Potions and scrolls start unidentified ("red potion"); the mapping is shuffled per run. Using one identifies it; so do identify scrolls and altars.
- Some unidentified potions are harmful. Some potions affect the target when thrown.
- Throwing weapons: throw_item at an entity id, position or direction. They land and can be picked up again.
- The relic (retrieve_relic) has no effect; extract on stairs while carrying it.
- Features: fountain (heal, once), altar (identify inventory, once). Traps are hidden until found (search happens when adjacent). Known traps are avoided by pathing.`,
    observation: `# Observation and the turn block
- Every response has turn: state (your_turn / waiting_others / at_camp / expedition_ended / run_ended), turn_no, reason, awaiting (action / camp_choice / nothing), changes (important changes since your last response). The final ▶ line of the text says the same.
- change codes: new_hostile, hostile_gone, hp_dropped, hp_low, status_gained, status_lost, level_up, item_found, stairs_found, floor_changed, objective_progress, objective_complete, can_extract. alerts = current state, changes = what changed.
- summary, alerts (enemy_adjacent, low_hp, critical_hp, poisoned, on_stairs, item_here, inventory_full, new_floor, can_extract, at_camp, ...).
- expedition: objective, progress, can_extract, extract_blocked_by, extract_outcome (complete / withdraw if you extract now). At camp, camp lists the next offers.
- Wounded monsters running away carry fleeing; a fleeing monster does not block extract or resting.
- self: hp, level, statuses, position, equipment, inventory (brief: compact line; full: details), turns, rest_estimate (when hurt).
- visible.monsters: id, name, pos, dir, dist, hp_state, awareness (asleep/unaware/hunting), threat, role, damage_seen, hp_left_est. Also items / players / features.
- navigation: here, passable_dirs, frontiers (nearest first), known_stairs (with reachability and path_len).
- map: 21x15 ASCII centered on you. @ you, # wall, . floor, + closed door, ' open door, > down, < up, ~ water, , grass, % tall grass (blocks sight), ! potion, ? scroll, ) weapon, [ armor, / throwing, $ relic, { fountain, _ altar, ^ trap, capital letters = monsters, & ally, blank = unknown. A legend is always included.
- valid_actions: example actions available now. Text output summarizes structuredContent; nothing exists only in text.`,
  };
}

export function rulesText(topic: RulesTopic = 'all', locale: 'ja' | 'en' = 'ja', rules: CatalogRules): string {
  const src = locale === 'en' ? en(rules) : ja(rules);
  if (topic === 'all') return Object.values(src).join('\n\n');
  return src[topic];
}
