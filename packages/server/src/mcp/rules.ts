// get_rules の本文。式と操作方法のみ（個別のモンスター数値は含めない）。
// 数値は content の balance.json（catalog.rules）から作る（ルールブックと実際の挙動が食い違わないように）。
import type { Catalog, CatalogRules } from '@muse/shared';

export const RULE_TOPICS = ['overview', 'expedition', 'actions', 'combat', 'items', 'classes', 'observation', 'season', 'all'] as const;
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
    const sg = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
    const par = (s: string) => (ja ? `（${s}）` : ` (${s})`);
    const start = k.startPerks.map((pk) => { const d = c.perks[pk]; const ab = d?.ability ? c.abilities[d.ability] : undefined; return ab ? `${nm(d.name)}${par(`${ja ? '能動技' : 'ability'} ${d.ability!.split(':')[1]}`)}` : nm(d?.name ?? { ja: pk, en: pk }); }).join(', ');
    const lin = k.lineages.map((l) => `${nm(l.name)}${par(l.id)}`).join(ja ? '・' : ', ');
    lines.push(ja
      ? `- ${id.split(':')[1]}（${k.name.ja}）: ${k.desc.ja}\n  初期値: HP ${b.maxHp} 命中+${b.acc} 回避${b.eva} 威力${b.might} 装甲${b.armor} 視界${b.sight} 速さ${b.speed} 所持枠${b.capacity}\n  初期装備: ${items}\n  成長: レベルごとに HP +${g.maxHpPerLevel}。命中・威力・回避などは特技で選ぶ\n  習熟: 近接の命中 ${sg(k.proficiency.melee)}・投擲の命中 ${sg(k.proficiency.thrown)}\n  Lv1 の特技: ${start || 'なし'}\n  特技の系統: ${lin}＋共通`
      : `- ${id.split(':')[1]} (${k.name.en}): ${k.desc.en}\n  base: HP ${b.maxHp} acc+${b.acc} eva ${b.eva} might ${b.might} armor ${b.armor} sight ${b.sight} speed ${b.speed} capacity ${b.capacity}\n  start: ${items}\n  growth: HP +${g.maxHpPerLevel}/level; accuracy, might, evasion and more come from perks\n  proficiency: melee acc ${sg(k.proficiency.melee)}, thrown acc ${sg(k.proficiency.thrown)}\n  level 1 perks: ${start || 'none'}\n  perk lineages: ${lin} + common`);
  }
  // 特技（V3-4 §4.1）
  const n = c.rules.perkOptions ?? 3;
  lines.push(ja
    ? `\n# 特技（choose_perk）\n- レベルが上がるたびに、共通の表と職業の 2 系統から ${n} つの候補が出る（同じランなら同じ候補。取った特技・段階の上限・前提を満たさないものは除く）。choose_perk { option: 番号 } で 1 つ選ぶ。手番を消費せず、選ぶまで進行は止まらない（保留できる。alerts に perk_pending、self.perk_choice に候補）。保留が重なれば古い順に選び、次の候補はその後に引く。\n- 能動技を覚える特技を取ると self.abilities に入り、use_ability で使える。`
    : `\n# Perks (choose_perk)\n- Each level up offers ${n} perks from the common table and your class's two lineages (the same run always offers the same; perks you have at their rank limit or whose prerequisites you lack are left out). Pick one with choose_perk { option: number }. It takes no turn and nothing waits for it (you may hold it: alerts carry perk_pending and self.perk_choice lists the options). Pending choices are resolved oldest first; the next options are drawn after that.\n- Perks that teach an ability add it to self.abilities; use it with use_ability.`);
  const lineageName = (lid: string) => {
    if (lid === 'common') return ja ? '共通' : 'common';
    for (const k of Object.values(c.classes)) { const l = k.lineages.find((x) => x.id === lid); if (l) return ja ? `${nm(l.name)}（${nm(k.name)}）` : `${nm(l.name)} (${nm(k.name)})`; }
    return lid;
  };
  const byLineage = new Map<string, string[]>();
  for (const [pid, pk] of Object.entries(c.perks)) {
    const s = `${nm(pk.name)}${ja ? `（${pid.split(':')[1].replace(/^perk_/, '')}）` : ` (${pid.split(':')[1].replace(/^perk_/, '')})`}: ${nm(pk.desc)}${pk.maxRanks > 1 ? (ja ? `（${pk.maxRanks} 段まで）` : ` (up to ${pk.maxRanks} ranks)`) : ''}`;
    byLineage.set(pk.lineage, [...(byLineage.get(pk.lineage) ?? []), s]);
  }
  for (const [lid, list] of byLineage) lines.push(`- ${lineageName(lid)}: ${list.join(ja ? '／' : ' / ')}`);
  // 能動技（V3-4 §4.2）
  lines.push(ja
    ? `\n# 能動技（use_ability { ability, target?, slot? }。ability は id でもよい）\n- 資源は使わず、再使用までの手番（cooldown）だけで管理する。使うと 1 手番。self.abilities に cooldown_left（0 なら使える）と、遠征ごとの回数があれば uses_left。valid_actions に使えるものは対象付き（use_ability bash target:e_xxx。書いてある形のまま呼べる）、使えないものは「不可」と残りの手番付きで出る。使えない・対象が無いときは手番を使わずに拒否される。`
    : `\n# Abilities (use_ability { ability, target?, slot? }; ability may also be given as id)\n- No resource: only a cooldown in turns. Using one takes a turn. self.abilities shows cooldown_left (0 = ready) and uses_left when limited per expedition. valid_actions lists ready ones with targets (use_ability bash target:e_xxx, callable as written) and the others as unavailable with turns left. If unusable or without a target it is refused without spending a turn.`);
  for (const [aid, ab] of Object.entries(c.abilities)) {
    const tg = ja ? { adjacent: '対象: 隣の敵（ID か方向。隣に 1 体なら省略可）', throw: '対象: 投擲の射程と射線が通る敵の ID（slot で投げる品。省略時は投擲用の品の最初のスロット）', dir: '対象: 方向', none: '対象なし' }[ab.target]
      : { adjacent: 'target: an adjacent enemy (id or direction; may be omitted if only one)', throw: 'target: an enemy id in throwing range with a clear line (slot picks the item; default the first throwing item)', dir: 'target: a direction', none: 'no target' }[ab.target];
    const cd = ab.perExpedition ? (ja ? `遠征ごとに ${ab.perExpedition} 回` : `${ab.perExpedition} per expedition`) : (ja ? `再使用まで ${ab.cooldown} 手番` : `cooldown ${ab.cooldown}`);
    lines.push(ja ? `- ${aid.split(':')[1]}（${nm(ab.name)}）: ${nm(ab.desc)}。${tg}。${cd}` : `- ${aid.split(':')[1]} (${nm(ab.name)}): ${nm(ab.desc)}. ${tg}. ${cd}`);
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
- 死ぬと、その者はランから外れ、持ち物（装備・品・帰還の綱）と、その遠征の戦利品をすべて失う（その場に落とさない。協力プレイでも仲間には残らない。ほかの参加者はランを続けられる）。
- スコア（版 2）= 確定点の合計。遠征中に得た点は「未確定の戦利品」として積み上がり、持ち帰って（extract）初めて確定する。死ねばその遠征の戦利品は失う（詳しくは get_rules expedition）。記録には達成した遠征の数が残る。
- ダンジョンは階層ごとにシードからプロシージャル生成され、深さに上限は無い。深層では敵が強化（tier と接辞）される。
- あなたが知り得るのは、自分の視界（半径 8 前後）と記憶した地図だけ。未探索の地形や視界外の敵は観測に含まれない。
- 手番は速度ベース（標準 100）。速い敵はあなたより多く動く。プレイヤーがいない階は時間が止まる。ただし守護者と大守護者は、あなたを追っていない間（階を離れている間と、同じ階で見失って探すのをやめた後）、手番 1 つにつき最大体力の ${r.guardianAwayHealPct ?? 2}% を回復する（次に見たとき・追跡を再開したとき・階に戻ったときに一度に。物陰に入った数手番では始まらない）。全快すれば落ち着く: 持ち場へ戻り、追跡をやめ、状態異常・怒りが消え、呼んだ手下は去る。眠りが深い守護者は眠りに戻る。キャンプへ戻ると、すべての守護者が全快して落ち着く。退いてすぐ薬や泉で戻して戻るのは今までどおり効く（通常の敵は回復しない）。
- 不正な行動は状態を変えず時間も消費しない。エラーには code / message / hint と valid_actions が付く。
- valid_actions の 1 行は「<ツール> [<主な引数>] [<名前>:<値> ...] (<説明>)」で、書いてある形のまま呼べる。主な引数はツールごとに 1 つ（move・interact の dir、fight・attack の target、travel_to の to、use_item・equip・throw_item の slot、use_ability の ability）。<a|b> はどれか 1 つを選ぶ。値の [a,b] と a,b は並べたもの（配列。書いてある文字列のままでもよい）。説明が「不可」で始まる行は、今は使えない知らせ。
- 長いプレイでは notes ツールで自分用メモを残せる（ゲームに影響しない）。行動ツールの thought 引数は観戦者に表示される。
- 同じ階に長く留まると徘徊モンスターが湧く（フロア時間 ${r.wander.intervalMin}〜${r.wander.intervalMax} ごと。次に湧く正確な時刻は分からない）。
- 階の種類によっては敵がいない（聖域: 深い所に一定の間隔で現れる、敵も徘徊も出ない休息の階）。
- new_run で objective を省くとキャンプから始まり、最初の遠征も候補 3 つから選ぶ。objective を渡すと最初の遠征を直接始める（reach_depth = 堅実の枠 / slay_guardian = 標準の枠 / retrieve_relic = 野心の枠 / endless / auto = 1 番目の候補）。2 回目以降はキャンプの候補 3 つから選ぶ。`,
    expedition: `# 遠征
- 目的の種類: reach_depth（目標の階を踏破する＝その階の下り階段に立つ。着いただけでは達成しない）、slay_guardian（目標の階の守護者を倒す）、retrieve_relic（目標の階の遺物を拾い、持ったまま帰る）、slay_bounty（目標の階の賞金首を倒す。名前付きの強敵で、種族・接辞・名前・体力と一撃の目安が候補に出る）、open_vault（目標の階の施錠された宝物庫を開ける。鍵はその階の敵 1 体が持つ。開けた時点で達成）、endless（目的なし）。
- 深い階の目的: 地下 6 階より深い目標で到達（reach_depth）になる枠は、到達・賞金首・宝物庫から等しく選ばれる（前の遠征が到達なら到達は出ない）。目的でなくなった賞金首は、その遠征の間は階に残り、次の候補に再挑戦（同じ名前と接辞）で出ることがある
- 守護者の格は枠で決まる: 堅実 格 1（その深度の候補の上位半分・射撃して距離を取る型を除く・体力 +${r.guardianRanks?.[0]?.hpPct ?? 50}%・型 1 つ。堅実の遺物は無防備）、標準 格 2（1 つ深い階の候補の上位半分・+${r.guardianRanks?.[1]?.hpPct ?? 100}%・型 1 つ）、野心 格 3（2 つ深い階の候補の上位半分・+${r.guardianRanks?.[2]?.hpPct ?? 150}%・型 1 つ）。候補に守護者の名前と型（称号）、見込み（格と、速い・遅い・射撃する・大柄・重装、一撃の目安、体力の目安）が出る。種族名は会うまで出ない。体力の目安は「種族の体力ダイスの平均 × (100 + 格の上乗せ)%」で、下限は格 1 が ${r.guardianRanks?.[0]?.minHpBase ?? 6} + ${r.guardianRanks?.[0]?.minHpPerDepth ?? 2} × 深さ、格 2・3 が ${r.guardianRanks?.[1]?.minHpBase ?? 10} + ${r.guardianRanks?.[1]?.minHpPerDepth ?? 3} × 深さ（実物はダイスの振れの分だけ上下する）。候補には幅を添える（「体力はおよそ 20（9〜32）」。括弧の中は、体力ダイスの最小と最大に同じ計算をした値。賞金首も同じ形で、格の上乗せと下限は無い）。型が打ち消す弱点は付かない（弾く者に「投擲に弱い」、潜む者に「眠りが深い」は無い）。型の一覧は get_rules topic=classes の「守護者の型」。
- 重い一撃: 格 2 以上の守護者と大守護者の攻撃（近接・射撃・突進・大振り）は、装甲（と構え）で一撃の半分までしか減らない（受けるダメージ = max(一撃 − 装甲, 一撃の半分の切り上げ)）。格 1 の守護者・通常の敵・名前付きの強敵は今までどおり。候補の一撃の目安に「装甲で減っても N より下がらない」、敵の行に「重い一撃」と出る
- 守護者には弱点が 1 つある（毒に弱い・投擲に弱い・眠りが深い・水場で遅い）。どれかは伏せられていて、弱点が効いた場面を見ると分かり、look と観測の「弱点」に出る。
- 予備動作: 次の手番に大きな行動を取る敵（突進の構え・手下を呼ぶ構え・怒りの予兆）は、見えていれば観測の intent と alerts に出る。突進の構えは向きと、あなたがその直線の上にいるか（on_line）が分かる。移動・戦闘・休憩のマクロは、見えている敵が新しく予備動作を見せたら止まる（intent）。
- 守護者・遺物の居場所は教えられない。観測では role: guardian / relic の印が付く。
- 守護者は置かれた場所を持ち場にし、気づいていない間は持ち場の近くから離れない（守護者付きの遺物では遺物のそば）。追跡は他の敵と同じで、見失って捜索を終えると持ち場へ戻る。
- 遠征を始めると、その遠征の目的ではない未討伐の守護者（大守護者を除く）と名前付きの強敵は階を去る（会ったことがあれば changes に出る。強敵のいた階の異変の文も消える）。候補の再挑戦（同じ守護者・賞金首をもう一度目的にする）の相手は残る。
- 傷跡: 再挑戦の相手は、キャンプの間に全快せず、前の挑戦で与えたダメージの 4 分の 1 が残る（最大体力の半分まで）。候補に「傷跡で体力 −N」と出る
- 帰還（extract）: 目的を達成したうえで、いずれかの階段（上り・下り）の上にいること。追跡中の敵が見えていてもよい（敵は階段を追ってこない。階を移れば追ってこない）。遠征は「達成」で終わる。
- 撤退（extract confirm: true）: 目的が未達成でも同じ条件で extract できる。生還し、遠征は「撤退」で終わる。
- 帰還の綱: 遠征の開始時にキャンプが 1 本持たせる（余っていても 1 本、無ければ補充。坑の中では手に入らない。捨てる・投げることはできず、所持数に数えない）。use_item で使うと${r.lifeline.turns > 0 ? ` ${r.lifeline.turns} 手番のあいだ行動できず（その間の攻撃は受ける）、その後` : 'その手番で'}キャンプへ戻る。確定するのは目的を除いた戦利品の ${r.lifeline.pct}%（目的を達成済みでも目的の点は入らない。目的の点は階段の上の extract でだけ確定する）。持っている遺物は運べず、失われる。倒した守護者は倒れたまま。次の候補の深さ（目標として達成した最深の階）も上がらない。遠征は「綱で帰還」で終わる。
- 結果の段階は 4 つ: 階段で帰還（戦利品 × 倍率）／綱で帰還（目的を除いて ${r.lifeline.pct}%）／階段で撤退（目的を除いて ${h.withdrawPct}%）／死亡（0、ランの終わり）。
## 戦利品と確定点（スコア版 2）
- ランのスコア = 確定点の合計。遠征中に得た点はすべて未確定の「戦利品」で、extract で確定する:
  - 帰還（目的を達成して extract）: 戦利品 × 条件の倍率
  - 撤退（extract confirm）: (戦利品 − 目的の基礎点) × ${h.withdrawPct}%
  - 綱で帰還: (戦利品 − 目的の点) × ${r.lifeline.pct}%（倍率は掛からない。目的を達成済みでも同じ）
  - 死亡・引退: 0（失った戦利品として記録に残る）
- 戦利品の内訳:
  - 目的: 達成した時点で候補の基礎点（= 枠の基礎点 × 種類の係数 × 深さの係数。下の「遠征の候補」）
  - 踏破（深追い）: 目標より深い階を横切り、その階の**下り階段に立った**とき（着いただけでは入らない）。n 階目 = 目的の基礎点 × (${h.overreachPct.first} + ${h.overreachPct.step}×(n−1))%、下限 ${h.overreachFirst} + ${h.overreachStep}×(n−1)（1 階目 ${h.overreachPct.first}%・2 階目 ${h.overreachPct.first + h.overreachPct.step}%…）。着いた階段ですぐ帰ることもできる（逃げ道であって報酬ではない）
  - 宝: 分類 treasure の所持品の価値の合計（落とせば減る。帰還・撤退で換金され所持品から消える）。持ち帰った遺物は帰還で納められ、所持品から消える
  - 賞金: 守護者を倒すと（${h.guardianBounty.base} + 深度×${h.guardianBounty.perDepth}）。観測の bounty に出る。守護者は宝を必ず落とす
  - 発見: このランで初めて、ある種族を倒す +${h.discovery.species}／外見で呼ばれていたアイテム種の正体が分かる +${h.discovery.identify}（使う・鑑定する。装備品の呪いの有無を確かめても入らない）／特殊部屋を初めて見つける +${h.discovery.room}／碑文を読む +${h.discovery.inscription}
  - 特殊部屋（見つけると「〇〇を見つけた」と出る）: 施錠された宝物庫（宝 2〜3。鍵のかかった格子扉は中が見えるが通れない。鍵はその階の敵 1 体が持ち、visible.monsters に「宝物庫の鍵を持っている」と出る。倒すと落とす。鍵を持って格子扉の隣で interact すると開き、鍵は無くなる）・碑文の間（碑文を読むと記録の断章と手がかり 1 つ: この階の守護者の弱点、無ければ鍵のかかった宝物庫の場所、無ければ未鑑定の品 1 種の正体）・賭けの祭壇（1 回だけ祈れる。起きることの表と確率は look で読める）・番兵の詰所（眠っている敵 4 体と宝 1 つ）・先行者の野営跡（消耗品と書き置き。浅い階に多い）・崩れた書庫（巻物と、本棚の間に起きている敵）
  - 階の異変: 通常の階と大空洞に、${r.floorEventPct ?? 25}% の確率で 1 つ付く。着いたときに self.floor.event_text（状態の行の「この階:」）に感じ取れることだけが出る（「この階は静まり返っている」など）。中身は探って確かめる
  - 名前付きの強敵: 地下 ${r.elite?.minDepth ?? 3} 階から、通常の敵の ${r.elite?.chancePct ?? 3}% が、接辞 ${r.elite?.affixes ?? 2} つと名前と賞金を持つ強敵になる（visible.monsters に「強敵「名前」・賞金 N・宝を必ず落とす」。look に接辞の中身）
  - 未鑑定の手がかり: 薬と巻物には感覚の手がかりがあり、2 種で同じ手がかりを共有する。手がかりのある未鑑定の品を持って ${r.clueTurns ?? 30} 手番たつと（斥候は拾った時点で）気づき、inventory と所持品の行に出る（正体は分からないが候補が 2 つに絞れる）
  - 初見の描写: このランで初めて見た種族・地物・バイオームは、changes（first_seen）に 1 文の描写が 1 回だけ出る（以後は look で読める）
  - バイオームの仕掛け: 石の広間と沈んだ書庫には、レバーとつながった格子扉がある（レバーを隣で interact すると閉じる・開く。閉じた格子扉は見通せて投げた物と射撃は通るが、誰も通れない。追跡を切るのに使える）。湿った洞窟: 浅い水は入る手番が 150、水の上の音は 2 倍遠くまで届く。脆い天井は 3 マス以内で大きな音（投げた物が落ちる・戦い・敵が扉を開けるなど。自分で扉を開ける音では崩れない）がすると崩れ、周り 1 マスに 2d6、真下は瓦礫になる。苔むした遺跡: 背の高い草の中の者は、隣からしか見えず、攻撃しても隠れたままである（あなたも敵も）。草の中から撃たれたときは、方角だけが分かる（名前・位置は出ず、最悪の被害の見立てにも入らない）。胞子嚢は突く（interact）か投げた物を当てると弾け、周り 1 マスの者を毒にし、毒の雲を 3 手番残す。沈んだ書庫（地下 6 階から）: 本棚は視界をさえぎり、向こうが空いた床なら押して動かせる（move。手番 150）。床の残り頁を読むと周り 10 マスの地形が分かる
  - 撃破: 種族の経験値 × ${h.killPerXp} × 深さの係数（${x.depthPct.base} + ${x.depthPct.perDepth}×深度 %）。接辞付きは × ${h.killAffixPct}%（大ネズミは 6 点前後、強い種族ほど大きい）
  - 大柄な種族と接辞付きの個体は宝を必ず落とす（守護者も）
- 観測の expedition.haul に、内訳（parts）・合計・倍率・今 extract した場合の確定点（if_extract_now）・今綱を使った場合の確定点（if_lifeline_now）・次に踏破の点が入る階（next_overreach。その階の下り階段までの経路長が分かれば path_len、未発見なら下への風の方角 dir）・今帰った場合の次の候補の下限と推奨レベル（next_camp。目標として達成した最深の階から数えるので、踏破しても深くならない）が毎回出る。self.score に確定済みの点。
- 下への風: 今いる階の下り階段をまだ見ていない間、その方角（8 方向。遠近は出さない）が self.floor.draft に出る。self.floor.explored はその階の通れるマスのうち見た割合の 4 段階（1 約 1/4・2 約半分・3 約 3/4・4 ほぼ全て）。
- COOP では戦利品（宝を除く）はパーティで共有し、extract した各自に払い戻される。宝は持っている本人の分。
## 目的を達成した後の圧力
- slay_guardian と retrieve_relic は、達成した瞬間からその遠征の間、徘徊の湧き間隔が ${r.afterObjectiveWanderPct}% になる（changes に「坑が騒がしくなった」と出る）。reach_depth には付かない。
- 遺物を拾うと、その階の眠っている・気づいていない敵が目を覚まし、遺物の場所へ向かう（足元の遺物の pickup には「階が目覚める」と出る）。
- 節目の大守護者: 深度 ${r.milestone?.every ?? 5} の倍数の階は「大守護者の間」（前室と広間だけの小さな階）で、大守護者（型 2 つ・弱点 1 つ）がいる。倒すまでその階の下り階段は封じられている（踏破にもならない）。倒していない節目の階に大守護者がいなければ（古い版で作られた階など）、遠征の開始時にその階を大守護者の間として作り直す（その階の地図と記憶は消え、床に残した品は失われる）。倒すと大きな賞金と、加護を ${r.milestone?.boonOptions ?? 3} つの候補から 1 つ選べる（choose_boon。手番は使わない。alerts の boon_pending）。次の節目はキャンプと expedition に常に出る。
- 節目と候補: 大守護者を倒すことを目的にできる（slay_warden「節目に挑む」。目的の点はその深さの格 3 の守護者と同じ式。広間・前室どちらの階段で extract してもよい）。未踏破の節目を越える目標は野心の枠にだけ出る（堅実と標準は越えない）。標準の目標が節目以上なら標準は「節目に挑む」、堅実の目標が節目に当たるなら堅実は節目の 1 つ上の階の格 1 の守護者（力を付ける）。大守護者の体力は「種族の体力 × (100 + ${r.milestone?.hpRule?.hpPct ?? 250})%」を、下限 ${r.milestone?.hpRule?.minHpBase ?? 20} + ${r.milestone?.hpRule?.minHpPerDepth ?? 6} × 深さ・上限 ${r.milestone?.hpRule?.maxHpBase ?? 40} + ${r.milestone?.hpRule?.maxHpPerDepth ?? 10} × 深さに収めた値で、候補にはこの幅（「体力 50〜90」）が出る（正確な値は記録庫の記憶で分かる）。大守護者の速さは ${r.milestone?.minSpeed ?? 100} を下回らない（遅い種族でも「遅い」にならない）。節目に挑む候補の推奨レベルは +${r.milestone?.levelBonus ?? 2}、節目を越える候補は大守護者の推奨レベルと比べて大きいほうで、危険度 +1。同じ階を目標にした達成を繰り返すと、目的の基礎点は ${r.expedition.repeatPct ?? 50}% ずつ減る（下限 ${r.expedition.repeatMinPct ?? 25}%。候補の文に「この階は N 回目」）。封じられた下り階段（大守護者の広間）の上で終えた遠征と、帰還の綱の戻り先がそこだった遠征は、次をその階の上り階段から始める。
- 遺物と加護: 遺物はそれぞれ名前と加護を持ち、候補の時点で分かる（参加者がまだ持っていない加護の遺物から選ばれる）。達成して階段の上で持ち帰ると、遺物は加護になり、そのキャラクターにランの終わりまで付く（帰還の綱では持ち帰れない）。加護は self.boons。一覧は get_rules topic=classes の「加護」。
- 気配: 目標階にいる間、守護者（未討伐）か遺物（未入手）の方角（8 方向）と、10 マス以内かどうかが expedition.sense に出る。正確な位置は見るまで分からない。
## 遠征の候補（キャンプ）
- 候補は 3 枠。目標の深度は「目標として達成した最深の階 + 幅」（踏破で先まで降りても深くならない。踏破は次の目標階の下見になる。最初の遠征は 堅実 地下${x.firstTargetDepth.safe}階・標準 地下${x.firstTargetDepth.standard}階・野心 地下${x.firstTargetDepth.ambitious}階）。目的の種類は 3 枠で別（目標の階の下り階段にすでに立ったことがあれば、その枠に踏破型は出ない）。目標の階が生成済みなら、守護者・遺物は遠征の開始時に置かれる:
  - 堅実: +${sl.safe.aheadMin}〜${sl.safe.aheadMax} 階、条件 ${sl.safe.traitsMin}〜${sl.safe.traitsMax} 個、枠の基礎点 ${sl.safe.base}
  - 標準: +${sl.standard.aheadMin}〜${sl.standard.aheadMax} 階、条件 ${sl.standard.traitsMin}〜${sl.standard.traitsMax} 個、枠の基礎点 ${sl.standard.base}
  - 野心: +${sl.ambitious.aheadMin}〜${sl.ambitious.aheadMax} 階、条件 ${sl.ambitious.traitsMin}〜${sl.ambitious.traitsMax} 個、枠の基礎点 ${sl.ambitious.base}
- 枠（堅実・標準・野心）は、目標の遠さと見返りの大きさを表す。危険は、候補ごとの見立て（推奨レベルとの差・一撃の目安・通る目安）で読む（同じ枠でも、目的の種類と相手の種族・装甲で危険は大きく違う）。守護者（格 1〜3。再挑戦を含む）と賞金首の候補には、体力・一撃・装甲の目安と「いまの持ち物で 1 回に通る目安」（倒すのに要るおよその命中の数）が出る。装甲の目安は種族・接辞・深さから（型の効果は除く）。
- 候補の基礎点 = 枠の基礎点 × 種類の係数（到達 ${x.typePct.reach_depth ?? 100}%・守護者 ${x.typePct.slay_guardian ?? 100}%・遺物 ${x.typePct.retrieve_relic ?? 100}%・守護者付きの遺物 ${x.typePct.retrieve_relic_guarded ?? 100}%・賞金首 ${x.typePct.slay_bounty ?? 100}%・宝物庫 ${x.typePct.open_vault ?? 100}%）× 深さの係数（${x.depthPct.base} + ${x.depthPct.perDepth}×目標深度 %）。どの組み合わせでも 堅実 < 標準 < 野心。
- 条件は公開の修飾。倍率は帰還時の戦利品に掛かる（複数なら掛け合わせ）。2 種類ある: その遠征の間だけ効くもの（騒がしい・薄暗い・静かの「徘徊なし」）と、階を作るときに効くもの（群れる・乏しい・静かの「泉なし」）。階を作るときに効く条件は、その遠征で目標階までのまだ作られていない階（初めて入る階）にだけ効き、作られた階にずっと残る（前の遠征で行った階は、敵・宝・泉もそのまま）:
${traitsLines(r, true)}
- 階は、作られたときの条件の性質を覚えている。着いたときと self.floor.trait_text（状態の行の「この階:」）に「群れている（敵と宝が多い）」などと出る。候補には、目的の階と通り道の階のうち、もう作られていて性質のある階を 1 行で出す（「通り道の地下 13〜16 階は群れている」。floor_traits。まだ作られていない階については何も言わない）。群れている階があれば、候補の危険度（trait_danger）は条件の「群れる階層」と同じだけ上がる（倍率は付かない）。階を作るときだけに効く条件（群れる・乏しい）は、目的の階がまだ作られていない候補にだけ付く
- 候補には推奨レベルと自分との差（level_gap = 推奨 − 自分。正なら推奨より低い）、条件の危険度の合計（trait_danger）が出る。推奨レベルは深度ごとの公開の表（地下1〜${r.recommendedLevel.byDepth.length}階: ${r.recommendedLevel.byDepth.join(', ')}。より深い階は直近 4 階の傾きで伸ばす）。隠し情報は使わない。
- new_run で objective を省くとキャンプから始まり、最初の遠征も 3 候補から選ぶ。
## その他
- 経験値は敵を倒すほか、新しい深度に初めて着く（${r.xp.perNewDepth} × 深度）と遠征の目的を達成する（${r.xp.perObjective} × 目標深度）ことでも得る。
- 遠征が達成か撤退で終わるとキャンプに戻る。キャンプでは時間が進まず、HP は全快し状態異常は消える。次の遠征の候補 3 つから start_expedition { offer } で選ぶ（前回 extract した階段から再開。帰還の綱で戻った場合は、その遠征を始めた階段から。目標の階が上なら上り階段を使う）。キャンプにいる間に、作られているすべての階が落ち着く: 敵は追跡をやめ、体力が全快し、状態異常が消える（見た被害 damage_seen の記憶も消える。守護者・賞金首の傷跡は残る）。再開する階では、再開するマスが見える敵が離れた場所へ移る（削っては帰るを繰り返しても得にならない）。何も選ばずにやめてもよい（resume_run で後から続けられる）。
- 接続が切れても遠征は終わらない（中断）。resume_run で続きから再開できる。
- 観測の expedition に目的・進捗・can_extract（今この場で extract できるか）が毎回付く。`,
    actions: `# 行動
手番を消費する: move{dir} / attack{target} / wait{turns?} / rest{until_hp?,max_turns?} / explore{mode?,hp_floor?,pickup?} / travel_to{to,mode?,hp_floor?,pickup?} / collect{what?,within?,kinds?,all?,mode?} / fight{target,with?,hp_floor?,abilities?} / use_ability{id,target?,slot?} / pickup{item?} / drop{slot,qty?} / equip{slot,confirm?} / unequip{slot} / use_item{slot,target?,target_slot?} / throw_item{slot,target} / interact{dir?} / use_stairs / extract{confirm?}
キャンプで: start_expedition{offer} / retire
手番を消費しない: choose_perk{option} / observe / wait_for_turn / expedition / review / records / profile / look / get_map / inventory / recall / get_messages / notes / say / set_options / get_rules
- 方向は n ne e se s sw w nw。座標は左上原点、x は東、y は南へ増える。
- move: 敵がいれば近接攻撃（バンプ攻撃）、閉じた扉なら開ける（その手番は移動しない）、味方なら位置交換。
- attack{target}: 近接攻撃。隣の敵か、長柄の武器（槍）なら縦・横・斜めの直線で 2 マス先の敵（間のマスが通れて誰もいないこと）。fight も長柄なら 2 マス先から突く。
- use_ability{ability,target?,slot?}: 能動技（get_rules classes。ability は id でもよい）。choose_perk{option}: レベルアップの特技を選ぶ（手番を消費しない）。
- 原則: 1 回の呼び出しは 1 つの判断に対応する。マクロが 1 歩も進めないと分かるときは、手番を使わずに理由付きのエラー（hostile_adjacent / hostile_in_view / hp_floor / blocked / nothing_to_do など）で拒否される。
- 移動マクロ（explore・travel_to・collect）は、同じ 2 マスを往復したら no_progress で止まる（行き先か道を変える）。travel_to は、目的地までの道のりが 20 手のあいだ一度も縮まなくても no_progress で止まる。
- explore: 未見の区画へ自動移動するマクロ（最大 ${r.macroStepLimit} 手）。pickup（既定 'useful'）なら通り道と見えている・記憶したアイテムのうち使える物を拾う（遺物・鑑定済みの有害品（投げて使える毒薬などは拾う）・装備中の品と同じ種類で性能が同じか下の装備は拾わない。'useful' はさらに、鑑定済みで接辞の無い武器・防具のうち、公開の数字が装備中の品以下のもの（防具は装甲、武器はダメージのダイスの平均。種類が違っても比べる）を拾わない。true は全部、false は拾わない。所持品が一杯なら拾わない）。toward: 'draft' なら下への風の方角、'sense' なら遺物・守護者の気配の方角の未探索を優先する（'sense' はこの遠征の目的の遺物・守護者が見えたか覚えていれば止まる。そこへは travel_to）。steady・flee では、1 マス幅の通路をふさぐ逃走中の敵を攻撃して進む。地図の巻物で地形だけ知った区画も「未見」として行き先になる。
- travel_to: {x,y} / "stairs_down" / "stairs_up" / エンティティ ID へ既知地図上で移動するマクロ。目的地がアイテムなら着いて拾う。既知の階段には path_len（既知地図上の経路長）が付く。
- 移動マクロ（explore / travel_to / collect）の mode（慎重さ）:
  - collect（what: items）と、品を目的地にした travel_to は、品のマスに着いた手番に止まるとき、止まる理由が hp_floor・hp_risk・予備動作でなければ、拾ってから止まる（拾う 1 手番を使う）。travel_to は地物の ID（visible.features の id）も指せ、地物は隣に着けば到着。
  - careful（既定）: 初見の種族が見えた／追跡中（逃走中でない）で自分に届く敵が現れた／見えている敵が追跡に変わった／攻撃を受けた（外れも含む）／毒以外のダメージを受けた／状態異常を受けた／HP が 50%・25% の線をまたいだ／階段を見つけた（explore）で止まる。既知の種族の眠っている・気づいていない個体、動かない敵で隣にいないもの、毒の継続ダメージ、アイテムの発見では止まらない（changes には出る）。隣に起きている敵（逃走中を除く）がいると動かない。
  - steady: 追跡中の敵が隣に来た／初見の種族が見えた／HP が hp_floor（既定 最大 HP の 50%）を下回った／その階の下り階段を初めて見た／この呼び出しで受けた被害の合計（毒も含む）が最大 HP の 4 分の 1 を超えた（damage_taken）で止まる。弱い射撃や毒を受けながら進むとき。
  - flee: 到着／進路をふさがれた／HP が hp_floor（既定 25%。始める時点ですでにそれ以下なら 0）を下回ったで止まる。隣に敵がいても動く（退却。途中で受けた攻撃はすべて結果に出る）。
  - careful と steady は、その階の下り階段を初めて見たときにも止まる（踏破の判断の起点）。経路は、見えている動かない敵の隣を罠と同じく避ける（ほかに道が無ければ通る）。
  - どの mode も 1 歩ずつ通常の move として行い、敵は通常どおり攻撃してくる。マクロは攻撃しない（次のマスに敵がいれば blocked で止まる）。valid_actions にはその場で進める mode だけが出る。
- fight{target,with?,hp_floor?,abilities?,until?,adjacent?,approach?}: その相手と決着を付けるマクロ。approach（with なし）: 'wait'（既定）は追跡中で届かない相手が隣に来るまで待つ、'advance' は相手へ寄っていき、隣に着いたら殴る（歩く間に撃たれても止まらない。hp_floor・hp_risk・新しい敵・予備動作などの止まり方はそのまま。3 手番続けて近づけなければ target_moved。動かずに撃ってくる相手に）。until: 'clear' なら、標的を倒した後も、届く追跡中の敵（隣にいる敵、いなければ最も近い敵。逃走中を除く）へ続け、届く追跡中の敵がいなくなれば終わる（cleared）。adjacent は with で投げて戦う相手が隣に来たとき（stop: 止まる・既定／throw: 隣でも投げ続ける／melee: 近接に切り替える）。abilities に能動技（bash・cleave・aimed_throw）を並べると、使える手番ごとに使う（強打は標的が隣、なぎ払いは起きている敵が隣に 2 体以上、狙い撃ちは with の品で射程と射線が通るとき。それ以外の手番は通常の攻撃。立て直し・身をかわすは載せられない）。with なし: 隣の相手に近接攻撃を繰り返す。相手が追跡中で届かない間は隣に来るまで待つ（最大 10 手番。3 手番続けて近づかなければ target_not_approaching で止まる。待つ間に標的に殴られたのに標的が隣にいなければ hit_and_run、離れたまま撃たれたなら target_shooting で止まる）。当てて逃げる相手は、追跡中で 2 マス以内なら 2 手番まで待つ（追わない）。with にスロットか品の種類を渡すと、その品を投げて戦う（射程と射線が通るまで待つ）。with に配列（["javelin", "throwing_knife"]）を渡すと、前の品が尽きて拾い直せる物も無くなったら次の品へ。collect_after: true なら、決着の後（倒した・until: clear で片付いた）に追跡中の敵が見えていなければ自分の投擲物を拾う（collect と同じ止まり方）。止まるのは: 相手が倒れた／離れた・逃げて射程を出た／（with のとき）相手が隣に来た・品が尽きた・射線が 3 手番続けて通らない／HP が hp_floor（既定 50%）以下／**次の手番に、届く追跡中の敵（隣・飛び道具）から 1 手の最悪の被害を受けると hp_floor を割る（被弾の前に止まる。hp_risk）**／被弾の記録の無い種族から初めて被弾した（first_hit。一度だけ。その被弾が最大 HP の ${r.fightFirstHitStopPct ?? 15}% 以上のときだけ止まり、小さければ記録して続ける。${r.fightRecordedKills ?? 3} 体以上倒した種族は記録ありとして扱う）／被弾の記録の無い種族の追跡中の敵が現れた（記録のある種族なら止まらない）／待つ手番に、標的ではない敵の射撃で被弾した（shot_while_waiting）／待つ手番に、標的ではない隣の敵に殴られた（hit_while_waiting。until: 'clear' なら止まらずその敵へ切り替える）／状態異常を受けた（錆のような能力値の修正だけのものでは止まらない）／相手が逃げて見えなくなった（target_fled）。追跡中で逃げていない相手が物陰に入って見えなくなったら、${r.fightLostWait ?? 5} 手番まで出てくるのを待つ（それでも現れなければ target_gone）。眠っている・気付いていない相手を待つことはしない（近づくなら travel_to、先手なら throw_item）。結果に与えた・受けた攻撃の回数と合計。
- wait{turns?}: 1 手番待つ。turns（2〜10）を渡すと、敵が見えた・隣に来た・攻撃や毒以外の被害を受けたら止まりつつ、その手数だけ待つ。
- rest: 全快（かつ毒が抜ける）まで、または until_hp / max_turns まで休むマクロ（最大 ${r.restMaxTurns} 手）。敵が視界に入ると（状態によらず）止まる（すでに見た個体が逃げながら視界を出入りする場合は止まらない）。追跡中の敵が見えている間は休めない（動かない敵は隣にいなければ妨げない）。
- throw_item: 対象（ID）までの投擲の経路が通っていないときは no_line_of_sight、射程外なら out_of_range で拒否される（手番も品物も失わない。visible.monsters の shots に品目ごとの clear / blocked / out_of_range）。座標を狙ったときも、射程外か経路が通らなければ同じく拒否される。方向を狙えば射程の端か遮られた位置に落ちる。結果は必ず「命中／外れ／壁や他の者に遮られた／届かなかった」と落下地点で示される。
- 自分が投げた物は、そのマスに入るだけで拾う（追加の手番なし。所持品がいっぱいなら拾わない）。collect は既知の自分が投げた物（what: thrown、既定）か、見えている・記憶したアイテム（what: items）を近い順に回って拾うマクロ。within は歩数の上限（既定 15。残りがどれもそれより遠ければ collect_far で止まる）、kinds は拾う品の種類（種類 ID か区分。例 ["potion", "javelin"]）。what: items は鑑定済みで今の装備より劣る装備を飛ばす（all: true なら拾う）。通り道の上の品は kinds に無くても踏めば拾う。投げた物が床に残っていると、valid_actions の extract・階段・帰還の綱の行に「投げた物が N 個、この階の床に残っている」と出る（止めはしない）。投げて戦った fight の結果に「投げ物: 手元 N・床に M（うち敵の足元 K）」
- use_item の target_slot: 鑑定の巻物で鑑定する品のスロット。省略するとスロット順で最初の「未鑑定の品」か「呪いの有無を確かめていない装備品」（読んだ巻物自身の種類を除く）。
- use_item の slot は、正体の分かっている品なら種類 ID でもよい（例 "potion_healing"。同じ種類ならスロット順で最初）。呪いと分かっている品の equip は confirm: true が要る（付けると外せない）。
- set_options: 応答テキストの出し方。map（auto: 階が変わった・新しいセルを知った・敵の出入りがあった応答だけ地図を付ける）、inventory（on_change: 所持品の行は変わったときだけ）、status_line（short: 状態が変わらない間の ▶ 行を短く）。ゲームには影響しない。
- observe は待たずに返る。自分の番を待つには wait_for_turn（COOP 用）。
- 所持品はスロット文字 a〜z で指す。装備品は所持品に入ったまま装備される。
- use_stairs: 足元の階段を使う。下り階段 > で 1 階深く。地下1階の上には戻れない（帰還は extract）。敵は階段を追ってこない。
- interact: 扉の開閉（dir 指定）、泉・祭壇の操作（隣接して dir 指定か、上に乗って省略）。
- retire: ランを終える（キャラクターは戻らない）。遠征だけを終えるなら extract。
- 全行動ツールに expect_seq（前提とした observation の seq）を渡すと、状態が進んでいた場合 stale_turn で拒否される（二重実行防止）。`,
    combat: `# 戦闘・回復（整数のみ）
- 命中: d20 + 命中値(acc) >= 10 + 相手の回避(eva)。出目 20 は必中かつ会心、出目 1 は必ず外れ。
- 会心: ダメージダイスが最大値になり（＋威力）、相手の装甲を無視する。一度見た最大の一撃が、その種族の最悪の目安になる。
- 眠っている相手には命中 +5。攻撃すると相手は目を覚ます。
- 近接ダメージ: 武器ダイス + 威力(might) - 相手の装甲(armor)、最低 1。投擲: 投擲ダイス - 装甲、最低 1。表示されるダメージは実際に減った HP（とどめの超過分は含まない。ただし、とどめの文は与えるはずだった値と、残っていた HP を出す: 「6 ダメージを与えた（とどめ。残りは 5 だった）」。fight の合計は実際に減った HP）。
- 習熟: 職業ごとに近接・投擲の命中の修正がある（戦士は投擲 −2、斥候は投擲 +2。get_rules classes）。装備の「近接の命中」「投擲の命中」も足す。
- 状態異常: 毒（毎手番 1 ダメージ）、錆（装甲 −2。0 未満にはならない。10 手番。重ならず、また当たると手番が戻るだけ）、加速（速度 2 倍）、減速（速度半分）、睡眠（行動不能、ダメージで解ける）、朦朧（行動不能。強打・鎚矛）、身かわし（次の自分の手番まで近接が当たらない）、構え（次の自分の手番までに受ける最初の一撃の装甲が上がる）、怯え（逃げ出す HP の閾値が上がる。威圧）${r.lifeline.turns > 0 ? '、帰還中（帰還の綱。行動不能、切れるとキャンプへ）' : ''}。手番開始時に処理。毒で倒れた敵は、毒を与えた者が倒した扱い（賞金・撃破点・経験値）。視界の外で毒が効いている間は相手の名前・体力・位置は出ず、倒れたときだけ「あなたの毒で何かが倒れた」と知らされる。
- 経験値でレベルアップ（次のレベルに必要な累計 XP = 15×Lv²）。最大 HP が上がり、特技を 1 つ選べる（choose_perk。get_rules classes）。
- 回復の薬（鑑定済み）: HP を 2d8+4 回復する。ただし最大 HP の 30% を下回らない。毒も消す。
- 自然回復: max(${rg.minInterval}, ${rg.baseInterval} - floor(Lv/${rg.levelDiv})) 手番ごとに 1 HP。追跡中の敵が見えない状態での wait（rest の各手を含む）は休息となり ${rg.restMultiplier} 倍の速さで回復する。**休憩と自然回復で戻るのは最大 HP の ${r.restCapPct ?? 100}% まで**（それより上は回復の薬・立て直し・泉・レベルアップ・キャンプでだけ戻る。HP は遠征の中で減っていく資源）。観測の self.rest_estimate に、その上限（cap_hp）までの手数・時間・その間の徘徊の目安が出る。
- 敵の HP は 4 段階でしか分からない: healthy（${b1}% 以上）/ wounded（${b2}% 以上）/ badly_wounded（${b3}% 以上）/ near_death（それ未満）。
- 敵の HP は個体ごとにダイスで決まり幅がある。接辞・深層強化（tier）で増え、守護者は通常の個体より大幅に頑丈。
- 目の前で倒した個体は最大 HP が分かり、種族ごとの「体力の記録」（recall）に残る（守護者は体力の記録と命中の記録に含めない。受けた最大の一撃には含める）。記録がある種族には、見た被害（damage_seen。見ている間に、その個体が受けた被害の合計。自分の攻撃のほか、罠やほかの敵の分も入る。遠征をまたぐと消える）と 4 段階表示から推定残り HP（hp_left_est）が付く。記録は標本であって種族の範囲ではないので「記録どおりなら残り 6〜8（記録 3 体: 体力 8〜8）」と書く。記録が ${r.estimateMinSamples} 体未満の間は下限だけ。
- 姿の見えない相手から攻撃されたときは、来た方向だけが分かる（「南東から飛んできた何かの射撃」）。
- threat(1-5) は「自分の現在 HP と、その種族から受けた最大の一撃」から見積もった危険度。その種族から攻撃を受けた記録が無ければ null（脅威: 不明（被弾の記録なし）。本当に初めて見た種族は「不明（初見）」）。worst_hit にその最大の一撃、worst_turn に 1 手番あたりの最悪の被害（worst_hit × 自分の 1 手番に相手が行動する回数。自分より速い相手は 2 回。ただし少しだけ速い相手は毎手番 2 回は動けない: 1 手番に 2 回動いたのを見た相手は、次に 2 回動けるまでの手番を 1 回と数える。速さ 120 と 100 なら 2 回の後の 3 手番は 1 回。fight の hp_risk も同じ数え方）。追跡中の敵の worst_turn、またはその合計が今の HP 以上なら alerts に lethal_range、合計の 2 倍が HP 以上なら lethal_2turns。
- 守護者の記録は種族の記録と分けて残る（体力・命中・最大の一撃。recall では「守護者の記録」）。
- 通りの記録: 自分の攻撃が当たったときの平均ダメージが種族ごと・近接と投擲に分けて残る（「近接の通り 平均 2.5／13 回」）。装甲そのものは出ない。
- 撃破の経験値は深いほど多い（深度 1 階ごとに +${r.xp.killDepthPct ?? 0}%）。
- 見れば分かる特徴は初見から出る: speed（自分の今の速さとの比較で slow / normal / fast。speed_ratio は倍率で、「遅い×0.8」はあなたの 1 手に 0.8 手）、size（small 小柄・large 大柄）、traits（pack 群れる・ranged 飛び道具・stationary 動かない・armored 重装＝素の装甲 3 以上・evasive 回避が高い＝素の回避 5 以上・rusting 錆びさせる＝当たると装甲が錆びる・pierce 装甲を抜く＝射撃が装甲を無視する・drain 血を吸う＝与えたダメージの分だけ回復する・heavy_swing 大振り＝隣の相手に 1 手構え、次の手番に構えたときに相手がいたマスを 2 倍で打つ。外れると 1 手朦朧）。look にも出る。体力・威力・回避・弱点は伏せたまま。
- 飛び道具（ranged）の敵は距離を取る: 寄られると下がり、下がる手番は撃たない。待ち受けると撃たれ続けるので、近づくか視線を切る。
- 命中の記録: 種族ごとに（守護者は守護者のその種族で別に）、ランを通して、自分の攻撃（近接・投擲を分ける）と相手から自分への攻撃の回数と命中が残り、visible.monsters の hits に出る（「この種族の記録: あなたの命中 近接1/6・相手の命中 3/5」。目の前の 1 体の数ではない）。確率そのものは出ない。
- 群れの被害見込み: 追跡中の敵が 2 体以上見えると alerts に incoming（追跡中の数・記録の最大被害の合計・記録の無い数・あなたの HP）。逃げ道: 追跡中の敵が見えていて既知の階段に辿り着けるとき、alerts に escape（最寄りの階段・経路長・あなたより速い追跡中の敵の数）。そのとき valid_actions の travel_to stairs_* に「階段まで 7 歩。追われたままなら最悪 6 の被害（追いつけるのは 1 体・射撃 0 体。HP 9）」が付く。最悪の被害は、敵ごとに「歩く間に攻撃できる回数 × 受けた最大の一撃」の合計: 射撃する敵は歩数、近接の敵は 切り上げ(歩数 × max(0, 敵の速さ ÷ あなたの歩く速さ − 1))、今隣にいる敵は +1 回（あなたの歩く速さは重い鎧の手番コストを入れる。同じ速さ以下の近接の敵は、隣にいても 1 回分だけ）。記録の無い敵がいれば不明。一番近い階段でもそれが HP 以上で綱を持っていれば、綱の候補が階段より前に並ぶ。
- 浅い階の群れは小さい: 群れの数は最大で 深度 + 1（地下1階は 2、地下2階は 3）。
- 転移の巻物: 着地点は元の位置から ${r.teleport.minDistance} マス以上離れ、追跡中の敵から見えないマスを優先する（無ければ距離だけ、それも無ければどこでも）。
- 経験値: 敵を倒す、新しい深度に初めて着く、遠征の目的を達成する。レベルアップの文に上がった最大 HP と、特技の候補が並ぶ。
- 騒音: 戦闘・扉の開閉は音を立て、近くの眠っている敵を起こすことがある。`,
    items: `# アイテム
- 武器・防具・装飾品（指輪・護符）: equip で装備。接辞（例: 鋭い = 命中+2）付きのものもある。
- 武器の特性: 速い（短剣。近接の手番コスト 70）、長柄（槍。直線で 2 マス先を attack）、薙ぐ（戦斧。対象と自分の両方に隣接する敵 1 体にも当たる）、砕く（鎚矛。当たれば 20% で 1 手番の朦朧）、扱いやすい（小剣。特別な効果なし）。
- 重い鎧（鱗鎧・板金鎧）: 歩く手番のコストが増え（110・125）、眠っている敵が起きやすい。
- 装飾品は未鑑定（外見名）で、効果は得失の組（例: 視界 +1・回避 −1）。装備すると正体が分かる。
- 呪い: 武器・防具・装飾品は生成時に ${r.curseChancePct ?? 0}% で呪われる。呪いは装備するか鑑定するまで見えず（呪われた品は必ず良い接辞も持つ）、装備すると外せない（同じ場所に別の品も付けられない・捨てられない）。所持品の行の「呪い?」は、まだ呪いの有無を確かめていない装備品。解呪の巻物か祭壇で解く（呪いの接辞が消える）。
- 自分の鑑定済みの持ち物は性能が分かる（所持品の行に「小剣[1d6・命中+1]」「投げナイフx8[投擲1d4+1・射程7・命中+1]」「鱗鎧[装甲3・回避-1]」。接辞込み）。self.attack.throws に投げられる物の命中（自分の命中込み）・ダイス・射程。鑑定済みの品には種類 ID（kind。所持品の行では投げられる物に {with:javelin}）が付き、fight の with にはスロットの代わりに種類 ID を渡せる（拾い物でスロット文字が変わっても同じ品を投げる）。
- 宝（treasure）: 使い道は無く、価値（value）だけを持つ。見えた時点で価値が分かる（「銀の杯（価値 180）」）。所持している間は戦利品に入り、帰還・撤退で換金される。所持枠を 1 つ使う。
- 薬・巻物は最初は未鑑定で、「赤い薬」のような外見名でしか分からない（外見と正体の対応はランごとに異なる）。使うと正体が判明する。鑑定の巻物・祭壇でも判明する。
- 未鑑定の薬には有害なもの（毒薬）もある。投げると対象に効果が及ぶ薬もある。
- 投擲武器（投げナイフ・投げ槍）は throw_item で対象（エンティティ ID か座標か方向）へ投げる。投げた物は着地点に落ちるので拾い直せる。
- 遺物（retrieve_relic の目的の品）は持っている間は効果を持たない。持ったまま階段の上で extract すると持ち帰れ、加護になる。
- 帰還の綱: 遠征ごとにキャンプが 1 本持たせる。use_item で使うと${r.lifeline.turns > 0 ? ` ${r.lifeline.turns} 手番後に` : 'その場で'}キャンプへ戻る（命と、目的を除く戦利品の ${r.lifeline.pct}% を持ち帰る。遺物は運べない。達成した遠征の数には入らない）。捨てる・投げることはできず、所持数に数えない。
- 地物: 泉（回復、1 回）、祭壇（所持品を鑑定し呪いを解く、1 回）。罠は見つけるまで見えない（隣接すると発見判定）。発見済みの罠は経路探索で避ける（罠を通る道しか無ければ、移動マクロは罠の手前で止まる。踏むなら move）。`,
    observation: `# 観測と turn ブロック
- 全応答の turn: state（your_turn / waiting_others / at_camp / expedition_ended / run_ended）、turn_no、reason、awaiting（action / camp_choice / nothing）、changes（前回の応答からの重要な変化）。テキストでは末尾の ▶ 行が同じ内容。
- changes のコード: new_hostile（このランで初めて見た個体。種族は既知でもよい）, reappeared（前に見た個体が再び見えた）, killed（あなたが倒した）, died_seen（目の前で倒れた）, hostile_gone（倒れた以外の理由で見えなくなった）, hp_dropped, hp_low, status_gained, status_lost, level_up, item_found, stairs_found, floor_changed, objective_progress, objective_complete, can_extract。alerts は「現在の状態」、changes は「前回からの差分」。
- 行動結果の outcome には、その行動から次の自分の手番までに受けた攻撃の回数・命中・合計ダメージ（HP の前後。間に回復があれば「回復 +N」）が必ず入る。
- summary: 1 行の現況。alerts: 重要度順の警告（enemy_adjacent, low_hp, critical_hp, incoming, lethal_range, lethal_2turns, escape, poisoned, on_stairs, item_here, inventory_full, new_floor, can_extract, at_camp など。incoming と escape には data に数値）。
- expedition: 遠征の目的・進捗・can_extract・extract_blocked_by・extract_outcome（今 extract したら complete=達成 / withdraw=撤退）。キャンプでは camp に次の遠征の候補。
- 手負いで逃げている敵には fleeing が付く。逃走中の敵は追跡中でも extract と休息を妨げない。
- self: HP・レベル・状態異常・位置・装備・所持品（brief は一覧の短縮形、full は詳細）・turns・speed（実効の速さ）・score（確定済みの点と達成した遠征の数）・rest_estimate（HP が減っているとき）。
- visible.monsters: id, 名前, 座標, 方向, 距離, hp_state, awareness(asleep/unaware/hunting), speed, size, traits, threat, first_seen, worst_hit, worst_turn, hits, dealt, role, damage_seen, hp_left_est, shot（clear: 投擲の経路が通る / blocked。応答の時点の判定で、敵の射撃も同じ経路の判定。間にいる別の敵が動く・自分が動くと変わる）, bounty（倒すと戦利品に入る賞金）。items（同じマスの同種は 1 行。自分が投げた物は全部で 1 行（本数と最寄りの位置）で mine、宝は value）/ players / features も同様。
- expedition.haul: 未確定の戦利品（total, multiplier_pct, parts, if_extract_now, if_lifeline_now, next_overreach, next_camp）。self.floor: draft（下への風）・explored（探索の進み具合）・trait_text（この階を作ったときに効いた条件の性質）。expedition.sense: 目標階にいる間の気配（守護者・遺物の方角と、10 マス以内かどうか）。camp.offers: slot（safe/standard/ambitious）, traits, multiplier_pct, recommended_level, level_gap, trait_danger, guardian（守護者の見込み: rank と特徴）, floor_traits（目的の階と通り道の階のうち、作られていて性質のある階）。
- 見えるものの「記憶しているアイテム」は近い順に 3 件まで（戦闘中は出さない）。残りは件数だけ（get_map で全体）。navigation.unsighted は地形は判明しているが、まだ見ていないセルの数。
- 休めないとき（追跡中の敵が見えている）は rest_estimate を出さない。
- navigation: here(足元), passable_dirs, frontiers(未探索との境界、近い順), known_stairs(既知の階段と到達可否・path_len)。
- map: 自分中心の 21×15 ASCII（フロア外は出さない）。上の 2 行が x 座標の 10 の位と 1 の位、行頭が y 座標。英字=モンスター（種族ごとに固定の 1 文字。凡例を参照） @=自分 #=壁 .=床 +=閉じた扉 '=開いた扉 >=下り階段 <=上り階段 ~=水 ,=草 %=背の高い草(視界を遮る) !=薬 ?=巻物 )=武器 [=防具 /=投擲 $=遺物 {=泉 _=祭壇 ^=罠 &=味方 (空白)=未知。凡例は地図と一緒に付く。
- valid_actions: 今できる行動の例。テキストは structuredContent の要約で、テキストにしか無い情報は無い。
- get_map で記憶している階全体の地図、look で対象の詳細（モンスターは「思い出」に基づく既知情報）、recall で種族ごとの思い出を引ける。
- プロフィール: new_run の応答の profile_token を保存し、次の new_run（join_run）の profile_token に渡すと、ランをまたいで記録が積まれる（省くと新しいプロフィールになる）。records で記録（ランの数・確定点の最高と平均・最深・倒した大守護者・死因・直近のラン）・図鑑（種族・鑑定した品・納めた遺物・守護者の型と弱点・断章・特殊部屋。「見つけた/全部」）・実績・次の節目が読める（キャンプの観測にも 1 行）。profile で表示名と進行中のラン。
- 継承: 図鑑で ${r.legacyMinKills ?? 5} 体以上倒した種族の知識（能力・体力の記録・受けた最大ダメージ・射程）は、次のランの開始時に「前の潜る者の覚え書き」として引き継がれる（recall・look に「覚え書きより」）。体力の推定と見込みに効く。引き継ぐのは種族の知識だけ（未鑑定の外見・守護者の弱点・地図・能力値・装備・加護は毎回ゼロから）。new_run { legacy: false } で継承しない。
- 実績: 遠征とランの終わりに、遠征のレポートと記録の値で判定し、プロフィールに残る（強さには影響しない）。名前はすべて見え、条件を伏せたものは取ると分かる。取った遠征の後のキャンプに「新しい実績」が出る。
- 振り返り: 遠征が終わった応答に、その遠征のレポート（戦闘・道具・進み・場面。12 行以内、JSON の report は全項目）が付く。集計するのは自分が見た出来事だけ。expedition は進行中なら途中経過（戦闘と進み）、キャンプなら直前の遠征のレポートを返す。review {expedition?} で終わった遠征のレポートを読み直せる（このランの前の遠征との比較と、全部の場面）。キャンプの観測には、直前の遠征の比較が 2 行まで出る。助言はしない（事実だけ）。`,
    season: `# シーズン（S0。new_run { season } で参加したランだけ）
- シーズンは、運用者が開く、同じシードのダンジョンに多くの参加者が挑む期間。参加者は、それぞれ自分のランで潜る（同じ世界に同席しない）。共有するのは、公開された階段と順位だけ。
- 参加: 運用者がそのシーズンに招いたプロフィールだけが参加できる。list_runs の seasons にある ID で new_run { season, profile_token }（profile_token は運用者から受け取ったもの。必須）。1 つのプロフィールが 1 人の参加者で、順位の表の名前は招かれたときの表示名。シーズンのランはソロで、シーズンのシード、Lv1 のキャンプから。継承は受けない。同じ参加者のシーズンのランは同時に 1 つ。倒れたら、同じ profile_token で、同じシーズンの新しいランを Lv1 から始められる（予算は続きから）。
- 行動予算: 参加者 1 人につき、シーズンを通して自分の手番の数で持つ（ランをまたいで 1 つ。倒れてやり直しても戻らない）。迷宮の中の自分の手番だけを数え、マクロの中の手番も 1 つずつ。キャンプでは減らない。残りは観測にいつも出る。
- 時間切れ: 予算が尽きた手番の終わりに、その遠征は時間切れで終わる。キャンプへ戻され、未確定の戦利品は失う（持ち物は残る）。倒れた扱いにはしない。その後は新しい遠征を始められない（キャンプでの操作と報告はできる）。帰る分の手番を残しておくこと。
- 階段の位置は、だれのランでも同じ。報告: キャンプで report_stairs（手番を使わない）。このランで自分の目で見た下り階段のうち、まだ報告していないものを全部送る。その階の下り階段を最初に報告した 1 人に貢献 1（サーバーに届いた順）。倒れると、そのランで報告していなかった階段は報告できなくなる。
- 公開された階段: キャンプに着いたときと遠征を始めるときに取り込む。公開されている階に入ると、下り階段のマスがはじめから地図に載る（公開した者の名前つき）。途中の道は分からない（travel_to stairs_down は道が分かるまで届かない。下への風は自分の目で見るまで出るので explore { toward: 'draft' }）。遠征の途中で公開されたものは、次の遠征から。
- 賞（称号は無い。結果の記録に残る）: 冒険賞＝シーズンで着いたいちばん深い階（着いた時点で数える。帰れなくてもよい）。貢献賞＝最初に報告した階段の数。生還賞＝シーズンで一度も倒れていない者の、確定した点の合計。同着は、使った予算の少ないほうが上（冒険はその階に着いたとき、貢献は最後の 1 つを報告したとき、生還は使った予算の合計）。時間切れは倒れた扱いにしない。
- 順位は、キャンプの観測に賞ごとの 1 行で出る（自分の値と順位、1 位の名前と値、1 位との差）。迷宮の中では予算の残りだけ（順位はキャンプで取り込んだものが、その遠征の間の最新）。
- 終わりの時刻を過ぎたら、新しい遠征は始められない。出ている遠征は、帰るか倒れるまで続けてよい（その分も数える）。`,
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
- When you die you leave the run and lose everything you carry (equipment, items, the lifeline) and that expedition's haul. Nothing is dropped where you fell, and in co-op nothing passes to your allies; the others can go on with the run.
- Score (version 2) = total banked points. Points earned during an expedition are an unbanked haul that only counts once you bring it back (extract); dying loses that expedition's haul (see get_rules expedition). The record keeps how many expeditions you completed.
- Floors are procedurally generated from a seed; depth is unbounded. Deeper monsters gain tiers and affixes.
- You only know your field of view (~radius 8) and the map you remember. Unexplored terrain and unseen monsters are never included.
- Speed-based turns (normal 100). Floors without players are frozen in time, except that guardians and wardens heal ${r.guardianAwayHealPct ?? 2}% of their max HP per turn while they are not chasing you (while you are off the floor, and on the same floor once they lose you and give up the search; applied at once when you next see them, when they resume the hunt, or when you return; a few turns behind cover do not count). At full they settle: back to their post, no hunting, statuses and rage gone, summoned minions leave, and a deep sleeper goes back to sleep. Going back to camp heals and settles every guardian. Stepping away briefly to drink a potion or use a fountain still works (ordinary enemies do not heal).
- Invalid actions change nothing and cost no time; errors include code/message/hint and valid_actions.
- Each valid_actions line reads "<tool> [<main arg>] [<name>:<value> ...] (<note>)" and can be called as written. The main arg is one per tool (dir for move/interact, target for fight/attack, to for travel_to, slot for use_item/equip/throw_item, ability for use_ability). <a|b> means pick one; [a,b] and a,b are lists (arrays, or the string as written). A note starting with "unavailable" means not usable now.
- Use the notes tool for your own memos. The optional thought argument on action tools is shown to spectators.
- Lingering on a floor attracts wandering monsters (every ${r.wander.intervalMin}-${r.wander.intervalMax} floor time; the exact next time is hidden).
- Some floor types have no monsters (sanctuary: a resting floor that appears at intervals in the depths, with no monsters or wanderers).
- new_run without objective starts at camp, where you choose the first expedition from 3 offers. Passing objective starts it directly (reach_depth = safe slot / slay_guardian = standard slot / retrieve_relic = ambitious slot / endless / auto = the first offer). Later expeditions are chosen from 3 offers at camp.`,
    expedition: `# Expeditions
- Objective types: reach_depth (cross the target depth = stand on its down stairs; arriving is not enough), slay_guardian (slay the guardian there), retrieve_relic (pick up the relic there and carry it out), slay_bounty (slay the bounty there: a named elite whose kind, affixes, name, HP estimate and biggest hit are on the offer), open_vault (open the locked vault there; one monster on that floor carries the key; done the moment it opens), endless (no objective).
- Deep objectives: a slot whose target is deeper than depth 6 and would be reach draws evenly from reach, bounty and vault instead (no reach right after a reach expedition). A bounty you left alive stays for that expedition and may come back on the next offers as a rematch (same name and affixes)
- The guardian's rank comes from the slot: safe rank 1 (upper half of the depth's candidates, no kiting shooters, HP +${r.guardianRanks?.[0]?.hpPct ?? 50}%, one type; safe relics are unguarded), standard rank 2 (upper half of the candidates one depth deeper, +${r.guardianRanks?.[1]?.hpPct ?? 100}%, one type), ambitious rank 3 (upper half two depths deeper, +${r.guardianRanks?.[2]?.hpPct ?? 150}%, one type). Offers show the guardian's name and type (title) and a forecast (rank and fast / slow / ranged / large / armored, the hit estimate and an HP estimate); the species stays hidden until you meet it. The HP estimate is "the average of the species' HP dice x (100 + the rank's bonus)%", at least ${r.guardianRanks?.[0]?.minHpBase ?? 6} + ${r.guardianRanks?.[0]?.minHpPerDepth ?? 2} x depth for rank 1 and ${r.guardianRanks?.[1]?.minHpBase ?? 10} + ${r.guardianRanks?.[1]?.minHpPerDepth ?? 3} x depth for ranks 2-3 (the real one varies with the dice). Offers add the range ("about 20 HP (9-32)": the same calculation on the lowest and highest roll of the HP dice; bounties use the same form, without the rank bonus or the floor). A type never comes with the weakness it cancels (no "weak to thrown" on a Deflector, no "deep sleeper" on a Stalker). The list of types is under "Guardian types" in get_rules topic=classes.
- Heavy blows: guardians of rank 2+ and wardens hit through armor: armor (and bracing) can cut each hit by at most half (damage = max(hit - armor, half the hit rounded up)). Rank 1 guardians, normal monsters and named elites are unchanged. Offers show "armor cannot bring it below N" and the monster line shows heavy blow.
- Each guardian has one weakness (weak to poison / weak to thrown weapons / a deep sleeper / slow in water). It is hidden; seeing it work reveals it, and look and the observation then show it.
- Intents: an enemy about to make a big move next turn (bracing to charge / about to call minions / about to rage) shows it in the observation's intent and in alerts while you can see it. A charge shows its direction and whether you stand on that line (on_line). Movement, fight and rest macros stop when a visible enemy newly shows an intent (intent).
- Guardian and relic locations are not revealed; observations mark them with role: guardian / relic.
- A guardian keeps the place it was put as its post and, while unaware, stays near it (by the relic for a guarded relic). It hunts like any other monster, and once it loses you and ends its search it goes back to its post.
- When an expedition starts, unslain guardians (not wardens) and named elites that are not its objective leave their floors (changes tells you if you met them; the floor-event text of an elite's floor goes too). The target of a rematch offer (the same guardian or bounty as the objective again) stays.
- Scars: a rematch target does not heal fully at camp; a quarter of the damage you dealt last time stays (up to half its max HP). The offer shows "scars: -N HP"
- Extract (complete): objective done and standing on any stairs (up or down). Hunting enemies in view do not prevent it (monsters never follow you between floors). The expedition ends as completed.
- Withdraw (extract confirm: true): same conditions without the objective; you survive and the expedition ends as withdrawn.
- Lifeline: camp gives each participant exactly one at the start of every expedition (extras are trimmed; none can be found in the pit; it cannot be dropped or thrown and does not count toward capacity). use_item it to return to camp${r.lifeline.turns > 0 ? ` after ${r.lifeline.turns} helpless turns (you still take hits)` : ' at once'}. It banks ${r.lifeline.pct}% of the haul without the objective (even if the objective is complete; objective points are banked only by extracting on stairs). A carried relic cannot come along and is lost; a slain guardian stays dead; the next offers' depth does not rise. The expedition ends as lifeline.
- Four outcomes: stairs + complete (haul x multiplier) / lifeline (${r.lifeline.pct}% without the objective) / stairs withdrawal (${h.withdrawPct}% without the objective) / death (0, the run ends).
## Haul and banked points (score version 2)
- Run score = total banked points. Everything earned during an expedition is an unbanked haul, settled on extract:
  - Completed (objective done, extract): haul x the offer's multiplier
  - Withdrawn (extract confirm): (haul - objective points) x ${h.withdrawPct}%
  - Lifeline: (haul - objective points) x ${r.lifeline.pct}% (no multiplier, even if complete)
  - Died / retired: 0 (recorded as lost)
- Haul parts:
  - objective: the offer's base points on completion (slot base x type factor x depth factor; see Offers)
  - crossing (overreach): when you cross a floor deeper than the target and **stand on its down stairs** (arriving is not enough): the n-th pays objective points x (${h.overreachPct.first} + ${h.overreachPct.step}*(n-1))%, at least ${h.overreachFirst} + ${h.overreachStep}*(n-1). You may still extract on the arrival stairs (an escape route, not a reward)
  - treasure: value of treasure items you carry (drop one and it is gone; cashed in and removed on extract)
  - bounty: slaying a guardian (${h.guardianBounty.base} + depth*${h.guardianBounty.perDepth}); shown as bounty. Guardians always drop a treasure
  - discovery: first time this run you kill a species +${h.discovery.species} / learn what an item known only by its look is +${h.discovery.identify} (by using or identifying it; checking gear for curses does not count) / first sight of a special room +${h.discovery.room} / reading an inscription +${h.discovery.inscription}
  - Special rooms ("Found: ..." when you first see one): locked vault (2-3 treasures; the locked grate can be seen through but not passed; a monster on the floor carries the key, shown as "carries the vault key" in visible.monsters, and drops it; interact next to the grate with the key to open it, using up the key), hall of inscriptions (reading one gives a fragment of the record and one clue: a guardian's weakness on this floor, else where a locked vault is, else what one unidentified item is), shrine of chance (pray once; look shows the table and its chances), guard post (4 sleeping monsters and a treasure), abandoned camp (consumables and a note; common on shallow floors), fallen library (scrolls, and a monster awake among the shelves)
  - Floor events: standard floors and caverns get one ${r.floorEventPct ?? 25}% of the time. On arrival only what you can sense shows in self.floor.event_text ("this floor:" in the status line, e.g. "This floor lies utterly still"); find out the rest yourself
  - Named elites: from depth ${r.elite?.minDepth ?? 3}, ${r.elite?.chancePct ?? 3}% of ordinary monsters are elites with ${r.elite?.affixes ?? 2} affixes, a name and a bounty (visible.monsters: elite "name", bounty N, always drops treasure; look shows what the affixes do)
  - Clues for unidentified items: potions and scrolls carry a sensory clue shared by two kinds. Carry one for ${r.clueTurns ?? 30} turns (a scout notices at once) and the clue shows in inventory and the inventory line (narrowing it down to two)
  - First sights: the first time this run you see a species, feature or biome, changes (first_seen) give a one-line description once (look shows it later)
  - Biome rules: stone halls and the sunken archive have grates linked to levers (interact with the lever to close or open; a closed grate can be seen, thrown and shot through, but nobody passes; good for cutting off pursuit). Damp caves: entering shallow water costs 150 and noise from water carries twice as far; a brittle ceiling falls when a loud noise (a thrown item landing, a fight, a monster opening a door; not you opening a door) happens within 3 cells, dealing 2d6 within 1 cell and leaving rubble below. Overgrown ruins: anyone in tall grass can only be seen from next to it and stays hidden even when it attacks (you and monsters alike); when shot from the grass you learn only the direction (no name or position, and it is not in the worst-damage estimates); a spore pod bursts when poked (interact) or hit by a throw, poisoning everyone within 1 cell and leaving a poison cloud for 3 turns. Sunken archive (from depth 6): bookshelves block the view and can be pushed (move) when the cell beyond is free floor (cost 150); reading a loose page reveals the layout within 10 cells
  - kills: species XP x ${h.killPerXp} x depth factor (${x.depthPct.base} + ${x.depthPct.perDepth}*depth %), x ${h.killAffixPct}% with affixes (a cave rat is about 6; stronger species pay more)
  - large species and affixed individuals always drop a treasure (guardians too)
- expedition.haul shows parts, total, multiplier, if_extract_now (banked if you extract right now), if_lifeline_now (banked if you use the lifeline now), next_overreach (the depth whose down stairs pay next, with path_len when known, or dir = the draft when not found yet) and next_camp (where the next offers would start if you extract now; counted from the deepest target you have achieved, so crossings do not push it deeper) every time. self.score shows your banked points.
- Draft: until you have seen the current floor's down stairs, self.floor.draft gives their 8-way direction (no distance). self.floor.explored is how much of the floor's walkable cells you have seen, in 4 steps (1 about a quarter, 2 about half, 3 about three quarters, 4 nearly all).
- In COOP the haul (except treasure) is shared by the party and paid to each player who extracts. Treasure belongs to whoever carries it.
## Pressure after the objective
- For slay_guardian and retrieve_relic, from the moment the objective is done until the expedition ends, the wanderer spawn interval becomes ${r.afterObjectiveWanderPct}% (changes says the pit grows restless). reach_depth has no such pressure.
- Picking up the relic wakes sleeping/unaware monsters on that floor and sends them toward it (pickup on a relic says the floor wakes).
- Milestone wardens: every depth that is a multiple of ${r.milestone?.every ?? 5} is a warden's hall (a small floor: an antechamber and a hall) with a warden (two types, one weakness). Its stairs down stay sealed until it falls (standing on them is no crossing). If an uncleared milestone floor has no warden (say, it was made by an older version), it is rebuilt as a warden's hall when an expedition starts (your map and memories of it are cleared, and items left on it are lost). Slaying it gives a large bounty and a choice of 1 of ${r.milestone?.boonOptions ?? 3} boons (choose_boon; takes no turn; alerts: boon_pending). The next milestone is always shown at camp and in expedition.
- Milestones and offers: slaying a warden can be the objective (slay_warden, "challenge the milestone"; scored like a rank-3 guardian at that depth; extract on either the hall's or the antechamber's stairs). Targets past an uncleared milestone appear only in the ambitious slot (safe and standard never pass it). If the standard target would reach the milestone it becomes "challenge the milestone"; if the safe target would, it becomes a rank-1 guardian one floor above (build up). A warden's HP is "the species' HP x (100 + ${r.milestone?.hpRule?.hpPct ?? 250})%" kept between ${r.milestone?.hpRule?.minHpBase ?? 20} + ${r.milestone?.hpRule?.minHpPerDepth ?? 6} x depth and ${r.milestone?.hpRule?.maxHpBase ?? 40} + ${r.milestone?.hpRule?.maxHpPerDepth ?? 10} x depth; the offer shows that range ("HP 50-90"; the archive's memory gives the exact value). A warden's speed never drops below ${r.milestone?.minSpeed ?? 100} (a slow species is not slow as a warden). Challenging the milestone adds +${r.milestone?.levelBonus ?? 2} to the recommended level; passing it uses the larger of the target's and the warden's level and adds danger +1. Completing the same target depth again scales its base by ${r.expedition.repeatPct ?? 50}% each time, down to ${r.expedition.repeatMinPct ?? 25}% (the offer says "attempt N at this depth"). An expedition ended on the sealed stairs down of a warden's hall (or whose lifeline would return there) starts the next one from that floor's stairs up.
- Relics and boons: each relic has a name and a boon, shown in the offer (drawn from boons the party does not have yet). Complete the expedition and carry the relic out on stairs and it becomes a boon on that character for the rest of the run (not by lifeline). Boons are in self.boons; the list is under "Boons" in get_rules topic=classes.
- Sense: on the target floor, expedition.sense gives the direction (8-way) to the unslain guardian or untaken relic and whether it is within 10 cells. The exact position is not given until you see it.
## Offers at camp
- Three slots. Target depth = deepest achieved target + range (crossings do not push it deeper; they scout the next target. First expedition: safe depth ${x.firstTargetDepth.safe}, standard ${x.firstTargetDepth.standard}, ambitious ${x.firstTargetDepth.ambitious}). Each slot has a different objective type (no crossing objective for a floor whose down stairs you have already stood on). If the target floor already exists, the guardian/relic is placed when the expedition starts:
  - safe: +${sl.safe.aheadMin}-${sl.safe.aheadMax}, ${sl.safe.traitsMin}-${sl.safe.traitsMax} traits, slot base ${sl.safe.base}
  - standard: +${sl.standard.aheadMin}-${sl.standard.aheadMax}, ${sl.standard.traitsMin}-${sl.standard.traitsMax} traits, slot base ${sl.standard.base}
  - ambitious: +${sl.ambitious.aheadMin}-${sl.ambitious.aheadMax}, ${sl.ambitious.traitsMin}-${sl.ambitious.traitsMax} traits, slot base ${sl.ambitious.base}
- The slots (safe / standard / ambitious) stand for how far the target is and how big the reward is. Read the danger from each offer's forecast (recommended level gap, biggest hit, per-hit damage): within one slot it varies a lot with the objective type and the foe's kind and armor. Guardian offers (rank 1-3, rematches too) and bounty offers show estimates of HP, biggest hit and armor plus "per hit with your gear" (about how many hits it takes). The armor estimate comes from the kind, affixes and depth (type effects excluded).
- Offer points = slot base x type factor (reach ${x.typePct.reach_depth ?? 100}%, guardian ${x.typePct.slay_guardian ?? 100}%, relic ${x.typePct.retrieve_relic ?? 100}%, guarded relic ${x.typePct.retrieve_relic_guarded ?? 100}%, bounty ${x.typePct.slay_bounty ?? 100}%, vault ${x.typePct.open_vault ?? 100}%) x depth factor (${x.depthPct.base} + ${x.depthPct.perDepth}*target depth %). Always safe < standard < ambitious.
- Traits are public modifiers. Their multipliers apply to the haul on completion (multiplied together). There are two kinds: some work only during that expedition (restless, dim, quiet's "no wanderers"), others work when a floor is made (crowded, scarce, quiet's "no fountains"). The second kind only affects floors down to the target that have not been made yet (floors you enter for the first time), and stays with those floors for good (floors you visited on earlier expeditions keep their monsters, loot and fountains):
${traitsLines(r, false)}
- A floor remembers the traits it was made under. On arrival and in self.floor.trait_text ("this floor:" in the status line) you see e.g. "crowded (more monsters and treasure)". Offers list, in one line, the target and on-the-way floors that already exist and have such a trait ("on the way, depths 13-16 are crowded"; floor_traits; nothing is said about floors not made yet). A crowded floor among them raises the offer's danger (trait_danger) as much as the crowded trait would (no multiplier). Traits that only work when a floor is made (crowded, scarce) are only offered when the target floor has not been made yet
- Offers show the recommended level, your gap to it (level_gap = recommended - yours) and the sum of trait dangers (trait_danger). Recommended levels come from a public table (depth 1-${r.recommendedLevel.byDepth.length}: ${r.recommendedLevel.byDepth.join(', ')}; deeper depths extend the last 4-depth slope). No hidden information is used.
- new_run without objective starts at camp, so you choose the first expedition from 3 offers too.
## Other
- After completing or withdrawing you are at camp: time does not pass, HP is restored and statuses cleared. Choose the next of 3 offers with start_expedition { offer } (you restart from the stairs you extracted on; after a lifeline, from where that expedition began). While you are at camp every floor that has been made settles: monsters stop hunting, heal fully and lose their statuses (your damage_seen for them is cleared too; guardians' and bounties' scars stay). On the restart floor, any that can see the restart cell move far away (chipping and leaving does not pay). You may stop instead and resume_run later.
- A disconnect does not end an expedition; resume_run continues it.
- Every observation includes expedition (objective, progress, can_extract).`,
    actions: `# Actions
Turn-consuming: move{dir} / attack{target} / wait{turns?} / rest{until_hp?,max_turns?} / explore{mode?,hp_floor?,pickup?} / travel_to{to,mode?,hp_floor?,pickup?} / collect{what?,within?,kinds?,all?,mode?} / fight{target,with?,hp_floor?,abilities?} / use_ability{id,target?,slot?} / pickup{item?} / drop{slot,qty?} / equip{slot,confirm?} / unequip{slot} / use_item{slot,target?,target_slot?} / throw_item{slot,target} / interact{dir?} / use_stairs / extract{confirm?}
At camp: start_expedition{offer} / retire
Free: choose_perk{option} / observe / wait_for_turn / expedition / review / records / profile / look / get_map / inventory / recall / get_messages / notes / say / set_options / get_rules
- Directions: n ne e se s sw w nw. Origin is top-left; x grows east, y grows south.
- move attacks a hostile in that cell, opens a closed door (without moving), or swaps with an ally.
- attack{target}: melee an adjacent enemy, or with a reach weapon (spear) one 2 cells away in a straight line (the cell between must be open and empty). fight also strikes from 2 cells with a reach weapon.
- use_ability{ability,target?,slot?}: abilities (get_rules classes; ability may also be given as id). choose_perk{option}: pick your level-up perk (takes no turn).
- Principle: one call, one decision. When a macro cannot take a single step it is refused without spending a turn, with a reason (hostile_adjacent / hostile_in_view / hp_floor / blocked / nothing_to_do ...).
- explore: macro that walks to the nearest unseen area (max ${r.macroStepLimit} steps). With pickup (default 'useful') it also picks up the useful items on the way and known items (not the relic, not identified harmful items except those you can throw such as poison, not same-kind gear that is no better; 'useful' also skips identified gear without affixes whose public number is no better than what you wear: armor value for armor, average damage for weapons, compared across kinds; true picks up everything else too, false nothing; not when full). toward: 'draft' prefers unexplored areas in the draft's direction, 'sense' in the direction of the relic or guardian you sense ('sense' stops once this expedition's relic or guardian is in view or remembered; go there with travel_to). Areas known only from a mapping scroll still count as unseen.
- Movement macros (explore, travel_to, collect) stop with no_progress when they bounce between the same two cells (change the goal or the route). travel_to also stops with no_progress when the way to its goal has not got shorter for 20 steps.
- travel_to: macro to {x,y}, "stairs_down", "stairs_up" or an entity id over the known map; if the destination is an item it picks it up. Known stairs carry path_len.
- Movement macro mode (explore / travel_to / collect):
  - collect (what: items) and travel_to an item: when they stop on the turn they reach the item's cell, they pick it up first (one turn) unless the reason is hp_floor, hp_risk or an intent. travel_to also takes a feature id (visible.features id); a feature counts as reached once you are next to it.
  - careful (default): stops on a species you have never seen, a hunting (not fleeing) enemy that can reach you appearing, a visible monster starting to hunt, being attacked (even if missed), non-poison damage, a status, HP crossing 50% / 25%, stairs found (explore). Known species asleep/unaware, stationary monsters not adjacent, poison ticks and items found do not stop it (they appear in changes). It will not move while an awake non-fleeing enemy is adjacent.
  - steady: stops when a hunting enemy is adjacent, a never-seen species appears, HP falls below hp_floor (default 50% of max), you first see the floor's down stairs, or the damage taken during the call (poison included) passes a quarter of your max HP (damage_taken). For moving on through weak shots or poison.
  - flee: stops on arrival, a blocked path or HP below hp_floor (default 25%, or 0 if you start below it). Moves even with enemies adjacent (a retreat; every attack taken shows in the result).
  - Every mode walks with ordinary moves and enemies attack as usual. Macros never attack (an enemy in the next cell stops them: blocked). valid_actions only lists modes that can move right now.
  - careful and steady also stop when you first see the floor's down stairs (where the crossing decision starts). Paths avoid cells next to visible stationary monsters like traps (unless there is no other way).
- fight{target,with?,hp_floor?,abilities?,until?,adjacent?,approach?}: settle it with that target. approach (no with): 'wait' (default) waits for a hunting target out of reach to come adjacent; 'advance' walks up to it and attacks once adjacent (getting shot on the way does not stop it; hp_floor, hp_risk, new enemies, intents and the other stops still apply; target_moved after 3 turns without getting closer; for enemies that stand and shoot). until: 'clear' keeps going after the target falls, to the hunting enemies in reach (an adjacent one first, otherwise the nearest; not fleeing ones), and ends when none is left (cleared). adjacent sets what a throwing fight does when the target becomes adjacent (stop: stop, the default / throw: keep throwing / melee: switch to melee). List abilities (bash, cleave, aimed_throw) in abilities and fight uses each whenever it is ready (bash when the target is adjacent, cleave with 2+ awake enemies adjacent, aimed_throw when the with item has range and a clear line; otherwise a normal attack). second_wind and slip cannot be carried. Without with: keep attacking it in melee; while it is hunting you but not adjacent, wait until it is (max 10 turns; stops with target_not_approaching after 3 turns without it closing in, and with hit_and_run if it hits you while you wait but is not adjacent, or target_shooting if it shot you from where it stands); a hit-and-run target hunting within 2 cells is waited for up to 2 turns (never chased). With a slot or an item kind in with: fight by throwing that item, waiting until it is in range with a clear line. An array in with (["javelin", "throwing_knife"]) moves on to the next item once one runs out and none can be picked back up. collect_after: true picks your throws back up after the fight is settled (target down, or cleared with until: 'clear') if no hunting enemy is in view (same stops as collect). Stops when it falls, moves away / flees out of range, (with) it becomes adjacent, the item runs out, or the line is blocked 3 turns in a row, your HP is at or below hp_floor (default 50%), **one more turn of the worst damage from hunters in reach (adjacent or ranged) would drop you below hp_floor (stops before being hit: hp_risk)**, you take a first hit from a creature with no record (first_hit, once; only if it costs ${r.fightFirstHitStopPct ?? 15}%+ of your max HP, smaller ones are recorded and the fight goes on; a species you have killed ${r.fightRecordedKills ?? 3}+ times counts as recorded), a hunting enemy of a species with no hit record appears (a recorded species does not stop it), another enemy shoots you while you wait (shot_while_waiting), another enemy next to you hits you while you wait (hit_while_waiting; with until: 'clear' it switches to that enemy instead), you get a status (not one that only modifies stats, such as rust), or the target flees out of sight (target_fled). A hunting target that is not fleeing and slips out of sight is waited for up to ${r.fightLostWait ?? 5} turns (then target_gone). It never waits for sleeping/unaware targets (approach with travel_to or open with throw_item). The result reports swings, hits and damage both ways.
- wait{turns?}: wait one turn. With turns (2-10) it keeps waiting, stopping when a monster appears, one becomes adjacent, or you are attacked / take non-poison damage.
- rest: waits until HP is full and poison is gone, or until until_hp / max_turns (max ${r.restMaxTurns} turns). It stops when any monster comes into view (but not when an already-seen fleeing monster wanders in and out). Stationary monsters do not block resting unless adjacent.
- throw_item at an entity id is refused with no_line_of_sight when the path is blocked and out_of_range when it is too far (no turn, no item lost; shots in visible.monsters gives clear / blocked / out_of_range per item). A position target is refused the same way when it is out of range or the path is blocked. Throwing in a direction lands at the end of the range or where it is blocked. The result always says hit / missed / blocked / fell short and where it landed.
- Items you threw are picked up just by stepping on them (free). collect visits your known thrown items (what: thrown, default) or known items (what: items) in order. within caps the walk (default 15; it stops with collect_far when everything left is farther), kinds limits what to fetch (item ids or categories, e.g. ["potion", "javelin"]). what: items skips identified gear that is worse than what you wear (all: true fetches it anyway). Items on the path are picked up by stepping on them even if not in kinds. While thrown items are still on the floor, the extract, stairs and lifeline lines in valid_actions add "N of your thrown items are still on this floor" (it does not stop you). A throwing fight's result ends with "throws: in hand N, on the floor M (K under enemies)"
- use_item target_slot: the item an identify scroll identifies. Without it, the first unidentified item or equipment whose curse is unchecked, by slot order (other than the scroll's own kind).
- use_item slot also takes the kind id of an identified item (e.g. "potion_healing"; the first slot of that kind). equip of gear known to be cursed needs confirm: true (it will not come off).
- set_options: response verbosity (map auto/always/never, inventory on_change/always, status_line short/long). No game effect.
- observe returns immediately; use wait_for_turn to wait for your turn (COOP).
- Inventory slots are letters a-z. Equipped items stay in the inventory.
- use_stairs uses the stairs underfoot. You cannot go above depth 1 (leave with extract). Monsters do not follow you up or down stairs.
- retire ends the run (the character does not come back). To end only the expedition, extract.
- Pass expect_seq (the seq of the observation you acted on) to get stale_turn instead of double-acting.`,
    combat: `# Combat and recovery (integers only)
- To hit: d20 + acc >= 10 + target eva. Natural 20 always hits and crits; natural 1 always misses.
- Critical hit: the damage dice roll their maximum (plus might) and armor is ignored. The biggest hit you have seen is the worst case for that species.
- +5 to hit sleeping targets; attacking wakes them.
- Melee damage: weapon dice + might - armor (min 1). Thrown: thrown dice - armor (min 1). Reported damage is the HP actually lost (overkill excluded; the killing-blow line shows the intended damage and the HP that was left, e.g. "6 damage (killing blow; it had 5 left)"; fight totals count HP actually lost).
- Proficiency: each class has melee and thrown accuracy modifiers (warrior thrown -2, scout thrown +2; get_rules classes). Equipment "melee acc" / "thrown acc" add to them.
- Statuses: poison (1 dmg/turn), rusted (armor -2, never below 0, 10 turns; does not stack, a new hit only refreshes it), haste (x2 speed), slow (x0.5), sleep (helpless, damage wakes), stunned (helpless; bash, mace), evasive (melee misses you until your next turn), braced (the first hit before your next turn meets more armor), cowed (flees at more HP; intimidate)${r.lifeline.turns > 0 ? ', recalling (lifeline; helpless, then back to camp)' : ''}. Processed at turn start. A monster killed by poison counts as killed by whoever poisoned it (bounty, kill points, XP). While your poison works on something out of sight you learn nothing about it; only its death is reported ("something fell to your poison").
- Level up at total XP = 15*Lv^2: more max HP and one perk of your choice (choose_perk; get_rules classes).
- Potion of healing (identified): heals 2d8+4 HP, never less than 30% of max HP, and cures poison.
- Regeneration: 1 HP every max(${rg.minInterval}, ${rg.baseInterval} - floor(Lv/${rg.levelDiv})) turns. wait with no hunting enemy in view (each rest turn too) counts as resting and regenerates ${rg.restMultiplier}x faster. **Rest and natural regeneration only heal up to ${r.restCapPct ?? 100}% of max HP** (above that only potions, second wind, fountains, level-ups and camp heal; HP is a resource that wears down over an expedition). self.rest_estimate shows turns/time to that cap (cap_hp) and expected wanderers.
- Monster HP is shown in 4 bands: healthy (>= ${b1}%), wounded (>= ${b2}%), badly_wounded (>= ${b3}%), near_death (below).
- Monster HP is rolled per individual; affixes and tiers raise it, and guardians are far sturdier.
- When you see a monster die you learn its max HP; recall keeps an HP record per species (guardians are left out of HP and hit records, but count toward the worst hit). For recorded species, observations include damage_seen (the damage you saw it take while in view: yours, traps' and other monsters'; cleared between expeditions) and hp_left_est, phrased as "if typical" because the record is a sample, not the species range (lower bound only until ${r.estimateMinSamples} are recorded).
- When an unseen attacker hits you, you learn the direction it came from.
- threat (1-5) is estimated from your HP and the biggest hit you have taken from that species; null if it has never hit you ("unknown, first sighting" only for a species you have truly never met). worst_hit shows that biggest hit and worst_turn the worst damage per turn (worst_hit x how many times it acts in one of your turns; 2 if it is faster, except that a slightly faster enemy cannot act twice every turn: once you saw it act twice in one turn, the turns until it can do so again count as 1; for speed 120 vs 100, the 3 turns after a double. fight's hp_risk counts the same way). alerts carry lethal_range when a hunting enemy's worst_turn, or their sum, is at least your HP, and lethal_2turns when twice the sum is.
- Guardians have their own record, separate from the species (HP, hits, worst hit; recall shows it as the guardian record).
- Damage records: the average damage of your hits per species, melee and thrown separately ("melee avg 2.5 over 13"). Armor itself stays hidden.
- Kill XP grows with depth (+${r.xp.killDepthPct ?? 0}% per depth).
- What you can see is shown from the first sighting: speed (slow / normal / fast compared with your current speed; speed_ratio gives the factor, "slow x0.8" = 0.8 moves per move of yours), size (small / large) and traits (pack, ranged, stationary, armored = base armor 3+, evasive = base evasion 5+, rusting = its hits rust your armor, pierce = its shots ignore armor, drain = heals by the damage it deals, heavy_swing = braces for a turn next to you, then strikes the cell you were on for double damage; a miss stuns it for a turn). look shows them too. HP, power, evasion and weaknesses stay hidden.
- Ranged enemies keep their distance: when approached they back off, and they do not shoot while backing off. Waiting for them means being shot; close in or break line of sight.
- Hit records: per species (guardians of a species are kept apart) over the whole run, your attacks (melee and thrown separately) and its attacks on you, as hits/tries in visible.monsters hits ("this species' record: your hits melee 1/6, its hits 3/5"; not the count for the one in front of you). No probabilities are given.
- Pack danger: with 2+ hunting enemies in view, alerts carry incoming (how many, the sum of their recorded worst hits, how many have no record, your HP). Escape: with hunting enemies in view and known reachable stairs, alerts carry escape (nearest stairs, path length, how many hunters are faster than you), and the travel_to stairs_* candidates say "7 steps to the stairs. If they keep chasing you, worst 6 damage (1 can catch you, 0 shooting; HP 9)". The worst damage sums, per enemy, the attacks it gets while you walk x its worst hit on you: a shooter gets one per step; a melee enemy gets ceil(steps x max(0, its speed / your walking speed - 1)), plus 1 if it is adjacent now (your walking speed includes heavy armor's move cost; a melee enemy no faster than you gets 1 at most, and only if adjacent). Unknown if one has no record. If even the nearest stairs could cost your HP and you hold the lifeline, the lifeline candidate is listed before the stairs.
- Packs are small on shallow floors: at most depth + 1 (2 on depth 1, 3 on depth 2).
- Teleport scroll: prefers a landing cell at least ${r.teleport.minDistance} cells away that no hunting enemy can see (then distance only, then anywhere).
- XP comes from kills, first arrival at a new depth and completing an expedition objective. Level-up messages list the max HP gained and the perk options.
- Noise from combat and doors may wake nearby sleepers.`,
    items: `# Items
- Weapons, armor and accessories (rings, amulets): equip them. Some have affixes (e.g. keen = +2 acc).
- Weapon traits: quick (dagger; melee costs 70), reach (spear; attack 2 cells away in a straight line), sweep (war axe; also hits one enemy adjacent to both you and the target), crush (mace; 20% to stun for 1 turn on a hit), balanced (short sword; nothing special).
- Heavy armor (scale, plate): walking costs more (110, 125) and sleepers wake more easily.
- Accessories start unidentified and trade one stat for another (e.g. sight +1, evasion -1). Equipping one identifies it.
- Curses: weapons, armor and accessories are cursed ${r.curseChancePct ?? 0}% of the time when generated. A curse stays hidden until you equip or identify the item (a cursed item always has a good affix too); once equipped it will not come off (nothing else can go in that slot and it cannot be dropped). "curse?" in the inventory marks equipment whose curse is still unchecked. A scroll of remove curse or an altar lifts curses (the curse affix disappears).
- Your identified items show their stats (affixes included): "short sword[1d6, acc +1]", "throwing knife x8[thrown 1d4+1, range 7, acc +1]", "scale mail[armor 3, eva -1]". self.attack.throws lists throwables with total acc, dice and range. Identified items carry a kind ID (kind; throwables show {with:javelin} in the inventory line), which fight's with accepts instead of a slot (the same item even if pickups shift the slot letters).
- Treasure: no use, only a value, known as soon as you see it ("silver goblet (value 180)"). Counts toward the haul while carried and is cashed in on extract. Takes an inventory slot.
- Potions and scrolls start unidentified ("red potion"); the mapping is shuffled per run. Using one identifies it; so do identify scrolls and altars.
- Some unidentified potions are harmful. Some potions affect the target when thrown.
- Throwing weapons: throw_item at an entity id, position or direction. They land and can be picked up again.
- The relic (retrieve_relic) does nothing while carried; extract on stairs while carrying it and it becomes a boon.
- Lifeline: camp gives one per expedition. use_item it to return to camp${r.lifeline.turns > 0 ? ` after ${r.lifeline.turns} turns` : ' at once'} (you keep your life and ${r.lifeline.pct}% of the haul without the objective; a relic cannot come along; it does not count as a completed expedition). It cannot be dropped or thrown and does not count toward capacity.
- Features: fountain (heal, once), altar (identify inventory and lift curses, once). Traps are hidden until found (search happens when adjacent). Known traps are avoided by pathing (if the only way crosses one, movement macros stop before it; step on it with move).`,
    observation: `# Observation and the turn block
- Every response has turn: state (your_turn / waiting_others / at_camp / expedition_ended / run_ended), turn_no, reason, awaiting (action / camp_choice / nothing), changes (important changes since your last response). The final ▶ line of the text says the same.
- change codes: new_hostile (an individual seen for the first time this run; its species may be known), reappeared, killed (by you), died_seen, hostile_gone (left view without dying), hp_dropped, hp_low, status_gained, status_lost, level_up, item_found, stairs_found, floor_changed, objective_progress, objective_complete, can_extract. alerts = current state, changes = what changed.
- Every action outcome states how many attacks you took until your next turn, how many hit and the total damage (HP before/after, plus "healed +N" if you recovered in between).
- summary, alerts (enemy_adjacent, low_hp, critical_hp, incoming, lethal_range, lethal_2turns, escape, poisoned, on_stairs, item_here, inventory_full, new_floor, can_extract, at_camp, ...; incoming and escape carry numbers in data).
- expedition: objective, progress, can_extract, extract_blocked_by, extract_outcome (complete / withdraw if you extract now). At camp, camp lists the next offers.
- Wounded monsters running away carry fleeing; a fleeing monster does not block extract or resting.
- self: hp, level, statuses, position, equipment, inventory (brief: compact line; full: details), turns, speed, score (banked points and completed expeditions), rest_estimate (when hurt).
- visible.monsters: id, name, pos, dir, dist, hp_state, awareness (asleep/unaware/hunting), speed, size, traits, threat, first_seen, worst_hit, worst_turn, hits, dealt, role, damage_seen, hp_left_est, shot (clear / blocked; as of this response, and enemy shots use the same line test, so it changes when a monster in between moves or you move), bounty. Items (same kind on one cell merged; all your thrown items on one line with the count and the nearest position, marked mine; treasure has value) / players / features too.
- expedition.haul: the unbanked haul (total, multiplier_pct, parts, if_extract_now, if_lifeline_now, next_overreach, next_camp). self.floor: draft, explored and trait_text (traits this floor was made under). expedition.sense: on the target floor, the direction to the guardian/relic and whether it is within 10. camp.offers: slot, traits, multiplier_pct, recommended_level, level_gap, trait_danger, guardian (forecast: rank and traits), floor_traits (target and on-the-way floors already made with a trait).
- Remembered items in view: nearest 3 only (none while a hunting enemy is in view); the rest as a count (see get_map). navigation.unsighted counts cells whose terrain is known but not yet seen.
- rest_estimate is omitted while you cannot rest (a hunting enemy is in view).
- navigation: here, passable_dirs, frontiers (nearest first), known_stairs (with reachability and path_len).
- map: 21x15 ASCII centered on you (clipped to the floor). Top rows give x tens/ones, each row starts with y. Letters = monsters (one fixed letter per species; see legend). @ you, # wall, . floor, + closed door, ' open door, > down, < up, ~ water, , grass, % tall grass (blocks sight), ! potion, ? scroll, ) weapon, [ armor, / throwing, $ relic, { fountain, _ altar, ^ trap, & ally, blank = unknown. The legend comes with the map.
- valid_actions: example actions available now. Text output summarizes structuredContent; nothing exists only in text.
- Profile: keep the profile_token from new_run and pass it to the next new_run (or join_run) as profile_token to stack records across runs (omit it for a new profile). records shows records (runs, best and average banked, deepest, wardens slain, deaths, recent runs), the codex (species, identified items, delivered relics, guardian types and weaknesses, fragments, special rooms; found/total), feats and the next milestones (one line also at camp). profile shows the name and runs in progress.
- Legacy: species you have slain ${r.legacyMinKills ?? 5}+ times in the codex carry over to the next run as "a previous delver's notes" (abilities, HP record, worst hit, range; recall and look say "from the notes"). They feed HP estimates and threat. Only species knowledge carries over (unidentified looks, guardian weaknesses, maps, stats, gear and boons start from zero). new_run { legacy: false } turns it off.
- Feats: judged at the end of each expedition and run from report and record values, kept in the profile (no effect on strength). All names are visible; hidden conditions show once earned. The camp after an expedition lists "New feats".
- Review: the response that ends an expedition carries its report (combat, items, tempo, moments; 12 lines of text, the full report in JSON). Only events you perceived are counted. expedition returns progress so far (combat and tempo) during an expedition and the last report at camp. review {expedition?} re-reads an ended expedition's report (with the comparison to your earlier expeditions in this run and every moment). At camp, the observation shows up to 2 lines comparing your last expedition. Facts only, no advice.`,
    season: `# Seasons (S0; only runs started with new_run { season })
- A season is a period, opened by the operator, in which many participants take on the dungeon of one seed. Each participant dives in their own run (nobody shares a world). Only published stairs and the standings are shared.
- Joining: only profiles the operator invited to the season may join. Call new_run { season, profile_token } with an ID from list_runs (seasons); the profile_token is the one the operator gave you and is required. One profile is one participant, shown in the standings under the name it was invited with. Season runs are solo, use the season's seed and start at camp at Lv1. No legacy. A participant has one season run at a time. After dying you may start a new run at Lv1 in the same season with the same profile_token (the budget carries on).
- Budget: each participant has a number of own turns for the whole season (one budget across runs; dying does not refund it). Only your own turns in the dungeon count, every turn inside a macro too. Camp is free. The budget left is always in the observation.
- Time up: at the end of the turn that uses up the budget, the expedition ends as time up. You are sent back to camp and lose the unbanked haul (you keep your items). It does not count as dying. You cannot start another expedition afterwards (camp actions and reports still work). Keep enough turns to get home.
- Stairs are in the same place in every participant's run. Reporting: report_stairs at camp (no turn). It sends every down staircase you saw with your own eyes in this run and have not reported yet. The first participant to report a floor's down stairs gets 1 contribution (in the order the server receives them). If you die, the stairs you did not report from that run can no longer be reported.
- Published stairs are taken in when you arrive at camp and when you start an expedition. On a floor with published stairs, the down staircase is on your map from the start (with the reporter's name). The way there is unknown (travel_to stairs_down cannot reach it until the path is known; the draft stays until you see the stairs, so use explore { toward: 'draft' }). Stairs published during your expedition show from the next one.
- Awards (no titles; kept in the results): Adventure = the deepest floor reached in the season (counted on arrival, even if you never get back). Contribution = the number of stairs you reported first. Survival = the banked points of participants who never died this season. Ties go to whoever used less budget (adventure: when first reaching that floor; contribution: when reporting the last one; survival: total used). Time up does not count as dying.
- The standings appear at camp, one line per award (your value and rank, the leader and their value, the gap). In the dungeon only the budget left is shown (what you took in at camp is the latest during that expedition).
- After the end time you cannot start new expeditions. An expedition already under way may continue until you return or die (it still counts).`,
  };
}

/** 守護者の型と弱点の一覧（公開カタログから。どの守護者が何を持つかは伏せる。V3-3 §3.1） */
function guardiansText(c: Catalog, locale: 'ja' | 'en'): string {
  const ja = locale !== 'en';
  const nm = (n: { ja: string; en: string }) => (ja ? n.ja : n.en);
  const lines = [ja ? '# 守護者の型（候補と観測に称号が出る）' : '# Guardian types (offers and observations show the title)'];
  for (const [id, g] of Object.entries(c.guardianTypes)) lines.push(`- ${nm(g.name)}（${id.split(':')[1]}）: ${nm(g.desc)}`);
  lines.push(ja ? '# 守護者の弱点（どれを持つかは伏せられている）' : '# Guardian weaknesses (which one a guardian has is hidden)');
  // 付けてよい装甲の上限（V4-1l §34.2: 装甲の高い相手では効かないので付かない）
  for (const [, w] of Object.entries(c.guardianWeaknesses)) lines.push(`- ${nm(w.name)}: ${nm(w.desc)}${w.maxArmor !== undefined ? (ja ? `（装甲の目安が ${w.maxArmor} を超える相手には付かない）` : ` (never on a guardian whose armor estimate exceeds ${w.maxArmor})`) : ''}`);
  // 加護（V3-3 §3.3）: 遺物を持ち帰ると付く
  lines.push(ja ? '# 加護（遺物を階段の上で持ち帰ると付く。ランの終わりまで残る）' : '# Boons (gained by carrying a relic out on stairs; they last for the run)');
  const relicOf = (boon: string) => Object.values(c.items).find((it) => it.boon === boon);
  for (const [id, b] of Object.entries(c.boons ?? {})) { const r = relicOf(id); lines.push(`- ${nm(b.name)}${r ? (ja ? `（${nm(r.name)}）` : ` (${nm(r.name)})`) : ''}: ${nm(b.desc)}`); }
  return lines.join('\n');
}

export function rulesText(topic: RulesTopic = 'all', locale: 'ja' | 'en' = 'ja', catalog: Catalog): string {
  const src = locale === 'en' ? en(catalog.rules) : ja(catalog.rules);
  if (topic === 'classes') return [classesText(catalog, locale), guardiansText(catalog, locale)].join('\n\n');
  // 物語の枠（V3-3 §3.4）は all の先頭に 1 段落
  const frame = (catalog.lore?.frame ?? []).map((n) => (locale === 'en' ? n.en : n.ja));
  if (topic === 'all') return [...(frame.length ? [frame.join(' ')] : []), ...Object.values(src), classesText(catalog, locale), guardiansText(catalog, locale)].join('\n\n');
  return src[topic];
}
