// get_rules の本文。式と操作方法のみ（個別のモンスター数値は含めない）。
// 数値は content の balance.json（catalog.rules）から作る（ルールブックと実際の挙動が食い違わないように）。
import type { Catalog, CatalogRules } from '@muse/shared';

export const RULE_TOPICS = ['overview', 'expedition', 'actions', 'combat', 'items', 'classes', 'observation', 'all'] as const;
export type RulesTopic = (typeof RULE_TOPICS)[number];
type Topic = Exclude<RulesTopic, 'all' | 'classes'>;

/** 職業の一覧（公開カタログから生成） */
function classesText(c: Catalog, locale: 'ja' | 'en'): string {
  const ja = locale !== 'en';
  const nm = (n: { ja: string; en: string }) => (ja ? n.ja : n.en);
  const lines = [ja ? '# 職業（new_run の class）' : '# Classes (new_run class)'];
  for (const [id, k] of Object.entries(c.classes)) {
    const b = k.base;
    const items = k.startItems.map((s) => `${nm(c.items[s.item]?.name ?? { ja: s.item, en: s.item })}${s.qty > 1 ? ` x${s.qty}` : ''}${s.equip ? (ja ? '(装備)' : ' (equipped)') : ''}`).join(', ');
    const g = k.growth;
    lines.push(ja
      ? `- ${id.split(':')[1]}（${k.name.ja}）: ${k.desc.ja}\n  初期値: HP ${b.maxHp} 命中+${b.acc} 回避${b.eva} 威力${b.might} 装甲${b.armor} 視界${b.sight} 速さ${b.speed} 所持枠${b.capacity}\n  初期装備: ${items}\n  成長: レベルごとに HP +${g.maxHpPerLevel}${g.accEvery ? `、${g.accEvery} レベルごとに命中 +1` : ''}${g.mightEvery ? `、${g.mightEvery} レベルごとに威力 +1` : ''}${g.evaEvery ? `、${g.evaEvery} レベルごとに回避 +1` : ''}`
      : `- ${id.split(':')[1]} (${k.name.en}): ${k.desc.en}\n  base: HP ${b.maxHp} acc+${b.acc} eva ${b.eva} might ${b.might} armor ${b.armor} sight ${b.sight} speed ${b.speed} capacity ${b.capacity}\n  start: ${items}\n  growth: HP +${g.maxHpPerLevel}/level${g.accEvery ? `, acc +1 every ${g.accEvery}` : ''}${g.mightEvery ? `, might +1 every ${g.mightEvery}` : ''}${g.evaEvery ? `, eva +1 every ${g.evaEvery}` : ''}`);
  }
  return lines.join('\n');
}

/** 条件の一覧（公開） */
function traitsLines(r: CatalogRules, ja: boolean): string {
  return Object.entries(r.traits).map(([id, k]) => ja
    ? `  - ${id}（${k.name.ja}）: ${k.desc.ja}。倍率 ×${(k.multiplierPct / 100).toFixed(2)}、危険度 ${k.danger >= 0 ? '+' : ''}${k.danger}`
    : `  - ${id} (${k.name.en}): ${k.desc.en}. multiplier x${(k.multiplierPct / 100).toFixed(2)}, danger ${k.danger >= 0 ? '+' : ''}${k.danger}`).join('\n');
}

function ja(r: CatalogRules): Record<Topic, string> {
  const x = r.expedition;
  const h = r.haul;
  const sl = r.slots;
  const rg = r.regen;
  const [b1, b2, b3] = r.hpBands;
  return {
    overview: `# MuseDungeon ルールブック（概要）
- ターン制ローグライク。遊びは「遠征」単位で進む。遠征は、目的を達成して階段の上で extract（帰還）・撤退（extract confirm）・死亡・引退（retire）のいずれかで終わる。
- turn.state が your_turn の間は、ゲームがあなたの次の行動を待っている（行動ツールを呼ぶまで世界は止まっている）。
- turn.state が expedition_ended / at_camp / run_ended のときは、これ以上の行動は不要（ここでやめてよい）。
- ラン（1 キャラクター・1 シードの世界）は無限に続き、遠征を重ねるほど深くなる。永久死。
- スコア（版 2）= 確定点の合計。遠征中に得た点は「未確定の戦利品」として積み上がり、持ち帰って（extract）初めて確定する。死ねばその遠征の戦利品は失う（詳しくは get_rules expedition）。記録には達成した遠征の数が残る。
- ダンジョンは階層ごとにシードからプロシージャル生成され、深さに上限は無い。深層では敵が強化（tier と接辞）される。
- あなたが知り得るのは、自分の視界（半径 8 前後）と記憶した地図だけ。未探索の地形や視界外の敵は観測に含まれない。
- 手番は速度ベース（標準 100）。速い敵はあなたより多く動く。プレイヤーがいない階は時間が止まる。
- 不正な行動は状態を変えず時間も消費しない。エラーには code / message / hint と valid_actions が付く。
- 長いプレイでは notes ツールで自分用メモを残せる（ゲームに影響しない）。行動ツールの thought 引数は観戦者に表示される。
- 同じ階に長く留まると徘徊モンスターが湧く（フロア時間 ${r.wander.intervalMin}〜${r.wander.intervalMax} ごと。次に湧く正確な時刻は分からない）。
- 階の種類によっては敵がいない（聖域: 深い所に一定の間隔で現れる、敵も徘徊も出ない休息の階）。
- new_run の objective で最初の遠征の目的を選べる（reach_depth = 堅実の枠 / slay_guardian = 標準の枠 / retrieve_relic = 野心の枠 / endless。既定 auto は reach_depth）。2 回目以降はキャンプの候補 3 つから選ぶ。`,
    expedition: `# 遠征
- 目的の種類: reach_depth（目標の階に着く）、slay_guardian（目標の階の守護者を倒す）、retrieve_relic（目標の階の遺物を拾い、持ったまま帰る）、endless（目的なし）。
- 守護者・遺物の居場所は教えられない。観測では role: guardian / relic の印が付く。
- 帰還（extract）: 目的を達成したうえで、いずれかの階段（上り・下り）の上にいて、追跡中の敵が見えていないこと。遠征は「達成」で終わる。
- 撤退（extract confirm: true）: 目的が未達成でも同じ条件で extract できる。生還し、遠征は「撤退」で終わる。
## 戦利品と確定点（スコア版 2）
- ランのスコア = 確定点の合計。遠征中に得た点はすべて未確定の「戦利品」で、extract で確定する:
  - 帰還（目的を達成して extract）: 戦利品 × 条件の倍率
  - 撤退（extract confirm）: (戦利品 − 目的の基礎点) × ${h.withdrawPct}%
  - 死亡・引退: 0（失った戦利品として記録に残る）
- 戦利品の内訳:
  - 目的: 達成した時点で基礎点（reach_depth ${x.points.reach_depth ?? 0}、slay_guardian ${x.points.slay_guardian ?? 0}、retrieve_relic ${x.points.retrieve_relic ?? 0}。目標が「最深到達 + ${x.aheadMin}」より深い 1 階ごとに +${x.pointsPerExtraDepth}。そこに枠の割合が掛かる）
  - 深追い: この遠征で目標より深い階に初めて着くたび。1 階目 +${h.overreachFirst}、以後 ${h.overreachStep} ずつ増える（+${h.overreachFirst}、+${h.overreachFirst + h.overreachStep}、+${h.overreachFirst + h.overreachStep * 2}…）
  - 宝: 分類 treasure の所持品の価値の合計（落とせば減る。帰還・撤退で換金され所持品から消える）
  - 賞金: 守護者を倒すと（${h.guardianBounty.base} + 深度×${h.guardianBounty.perDepth}）。観測の bounty に出る。守護者は宝を必ず落とす
  - 発見: このランで初めて、ある種族を倒す +${h.discovery.species}／あるアイテム種を鑑定する +${h.discovery.identify}
  - 撃破: 1 体 +${h.perKill}
- 観測の expedition.haul に、内訳（parts）・合計・倍率・今 extract した場合の確定点（if_extract_now）・次に深追いの点が入る階（next_overreach）が毎回出る。self.score に確定済みの点。
- COOP では戦利品（宝を除く）はパーティで共有し、extract した各自に払い戻される。宝は持っている本人の分。
## 目的を達成した後の圧力
- slay_guardian と retrieve_relic は、達成した瞬間からその遠征の間、徘徊の湧き間隔が ${r.afterObjectiveWanderPct}% になる（changes に「坑が騒がしくなった」と出る）。reach_depth には付かない。
- 遺物を拾うと、その階の眠っている・気づいていない敵が目を覚まし、遺物の場所へ向かう。
## 遠征の候補（キャンプ）
- 候補は 3 枠。目標の深度は「生成済みの最深階 + 幅」（最初の遠征は地下${x.firstTargetDepth}階から）:
  - 堅実: +${sl.safe.aheadMin}〜${sl.safe.aheadMax} 階、条件 ${sl.safe.traitsMin}〜${sl.safe.traitsMax} 個、基礎点 ×${sl.safe.pointsPct}%
  - 標準: +${sl.standard.aheadMin}〜${sl.standard.aheadMax} 階、条件 ${sl.standard.traitsMin}〜${sl.standard.traitsMax} 個、基礎点 ×${sl.standard.pointsPct}%
  - 野心: +${sl.ambitious.aheadMin}〜${sl.ambitious.aheadMax} 階、条件 ${sl.ambitious.traitsMin}〜${sl.ambitious.traitsMax} 個、基礎点 ×${sl.ambitious.pointsPct}%
- 条件は、その遠征で目標階までの全階に効く公開の修飾。倍率は帰還時の戦利品に掛かる（複数なら掛け合わせ）:
${traitsLines(r, true)}
- 危険度 = clamp(3 + 推奨レベル(目標深度) − 自分のレベル + 条件の危険度の合計, 1, 5)。推奨レベル(深度) = 1 + floor(深度×${r.recommendedLevel.mul}/${r.recommendedLevel.div})。隠し情報は使わない。
## その他
- 遠征が達成か撤退で終わるとキャンプに戻る。キャンプでは時間が進まず、HP は全快し状態異常は消える。次の遠征の候補 3 つから start_expedition { offer } で選ぶ（前回 extract した階段から再開）。何も選ばずにやめてもよい（resume_run で後から続けられる）。
- 接続が切れても遠征は終わらない（中断）。resume_run で続きから再開できる。
- 観測の expedition に目的・進捗・can_extract（今この場で extract できるか）が毎回付く。`,
    actions: `# 行動
手番を消費する: move{dir} / wait / rest{until_hp?,max_turns?} / explore / travel_to{to} / collect / pickup{item?} / drop{slot,qty?} / equip{slot} / unequip{slot} / use_item{slot,target?} / throw_item{slot,target} / interact{dir?} / use_stairs / extract{confirm?}
キャンプで: start_expedition{offer} / retire
手番を消費しない: observe / wait_for_turn / expedition / look / get_map / inventory / recall / get_messages / notes / say / set_options / get_rules
- 方向は n ne e se s sw w nw。座標は左上原点、x は東、y は南へ増える。
- move: 敵がいれば近接攻撃（バンプ攻撃）、閉じた扉なら開ける（その手番は移動しない）、味方なら位置交換。
- explore: 既知地図上で最寄りの未探索へ自動移動するマクロ（最大 ${r.macroStepLimit} 手）。新しい敵が視界に入る／被弾／新しいアイテムや階段の発見／探索し尽くした、で止まる。結果に歩いた手数（distance）と経過時間（time_elapsed）。
- travel_to: {x,y} / "stairs_down" / "stairs_up" / エンティティ ID へ既知地図上で移動するマクロ。既知の階段には path_len（既知地図上の経路長）が付く。
- explore / travel_to / collect が止まるのは: このランで初めて見る敵（個体）が視界に入った／既知の敵が追跡中（逃走中でない）で視界に入った／見えている敵が追跡に変わった／攻撃を受けた（外れも含む）／ダメージを受けた／隣に起きている敵（逃走中を除く）がいる（hostile_adjacent。マクロは動かないので、離れるなら move）／次のマスに敵がいる（blocked。マクロは攻撃しない）。逃走中の敵の出入りでは止まらない。
- rest: 全快（かつ毒が抜ける）まで、または until_hp / max_turns まで休むマクロ（最大 ${r.restMaxTurns} 手）。敵が視界に入ると（状態によらず）止まる。追跡中の敵が見えている間は休めない。
- throw_item: 対象（ID）までの投擲の経路が通っていないとき（visible.monsters の shot が blocked）は no_line_of_sight で拒否される（手番は消費しない）。座標を狙えば遮られた位置に落ちる。結果は必ず「命中／外れ／壁や他の者に遮られた／届かなかった」と落下地点で示される。
- 自分が投げた物は、そのマスに入るだけで拾う（追加の手番なし。所持品がいっぱいなら拾わない）。collect は既知の自分が投げた物を近い順に回って拾うマクロ。
- set_options: 応答テキストの出し方。map（auto: 階が変わった・新しいセルを知った・敵の出入りがあった応答だけ地図を付ける）、inventory（on_change: 所持品の行は変わったときだけ）、status_line（short: 状態が変わらない間の ▶ 行を短く）。ゲームには影響しない。
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
- 目の前で倒した個体は最大 HP が分かり、種族ごとの「体力の記録」（recall）に残る。記録がある種族には、見ている間に与えた実ダメージの合計（damage_seen）と 4 段階表示から推定残り HP（hp_left_est）が付く。記録が ${r.estimateMinSamples} 体未満の間は下限だけ（「3 以上（記録 1 体）」）。
- 姿の見えない相手から攻撃されたときは、来た方向だけが分かる（「南東から飛んできた何かの射撃」）。
- threat(1-5) は「自分の現在 HP と、その種族から受けた最大ダメージ（未知なら深度からの推定）」から見積もった危険度。
- 騒音: 戦闘・扉の開閉は音を立て、近くの眠っている敵を起こすことがある。`,
    items: `# アイテム
- 武器・防具: equip で装備。接辞（例: 鋭い = 命中+2）付きのものもある。
- 宝（treasure）: 使い道は無く、価値（value）だけを持つ。見えた時点で価値が分かる（「銀の杯（価値 180）」）。所持している間は戦利品に入り、帰還・撤退で換金される。所持枠を 1 つ使う。
- 薬・巻物は最初は未鑑定で、「赤い薬」のような外見名でしか分からない（外見と正体の対応はランごとに異なる）。使うと正体が判明する。鑑定の巻物・祭壇でも判明する。
- 未鑑定の薬には有害なもの（毒薬）もある。投げると対象に効果が及ぶ薬もある。
- 投擲武器（投げナイフ・投げ槍）は throw_item で対象（エンティティ ID か座標か方向）へ投げる。投げた物は着地点に落ちるので拾い直せる。
- 遺物（retrieve_relic の目的の品）は効果を持たない。持ったまま階段の上で extract すると持ち帰れる。
- 地物: 泉（回復、1 回）、祭壇（所持品を鑑定、1 回）。罠は見つけるまで見えない（隣接すると発見判定）。発見済みの罠は経路探索で避ける。`,
    observation: `# 観測と turn ブロック
- 全応答の turn: state（your_turn / waiting_others / at_camp / expedition_ended / run_ended）、turn_no、reason、awaiting（action / camp_choice / nothing）、changes（前回の応答からの重要な変化）。テキストでは末尾の ▶ 行が同じ内容。
- changes のコード: new_hostile（このランで初めて見た）, reappeared（前に見た個体が再び見えた）, killed（あなたが倒した）, died_seen（目の前で倒れた）, hostile_gone（倒れた以外の理由で見えなくなった）, hp_dropped, hp_low, status_gained, status_lost, level_up, item_found, stairs_found, floor_changed, objective_progress, objective_complete, can_extract。alerts は「現在の状態」、changes は「前回からの差分」。
- 行動結果の outcome には、その行動から次の自分の手番までに受けた攻撃の回数・命中・合計ダメージ（HP の前後。間に回復があれば「回復 +N」）が必ず入る。
- summary: 1 行の現況。alerts: 重要度順の警告（enemy_adjacent, low_hp, critical_hp, poisoned, on_stairs, item_here, inventory_full, new_floor, can_extract, at_camp など）。
- expedition: 遠征の目的・進捗・can_extract・extract_blocked_by・extract_outcome（今 extract したら complete=達成 / withdraw=撤退）。キャンプでは camp に次の遠征の候補。
- 手負いで逃げている敵には fleeing が付く。逃走中の敵は追跡中でも extract と休息を妨げない。
- self: HP・レベル・状態異常・位置・装備・所持品（brief は一覧の短縮形、full は詳細）・turns・speed（実効の速さ）・score（確定済みの点と達成した遠征の数）・rest_estimate（HP が減っているとき）。
- visible.monsters: id, 名前, 座標, 方向, 距離, hp_state, awareness(asleep/unaware/hunting), threat, role, damage_seen, hp_left_est, shot（clear: 投擲の経路が通る / blocked）, bounty（倒すと戦利品に入る賞金）。items（同じマスの同種は 1 行。自分が投げた物は mine、宝は value）/ players / features も同様。
- expedition.haul: 未確定の戦利品（total, multiplier_pct, parts, if_extract_now, next_overreach）。camp.offers: slot（safe/standard/ambitious）, traits, multiplier_pct, danger, recommended_level。
- navigation: here(足元), passable_dirs, frontiers(未探索との境界、近い順), known_stairs(既知の階段と到達可否・path_len)。
- map: 自分中心の 21×15 ASCII（フロア外は出さない）。上の 2 行が x 座標の 10 の位と 1 の位、行頭が y 座標。英字=モンスター（種族ごとに固定の 1 文字。凡例を参照） @=自分 #=壁 .=床 +=閉じた扉 '=開いた扉 >=下り階段 <=上り階段 ~=水 ,=草 %=背の高い草(視界を遮る) !=薬 ?=巻物 )=武器 [=防具 /=投擲 $=遺物 {=泉 _=祭壇 ^=罠 &=味方 (空白)=未知。凡例は地図と一緒に付く。
- valid_actions: 今できる行動の例。テキストは structuredContent の要約で、テキストにしか無い情報は無い。
- get_map で記憶している階全体の地図、look で対象の詳細（モンスターは「思い出」に基づく既知情報）、recall で種族ごとの思い出を引ける。`,
  };
}

function en(r: CatalogRules): Record<Topic, string> {
  const x = r.expedition;
  const h = r.haul;
  const sl = r.slots;
  const rg = r.regen;
  const [b1, b2, b3] = r.hpBands;
  return {
    overview: `# MuseDungeon rules (overview)
- Turn-based roguelike played in expeditions. An expedition ends when you complete its objective and extract on stairs, withdraw (extract with confirm), die, or retire.
- While turn.state is your_turn the game is waiting for your next action (the world is paused until you call an action tool).
- When turn.state is expedition_ended / at_camp / run_ended, no further action is required (it is fine to stop).
- A run (one character, one seeded world) is endless; each expedition goes deeper. Permadeath.
- Score (version 2) = total banked points. Points earned during an expedition are an unbanked haul that only counts once you bring it back (extract); dying loses that expedition's haul (see get_rules expedition). The record keeps how many expeditions you completed.
- Floors are procedurally generated from a seed; depth is unbounded. Deeper monsters gain tiers and affixes.
- You only know your field of view (~radius 8) and the map you remember. Unexplored terrain and unseen monsters are never included.
- Speed-based turns (normal 100). Floors without players are frozen in time.
- Invalid actions change nothing and cost no time; errors include code/message/hint and valid_actions.
- Use the notes tool for your own memos. The optional thought argument on action tools is shown to spectators.
- Lingering on a floor attracts wandering monsters (every ${r.wander.intervalMin}-${r.wander.intervalMax} floor time; the exact next time is hidden).
- Some floor types have no monsters (sanctuary: a resting floor that appears at intervals in the depths, with no monsters or wanderers).
- new_run's objective chooses the first expedition (reach_depth = safe slot / slay_guardian = standard slot / retrieve_relic = ambitious slot / endless; default auto = reach_depth). Later expeditions are chosen from 3 offers at camp.`,
    expedition: `# Expeditions
- Objective types: reach_depth (arrive on the target depth), slay_guardian (slay the guardian there), retrieve_relic (pick up the relic there and carry it out), endless (no objective).
- Guardian and relic locations are not revealed; observations mark them with role: guardian / relic.
- Extract (complete): objective done, standing on any stairs (up or down), and no hunting enemy in view. The expedition ends as completed.
- Withdraw (extract confirm: true): same conditions without the objective; you survive and the expedition ends as withdrawn.
## Haul and banked points (score version 2)
- Run score = total banked points. Everything earned during an expedition is an unbanked haul, settled on extract:
  - Completed (objective done, extract): haul x the offer's multiplier
  - Withdrawn (extract confirm): (haul - objective points) x ${h.withdrawPct}%
  - Died / retired: 0 (recorded as lost)
- Haul parts:
  - objective: base points on completion (reach_depth ${x.points.reach_depth ?? 0}, slay_guardian ${x.points.slay_guardian ?? 0}, retrieve_relic ${x.points.retrieve_relic ?? 0}; +${x.pointsPerExtraDepth} per depth beyond deepest + ${x.aheadMin}; scaled by the slot percentage)
  - overreach: each time you first reach a depth below the target this expedition: +${h.overreachFirst} for the first, growing by ${h.overreachStep} each (+${h.overreachFirst}, +${h.overreachFirst + h.overreachStep}, +${h.overreachFirst + h.overreachStep * 2}, ...)
  - treasure: value of treasure items you carry (drop one and it is gone; cashed in and removed on extract)
  - bounty: slaying a guardian (${h.guardianBounty.base} + depth*${h.guardianBounty.perDepth}); shown as bounty. Guardians always drop a treasure
  - discovery: first time this run you kill a species +${h.discovery.species} / identify an item kind +${h.discovery.identify}
  - kills: +${h.perKill} each
- expedition.haul shows parts, total, multiplier, if_extract_now (banked if you extract right now) and next_overreach every time. self.score shows your banked points.
- In COOP the haul (except treasure) is shared by the party and paid to each player who extracts. Treasure belongs to whoever carries it.
## Pressure after the objective
- For slay_guardian and retrieve_relic, from the moment the objective is done until the expedition ends, the wanderer spawn interval becomes ${r.afterObjectiveWanderPct}% (changes says the pit grows restless). reach_depth has no such pressure.
- Picking up the relic wakes sleeping/unaware monsters on that floor and sends them toward it.
## Offers at camp
- Three slots. Target depth = deepest generated depth + range (the first expedition starts from depth ${x.firstTargetDepth}):
  - safe: +${sl.safe.aheadMin}-${sl.safe.aheadMax}, ${sl.safe.traitsMin}-${sl.safe.traitsMax} traits, base points x${sl.safe.pointsPct}%
  - standard: +${sl.standard.aheadMin}-${sl.standard.aheadMax}, ${sl.standard.traitsMin}-${sl.standard.traitsMax} traits, base points x${sl.standard.pointsPct}%
  - ambitious: +${sl.ambitious.aheadMin}-${sl.ambitious.aheadMax}, ${sl.ambitious.traitsMin}-${sl.ambitious.traitsMax} traits, base points x${sl.ambitious.pointsPct}%
- Traits are public modifiers on every floor down to the target for that expedition. Their multipliers apply to the haul on completion (multiplied together):
${traitsLines(r, false)}
- danger = clamp(3 + recommendedLevel(target depth) - your level + sum of trait dangers, 1, 5); recommendedLevel(depth) = 1 + floor(depth*${r.recommendedLevel.mul}/${r.recommendedLevel.div}). No hidden information is used.
## Other
- After completing or withdrawing you are at camp: time does not pass, HP is restored and statuses cleared. Choose the next of 3 offers with start_expedition { offer } (you restart from the stairs you extracted on). You may stop instead and resume_run later.
- A disconnect does not end an expedition; resume_run continues it.
- Every observation includes expedition (objective, progress, can_extract).`,
    actions: `# Actions
Turn-consuming: move{dir} / wait / rest{until_hp?,max_turns?} / explore / travel_to{to} / collect / pickup{item?} / drop{slot,qty?} / equip{slot} / unequip{slot} / use_item{slot,target?} / throw_item{slot,target} / interact{dir?} / use_stairs / extract{confirm?}
At camp: start_expedition{offer} / retire
Free: observe / wait_for_turn / expedition / look / get_map / inventory / recall / get_messages / notes / say / set_options / get_rules
- Directions: n ne e se s sw w nw. Origin is top-left; x grows east, y grows south.
- move attacks a hostile in that cell, opens a closed door (without moving), or swaps with an ally.
- explore: macro that walks to the nearest unexplored frontier (max ${r.macroStepLimit} steps); stops on new hostile, damage, new item/stairs, or when fully explored. Results include distance and time_elapsed.
- travel_to: macro to {x,y}, "stairs_down", "stairs_up" or an entity id over the known map. Known stairs carry path_len.
- explore / travel_to / collect stop when: a monster (individual) you have never seen this run comes into view; a known monster comes into view hunting (not fleeing); a visible monster starts hunting; you are attacked (even if missed); you take damage; an awake, non-fleeing enemy is adjacent (hostile_adjacent: macros will not move, step away with move); the next cell holds an enemy (blocked: macros never attack). Fleeing monsters entering/leaving view do not stop them.
- rest: waits until HP is full and poison is gone, or until until_hp / max_turns (max ${r.restMaxTurns} turns). It stops when any monster comes into view.
- throw_item at an entity id is refused with no_line_of_sight when the path is blocked (shot: blocked); targeting a position lands where it is blocked. The result always says hit / missed / blocked / fell short and where it landed.
- Items you threw are picked up just by stepping on them (free). collect visits your known thrown items in order.
- set_options: response verbosity (map auto/always/never, inventory on_change/always, status_line short/long). No game effect.
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
- When you see a monster die you learn its max HP; recall keeps an HP record per species. For recorded species, observations include damage_seen and hp_left_est (lower bound only until ${r.estimateMinSamples} are recorded).
- When an unseen attacker hits you, you learn the direction it came from.
- threat (1-5) is estimated from your HP and the max damage you have taken from that species (or a depth-based guess).
- Noise from combat and doors may wake nearby sleepers.`,
    items: `# Items
- Weapons/armor: equip them. Some have affixes (e.g. keen = +2 acc).
- Treasure: no use, only a value, known as soon as you see it ("silver goblet (value 180)"). Counts toward the haul while carried and is cashed in on extract. Takes an inventory slot.
- Potions and scrolls start unidentified ("red potion"); the mapping is shuffled per run. Using one identifies it; so do identify scrolls and altars.
- Some unidentified potions are harmful. Some potions affect the target when thrown.
- Throwing weapons: throw_item at an entity id, position or direction. They land and can be picked up again.
- The relic (retrieve_relic) has no effect; extract on stairs while carrying it.
- Features: fountain (heal, once), altar (identify inventory, once). Traps are hidden until found (search happens when adjacent). Known traps are avoided by pathing.`,
    observation: `# Observation and the turn block
- Every response has turn: state (your_turn / waiting_others / at_camp / expedition_ended / run_ended), turn_no, reason, awaiting (action / camp_choice / nothing), changes (important changes since your last response). The final ▶ line of the text says the same.
- change codes: new_hostile (first time this run), reappeared, killed (by you), died_seen, hostile_gone (left view without dying), hp_dropped, hp_low, status_gained, status_lost, level_up, item_found, stairs_found, floor_changed, objective_progress, objective_complete, can_extract. alerts = current state, changes = what changed.
- Every action outcome states how many attacks you took until your next turn, how many hit and the total damage (HP before/after, plus "healed +N" if you recovered in between).
- summary, alerts (enemy_adjacent, low_hp, critical_hp, poisoned, on_stairs, item_here, inventory_full, new_floor, can_extract, at_camp, ...).
- expedition: objective, progress, can_extract, extract_blocked_by, extract_outcome (complete / withdraw if you extract now). At camp, camp lists the next offers.
- Wounded monsters running away carry fleeing; a fleeing monster does not block extract or resting.
- self: hp, level, statuses, position, equipment, inventory (brief: compact line; full: details), turns, speed, score (banked points and completed expeditions), rest_estimate (when hurt).
- visible.monsters: id, name, pos, dir, dist, hp_state, awareness (asleep/unaware/hunting), threat, role, damage_seen, hp_left_est, shot (clear / blocked), bounty. Items (same kind on one cell merged; your thrown items have mine, treasure has value) / players / features too.
- expedition.haul: the unbanked haul (total, multiplier_pct, parts, if_extract_now, next_overreach). camp.offers: slot, traits, multiplier_pct, danger, recommended_level.
- navigation: here, passable_dirs, frontiers (nearest first), known_stairs (with reachability and path_len).
- map: 21x15 ASCII centered on you (clipped to the floor). Top rows give x tens/ones, each row starts with y. Letters = monsters (one fixed letter per species; see legend). @ you, # wall, . floor, + closed door, ' open door, > down, < up, ~ water, , grass, % tall grass (blocks sight), ! potion, ? scroll, ) weapon, [ armor, / throwing, $ relic, { fountain, _ altar, ^ trap, & ally, blank = unknown. The legend comes with the map.
- valid_actions: example actions available now. Text output summarizes structuredContent; nothing exists only in text.`,
  };
}

export function rulesText(topic: RulesTopic = 'all', locale: 'ja' | 'en' = 'ja', catalog: Catalog): string {
  const src = locale === 'en' ? en(catalog.rules) : ja(catalog.rules);
  if (topic === 'classes') return classesText(catalog, locale);
  if (topic === 'all') return [...Object.values(src), classesText(catalog, locale)].join('\n\n');
  return src[topic];
}
