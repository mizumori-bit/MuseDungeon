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
- new_run で objective を省くとキャンプから始まり、最初の遠征も候補 3 つから選ぶ。objective を渡すと最初の遠征を直接始める（reach_depth = 堅実の枠 / slay_guardian = 標準の枠 / retrieve_relic = 野心の枠 / endless / auto = 1 番目の候補）。2 回目以降はキャンプの候補 3 つから選ぶ。`,
    expedition: `# 遠征
- 目的の種類: reach_depth（目標の階に着く）、slay_guardian（目標の階の守護者を倒す）、retrieve_relic（目標の階の遺物を拾い、持ったまま帰る）、endless（目的なし）。
- 守護者・遺物の居場所は教えられない。観測では role: guardian / relic の印が付く。
- 帰還（extract）: 目的を達成したうえで、いずれかの階段（上り・下り）の上にいること。追跡中の敵が見えていてもよい（敵は階段を追ってこない。階を移れば追ってこない）。遠征は「達成」で終わる。
- 撤退（extract confirm: true）: 目的が未達成でも同じ条件で extract できる。生還し、遠征は「撤退」で終わる。
- 帰還の綱: 遠征の開始時にキャンプが 1 本持たせる（余っていても 1 本、無ければ補充。坑の中では手に入らない。捨てる・投げることはできず、所持数に数えない）。use_item で使うと ${r.lifeline.turns} 手番のあいだ行動できず（その間の攻撃は受ける）、その後キャンプへ戻る。1 回の呼び出しで最後まで進む（止まるのは死んだときだけ）。確定するのは戦利品全体の ${r.lifeline.pct}%（目的を達成済みならその点も含む。持っている遺物は納めた扱い。未達成なら撤退と同じ額）。遠征は「綱で帰還」で終わる。
- 結果の段階は 4 つ: 階段で帰還（戦利品 × 倍率）／綱で帰還（${r.lifeline.pct}%）／階段で撤退（目的を除いて ${h.withdrawPct}%）／死亡（0、ランの終わり）。
## 戦利品と確定点（スコア版 2）
- ランのスコア = 確定点の合計。遠征中に得た点はすべて未確定の「戦利品」で、extract で確定する:
  - 帰還（目的を達成して extract）: 戦利品 × 条件の倍率
  - 撤退（extract confirm）: (戦利品 − 目的の基礎点) × ${h.withdrawPct}%
  - 綱で帰還: 戦利品（目的は達成済みのときだけ含む）× ${r.lifeline.pct}%（倍率は掛からない）
  - 死亡・引退: 0（失った戦利品として記録に残る）
- 戦利品の内訳:
  - 目的: 達成した時点で候補の基礎点（= 枠の基礎点 × 種類の係数 × 深さの係数。下の「遠征の候補」）
  - 踏破（深追い）: 目標より深い階を横切り、その階の**下り階段に立った**とき（着いただけでは入らない）。n 階目 = 目的の基礎点 × (${h.overreachPct.first} + ${h.overreachPct.step}×(n−1))%、下限 ${h.overreachFirst} + ${h.overreachStep}×(n−1)（1 階目 ${h.overreachPct.first}%・2 階目 ${h.overreachPct.first + h.overreachPct.step}%…）。着いた階段ですぐ帰ることもできる（逃げ道であって報酬ではない）
  - 宝: 分類 treasure の所持品の価値の合計（落とせば減る。帰還・撤退で換金され所持品から消える）。持ち帰った遺物は帰還で納められ、所持品から消える
  - 賞金: 守護者を倒すと（${h.guardianBounty.base} + 深度×${h.guardianBounty.perDepth}）。観測の bounty に出る。守護者は宝を必ず落とす
  - 発見: このランで初めて、ある種族を倒す +${h.discovery.species}／あるアイテム種を鑑定する +${h.discovery.identify}
  - 撃破: 1 体 +${h.perKill}
- 観測の expedition.haul に、内訳（parts）・合計・倍率・今 extract した場合の確定点（if_extract_now）・今綱を使った場合の確定点（if_lifeline_now）・次に踏破の点が入る階（next_overreach。その階の下り階段までの経路長が分かれば path_len、未発見なら下への風の方角 dir）・今帰った場合と、次の踏破の階へ降りてから帰った場合の次の候補の下限と推奨レベル（next_camp / next_camp_after_crossing。次の候補は新しい階に着いた時点で深くなる）が毎回出る。self.score に確定済みの点。
- 下への風: 今いる階の下り階段をまだ見ていない間、その方角（8 方向。遠近は出さない）が self.floor.draft に出る。self.floor.explored はその階の通れるマスのうち見た割合の 4 段階（1 約 1/4・2 約半分・3 約 3/4・4 ほぼ全て）。
- COOP では戦利品（宝を除く）はパーティで共有し、extract した各自に払い戻される。宝は持っている本人の分。
## 目的を達成した後の圧力
- slay_guardian と retrieve_relic は、達成した瞬間からその遠征の間、徘徊の湧き間隔が ${r.afterObjectiveWanderPct}% になる（changes に「坑が騒がしくなった」と出る）。reach_depth には付かない。
- 遺物を拾うと、その階の眠っている・気づいていない敵が目を覚まし、遺物の場所へ向かう。
- 気配: 目標階にいる間、守護者（未討伐）か遺物（未入手）の方角（8 方向）と、10 マス以内かどうかが expedition.sense に出る。正確な位置は見るまで分からない。
## 遠征の候補（キャンプ）
- 候補は 3 枠。目標の深度は「生成済みの最深階 + 幅」（最初の遠征は 堅実 地下${x.firstTargetDepth.safe}階・標準 地下${x.firstTargetDepth.standard}階・野心 地下${x.firstTargetDepth.ambitious}階）。目的の種類は 3 枠で別:
  - 堅実: +${sl.safe.aheadMin}〜${sl.safe.aheadMax} 階、条件 ${sl.safe.traitsMin}〜${sl.safe.traitsMax} 個、枠の基礎点 ${sl.safe.base}
  - 標準: +${sl.standard.aheadMin}〜${sl.standard.aheadMax} 階、条件 ${sl.standard.traitsMin}〜${sl.standard.traitsMax} 個、枠の基礎点 ${sl.standard.base}
  - 野心: +${sl.ambitious.aheadMin}〜${sl.ambitious.aheadMax} 階、条件 ${sl.ambitious.traitsMin}〜${sl.ambitious.traitsMax} 個、枠の基礎点 ${sl.ambitious.base}
- 候補の基礎点 = 枠の基礎点 × 種類の係数（到達 ${x.typePct.reach_depth ?? 100}%・守護者 ${x.typePct.slay_guardian ?? 100}%・遺物 ${x.typePct.retrieve_relic ?? 100}%・守護者付きの遺物 ${x.typePct.retrieve_relic_guarded ?? 100}%）× 深さの係数（${x.depthPct.base} + ${x.depthPct.perDepth}×目標深度 %）。どの組み合わせでも 堅実 < 標準 < 野心。
- 条件は、その遠征で目標階までの全階に効く公開の修飾。倍率は帰還時の戦利品に掛かる（複数なら掛け合わせ）:
${traitsLines(r, true)}
- 候補には推奨レベルと自分との差（level_gap = 推奨 − 自分。正なら推奨より低い）、条件の危険度の合計（trait_danger）が出る。推奨レベルは深度ごとの公開の表（地下1〜${r.recommendedLevel.byDepth.length}階: ${r.recommendedLevel.byDepth.join(', ')}。より深い階は直近 4 階の傾きで伸ばす）。隠し情報は使わない。
- new_run で objective を省くとキャンプから始まり、最初の遠征も 3 候補から選ぶ。
## その他
- 経験値は敵を倒すほか、新しい深度に初めて着く（${r.xp.perNewDepth} × 深度）と遠征の目的を達成する（${r.xp.perObjective} × 目標深度）ことでも得る。
- 遠征が達成か撤退で終わるとキャンプに戻る。キャンプでは時間が進まず、HP は全快し状態異常は消える。次の遠征の候補 3 つから start_expedition { offer } で選ぶ（前回 extract した階段から再開）。何も選ばずにやめてもよい（resume_run で後から続けられる）。
- 接続が切れても遠征は終わらない（中断）。resume_run で続きから再開できる。
- 観測の expedition に目的・進捗・can_extract（今この場で extract できるか）が毎回付く。`,
    actions: `# 行動
手番を消費する: move{dir} / wait{turns?} / rest{until_hp?,max_turns?} / explore{mode?,hp_floor?,pickup?} / travel_to{to,mode?,hp_floor?,pickup?} / collect{what?,mode?} / fight{target,with?,hp_floor?} / pickup{item?} / drop{slot,qty?} / equip{slot} / unequip{slot} / use_item{slot,target?,target_slot?} / throw_item{slot,target} / interact{dir?} / use_stairs / extract{confirm?}
キャンプで: start_expedition{offer} / retire
手番を消費しない: observe / wait_for_turn / expedition / look / get_map / inventory / recall / get_messages / notes / say / set_options / get_rules
- 方向は n ne e se s sw w nw。座標は左上原点、x は東、y は南へ増える。
- move: 敵がいれば近接攻撃（バンプ攻撃）、閉じた扉なら開ける（その手番は移動しない）、味方なら位置交換。
- 原則: 1 回の呼び出しは 1 つの判断に対応する。マクロが 1 歩も進めないと分かるときは、手番を使わずに理由付きのエラー（hostile_adjacent / hostile_in_view / hp_floor / blocked / nothing_to_do など）で拒否される。
- explore: 未見の区画へ自動移動するマクロ（最大 ${r.macroStepLimit} 手）。pickup（既定 true）なら通り道と見えている・記憶したアイテムも拾う（遺物と鑑定済みの有害品は拾わない。所持品が一杯なら拾わない）。地図の巻物で地形だけ知った区画も「未見」として行き先になる。
- travel_to: {x,y} / "stairs_down" / "stairs_up" / エンティティ ID へ既知地図上で移動するマクロ。目的地がアイテムなら着いて拾う。既知の階段には path_len（既知地図上の経路長）が付く。
- 移動マクロ（explore / travel_to / collect）の mode（慎重さ）:
  - careful（既定）: 初見の種族が見えた／追跡中（逃走中でない）で自分に届く敵が現れた／見えている敵が追跡に変わった／攻撃を受けた（外れも含む）／毒以外のダメージを受けた／状態異常を受けた／HP が 50%・25% の線をまたいだ／階段を見つけた（explore）で止まる。既知の種族の眠っている・気づいていない個体、動かない敵で隣にいないもの、毒の継続ダメージ、アイテムの発見では止まらない（changes には出る）。隣に起きている敵（逃走中を除く）がいると動かない。
  - steady: 追跡中の敵が隣に来た／初見の種族が見えた／HP が hp_floor（既定 最大 HP の 50%）を下回った／その階の下り階段を初めて見たで止まる。弱い射撃や毒を受けながら進むとき。
  - flee: 到着／進路をふさがれた／HP が hp_floor（既定 25%）を下回ったで止まる。隣に敵がいても動く（退却。途中で受けた攻撃はすべて結果に出る）。
  - careful と steady は、その階の下り階段を初めて見たときにも止まる（踏破の判断の起点）。経路は、見えている動かない敵の隣を罠と同じく避ける（ほかに道が無ければ通る）。
  - どの mode も 1 歩ずつ通常の move として行い、敵は通常どおり攻撃してくる。マクロは攻撃しない（次のマスに敵がいれば blocked で止まる）。valid_actions にはその場で進める mode だけが出る。
- fight{target,with?,hp_floor?}: その相手と決着を付けるマクロ。with なし: 隣の相手に近接攻撃を繰り返す。相手が追跡中で届かない間は隣に来るまで待つ（最大 10 手番）。当てて逃げる相手は、追跡中で 2 マス以内なら 2 手番まで待つ（追わない）。with にスロットを渡すと、その品を投げて戦う（射程と射線が通るまで待つ）。止まるのは: 相手が倒れた／離れた・逃げて射程を出た／（with のとき）相手が隣に来た・品が尽きた・射線が 3 手番続けて通らない／HP が hp_floor（既定 50%）を下回った／追跡中の別の敵が現れた／状態異常を受けた。眠っている・気付いていない相手を待つことはしない（近づくなら travel_to、先手なら throw_item）。結果に与えた・受けた攻撃の回数と合計。
- wait{turns?}: 1 手番待つ。turns（2〜10）を渡すと、敵が見えた・隣に来た・攻撃や毒以外の被害を受けたら止まりつつ、その手数だけ待つ。
- rest: 全快（かつ毒が抜ける）まで、または until_hp / max_turns まで休むマクロ（最大 ${r.restMaxTurns} 手）。敵が視界に入ると（状態によらず）止まる（すでに見た個体が逃げながら視界を出入りする場合は止まらない）。追跡中の敵が見えている間は休めない（動かない敵は隣にいなければ妨げない）。
- throw_item: 対象（ID）までの投擲の経路が通っていないときは no_line_of_sight、射程外なら out_of_range で拒否される（手番も品物も失わない。visible.monsters の shots に品目ごとの clear / blocked / out_of_range）。座標を狙えば遮られた位置か射程の端に落ちる。結果は必ず「命中／外れ／壁や他の者に遮られた／届かなかった」と落下地点で示される。
- 自分が投げた物は、そのマスに入るだけで拾う（追加の手番なし。所持品がいっぱいなら拾わない）。collect は既知の自分が投げた物（what: thrown、既定）か、見えている・記憶したアイテム（what: items）を近い順に回って拾うマクロ。
- use_item の target_slot: 鑑定の巻物で鑑定する品のスロット。省略するとスロット順で最初の未鑑定品（読んだ巻物自身の種類を除く）。
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
- 近接ダメージ: 武器ダイス + 威力(might) - 相手の装甲(armor)、最低 1。投擲: 投擲ダイス - 装甲、最低 1。表示されるダメージは実際に減った HP（とどめの超過分は含まない）。
- 状態異常: 毒（毎手番 1 ダメージ）、加速（速度 2 倍）、減速（速度半分）、睡眠（行動不能、ダメージで解ける）、帰還中（帰還の綱。行動不能、切れるとキャンプへ）。手番開始時に処理。毒で倒れた敵は、毒を与えた者が倒した扱い（賞金・撃破点・経験値）。視界の外で毒が効いている間は相手の名前・体力・位置は出ず、倒れたときだけ「あなたの毒で何かが倒れた」と知らされる。
- 経験値でレベルアップ（次のレベルに必要な累計 XP = 15×Lv²）。HP 上限・命中・威力・回避が上がる。
- 自然回復: max(${rg.minInterval}, ${rg.baseInterval} - floor(Lv/${rg.levelDiv})) 手番ごとに 1 HP。追跡中の敵が見えない状態での wait（rest の各手を含む）は休息となり ${rg.restMultiplier} 倍の速さで回復する。観測の self.rest_estimate に全快までの手数・時間・その間の徘徊の目安が出る。
- 敵の HP は 4 段階でしか分からない: healthy（${b1}% 以上）/ wounded（${b2}% 以上）/ badly_wounded（${b3}% 以上）/ near_death（それ未満）。
- 敵の HP は個体ごとにダイスで決まり幅がある。接辞・深層強化（tier）で増え、守護者は通常の個体より大幅に頑丈。
- 目の前で倒した個体は最大 HP が分かり、種族ごとの「体力の記録」（recall）に残る（守護者は体力の記録と命中の記録に含めない。受けた最大の一撃には含める）。記録がある種族には、見ている間に与えた実ダメージの合計（damage_seen）と 4 段階表示から推定残り HP（hp_left_est）が付く。記録は標本であって種族の範囲ではないので「記録どおりなら残り 6〜8（記録 3 体: 体力 8〜8）」と書く。記録が ${r.estimateMinSamples} 体未満の間は下限だけ。
- 姿の見えない相手から攻撃されたときは、来た方向だけが分かる（「南東から飛んできた何かの射撃」）。
- threat(1-5) は「自分の現在 HP と、その種族から受けた最大の一撃」から見積もった危険度。その種族から攻撃を受けた記録が無ければ null（脅威: 不明（被弾の記録なし）。本当に初めて見た種族は「不明（初見）」）。worst_hit にその最大の一撃が出る。追跡中の敵の worst_hit、または追跡中の敵の worst_hit の合計が今の HP 以上なら alerts に lethal_range。
- 見れば分かる特徴は初見から出る: speed（自分の今の速さとの比較で slow / normal / fast）、traits（pack 群れる・ranged 飛び道具・stationary 動かない）。体力・威力・回避・弱点は伏せたまま。
- 命中の記録: 種族ごとに、自分の攻撃（近接・投擲を分ける）と相手から自分への攻撃の回数と命中が残り、visible.monsters の hits に出る（「あなたの命中 近接1/6・相手の命中 3/5」）。確率そのものは出ない。
- 群れの被害見込み: 追跡中の敵が 2 体以上見えると alerts に incoming（追跡中の数・記録の最大被害の合計・記録の無い数・あなたの HP）。逃げ道: 追跡中の敵が見えていて既知の階段に辿り着けるとき、alerts に escape（最寄りの階段・経路長・あなたより速い追跡中の敵の数）。
- 浅い階の群れは小さい: 群れの数は最大で 深度 + 1（地下1階は 2、地下2階は 3）。
- 転移の巻物: 着地点は元の位置から ${r.teleport.minDistance} マス以上離れ、追跡中の敵から見えないマスを優先する（無ければ距離だけ、それも無ければどこでも）。
- 経験値: 敵を倒す、新しい深度に初めて着く、遠征の目的を達成する。レベルアップの文に上がった能力値が並ぶ。
- 騒音: 戦闘・扉の開閉は音を立て、近くの眠っている敵を起こすことがある。`,
    items: `# アイテム
- 武器・防具: equip で装備。接辞（例: 鋭い = 命中+2）付きのものもある。
- 自分の鑑定済みの持ち物は性能が分かる（所持品の行に「小剣[1d6・命中+1]」「投げナイフx8[投擲1d4+1・射程7・命中+1]」「鱗鎧[装甲3・回避-1]」。接辞込み）。self.attack.throws に投げられる物の命中（自分の命中込み）・ダイス・射程。
- 宝（treasure）: 使い道は無く、価値（value）だけを持つ。見えた時点で価値が分かる（「銀の杯（価値 180）」）。所持している間は戦利品に入り、帰還・撤退で換金される。所持枠を 1 つ使う。
- 薬・巻物は最初は未鑑定で、「赤い薬」のような外見名でしか分からない（外見と正体の対応はランごとに異なる）。使うと正体が判明する。鑑定の巻物・祭壇でも判明する。
- 未鑑定の薬には有害なもの（毒薬）もある。投げると対象に効果が及ぶ薬もある。
- 投擲武器（投げナイフ・投げ槍）は throw_item で対象（エンティティ ID か座標か方向）へ投げる。投げた物は着地点に落ちるので拾い直せる。
- 遺物（retrieve_relic の目的の品）は効果を持たない。持ったまま階段の上で extract すると持ち帰れる。
- 帰還の綱: 遠征ごとにキャンプが 1 本持たせる。use_item で使うと ${r.lifeline.turns} 手番後にキャンプへ戻る（戦利品の ${r.lifeline.pct}% が確定）。捨てる・投げることはできず、所持数に数えない。
- 地物: 泉（回復、1 回）、祭壇（所持品を鑑定、1 回）。罠は見つけるまで見えない（隣接すると発見判定）。発見済みの罠は経路探索で避ける。`,
    observation: `# 観測と turn ブロック
- 全応答の turn: state（your_turn / waiting_others / at_camp / expedition_ended / run_ended）、turn_no、reason、awaiting（action / camp_choice / nothing）、changes（前回の応答からの重要な変化）。テキストでは末尾の ▶ 行が同じ内容。
- changes のコード: new_hostile（このランで初めて見た）, reappeared（前に見た個体が再び見えた）, killed（あなたが倒した）, died_seen（目の前で倒れた）, hostile_gone（倒れた以外の理由で見えなくなった）, hp_dropped, hp_low, status_gained, status_lost, level_up, item_found, stairs_found, floor_changed, objective_progress, objective_complete, can_extract。alerts は「現在の状態」、changes は「前回からの差分」。
- 行動結果の outcome には、その行動から次の自分の手番までに受けた攻撃の回数・命中・合計ダメージ（HP の前後。間に回復があれば「回復 +N」）が必ず入る。
- summary: 1 行の現況。alerts: 重要度順の警告（enemy_adjacent, low_hp, critical_hp, incoming, lethal_range, escape, poisoned, on_stairs, item_here, inventory_full, new_floor, can_extract, at_camp など。incoming と escape には data に数値）。
- expedition: 遠征の目的・進捗・can_extract・extract_blocked_by・extract_outcome（今 extract したら complete=達成 / withdraw=撤退）。キャンプでは camp に次の遠征の候補。
- 手負いで逃げている敵には fleeing が付く。逃走中の敵は追跡中でも extract と休息を妨げない。
- self: HP・レベル・状態異常・位置・装備・所持品（brief は一覧の短縮形、full は詳細）・turns・speed（実効の速さ）・score（確定済みの点と達成した遠征の数）・rest_estimate（HP が減っているとき）。
- visible.monsters: id, 名前, 座標, 方向, 距離, hp_state, awareness(asleep/unaware/hunting), speed, traits, threat, first_seen, worst_hit, hits, role, damage_seen, hp_left_est, shot（clear: 投擲の経路が通る / blocked）, bounty（倒すと戦利品に入る賞金）。items（同じマスの同種は 1 行。自分が投げた物は全部で 1 行（本数と最寄りの位置）で mine、宝は value）/ players / features も同様。
- expedition.haul: 未確定の戦利品（total, multiplier_pct, parts, if_extract_now, if_lifeline_now, next_overreach, next_camp, next_camp_after_crossing）。self.floor: draft（下への風）・explored（探索の進み具合）。expedition.sense: 目標階にいる間の気配（守護者・遺物の方角と、10 マス以内かどうか）。camp.offers: slot（safe/standard/ambitious）, traits, multiplier_pct, recommended_level, level_gap, trait_danger。
- 見えるものの「記憶しているアイテム」は近い順に 3 件まで（戦闘中は出さない）。残りは件数だけ（get_map で全体）。navigation.unsighted は地形は判明しているが、まだ見ていないセルの数。
- 休めないとき（追跡中の敵が見えている）は rest_estimate を出さない。
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
- new_run without objective starts at camp, where you choose the first expedition from 3 offers. Passing objective starts it directly (reach_depth = safe slot / slay_guardian = standard slot / retrieve_relic = ambitious slot / endless / auto = the first offer). Later expeditions are chosen from 3 offers at camp.`,
    expedition: `# Expeditions
- Objective types: reach_depth (arrive on the target depth), slay_guardian (slay the guardian there), retrieve_relic (pick up the relic there and carry it out), endless (no objective).
- Guardian and relic locations are not revealed; observations mark them with role: guardian / relic.
- Extract (complete): objective done and standing on any stairs (up or down). Hunting enemies in view do not prevent it (monsters never follow you between floors). The expedition ends as completed.
- Withdraw (extract confirm: true): same conditions without the objective; you survive and the expedition ends as withdrawn.
- Lifeline: camp gives each participant exactly one at the start of every expedition (extras are trimmed; none can be found in the pit; it cannot be dropped or thrown and does not count toward capacity). use_item it to be helpless for ${r.lifeline.turns} turns (you still take hits), then return to camp; one call runs to the end (only death stops it). It banks ${r.lifeline.pct}% of the whole haul (the objective included only if already complete; a carried relic counts as delivered; otherwise the same as a withdrawal). The expedition ends as lifeline.
- Four outcomes: stairs + complete (haul x multiplier) / lifeline (${r.lifeline.pct}%) / stairs withdrawal (${h.withdrawPct}% without the objective) / death (0, the run ends).
## Haul and banked points (score version 2)
- Run score = total banked points. Everything earned during an expedition is an unbanked haul, settled on extract:
  - Completed (objective done, extract): haul x the offer's multiplier
  - Withdrawn (extract confirm): (haul - objective points) x ${h.withdrawPct}%
  - Lifeline: haul (objective only if complete) x ${r.lifeline.pct}% (no multiplier)
  - Died / retired: 0 (recorded as lost)
- Haul parts:
  - objective: the offer's base points on completion (slot base x type factor x depth factor; see Offers)
  - crossing (overreach): when you cross a floor deeper than the target and **stand on its down stairs** (arriving is not enough): the n-th pays objective points x (${h.overreachPct.first} + ${h.overreachPct.step}*(n-1))%, at least ${h.overreachFirst} + ${h.overreachStep}*(n-1). You may still extract on the arrival stairs (an escape route, not a reward)
  - treasure: value of treasure items you carry (drop one and it is gone; cashed in and removed on extract)
  - bounty: slaying a guardian (${h.guardianBounty.base} + depth*${h.guardianBounty.perDepth}); shown as bounty. Guardians always drop a treasure
  - discovery: first time this run you kill a species +${h.discovery.species} / identify an item kind +${h.discovery.identify}
  - kills: +${h.perKill} each
- expedition.haul shows parts, total, multiplier, if_extract_now (banked if you extract right now), if_lifeline_now (banked if you use the lifeline now), next_overreach (the depth whose down stairs pay next, with path_len when known, or dir = the draft when not found yet) and next_camp / next_camp_after_crossing (where the next offers would start if you extract now / after going down to the next crossing floor; offers deepen as soon as you arrive on a new floor) every time. self.score shows your banked points.
- Draft: until you have seen the current floor's down stairs, self.floor.draft gives their 8-way direction (no distance). self.floor.explored is how much of the floor's walkable cells you have seen, in 4 steps (1 about a quarter, 2 about half, 3 about three quarters, 4 nearly all).
- In COOP the haul (except treasure) is shared by the party and paid to each player who extracts. Treasure belongs to whoever carries it.
## Pressure after the objective
- For slay_guardian and retrieve_relic, from the moment the objective is done until the expedition ends, the wanderer spawn interval becomes ${r.afterObjectiveWanderPct}% (changes says the pit grows restless). reach_depth has no such pressure.
- Picking up the relic wakes sleeping/unaware monsters on that floor and sends them toward it.
- Sense: on the target floor, expedition.sense gives the direction (8-way) to the unslain guardian or untaken relic and whether it is within 10 cells. The exact position is not given until you see it.
## Offers at camp
- Three slots. Target depth = deepest generated depth + range (first expedition: safe depth ${x.firstTargetDepth.safe}, standard ${x.firstTargetDepth.standard}, ambitious ${x.firstTargetDepth.ambitious}). Each slot has a different objective type:
  - safe: +${sl.safe.aheadMin}-${sl.safe.aheadMax}, ${sl.safe.traitsMin}-${sl.safe.traitsMax} traits, slot base ${sl.safe.base}
  - standard: +${sl.standard.aheadMin}-${sl.standard.aheadMax}, ${sl.standard.traitsMin}-${sl.standard.traitsMax} traits, slot base ${sl.standard.base}
  - ambitious: +${sl.ambitious.aheadMin}-${sl.ambitious.aheadMax}, ${sl.ambitious.traitsMin}-${sl.ambitious.traitsMax} traits, slot base ${sl.ambitious.base}
- Offer points = slot base x type factor (reach ${x.typePct.reach_depth ?? 100}%, guardian ${x.typePct.slay_guardian ?? 100}%, relic ${x.typePct.retrieve_relic ?? 100}%, guarded relic ${x.typePct.retrieve_relic_guarded ?? 100}%) x depth factor (${x.depthPct.base} + ${x.depthPct.perDepth}*target depth %). Always safe < standard < ambitious.
- Traits are public modifiers on every floor down to the target for that expedition. Their multipliers apply to the haul on completion (multiplied together):
${traitsLines(r, false)}
- Offers show the recommended level, your gap to it (level_gap = recommended - yours) and the sum of trait dangers (trait_danger). Recommended levels come from a public table (depth 1-${r.recommendedLevel.byDepth.length}: ${r.recommendedLevel.byDepth.join(', ')}; deeper depths extend the last 4-depth slope). No hidden information is used.
- new_run without objective starts at camp, so you choose the first expedition from 3 offers too.
## Other
- After completing or withdrawing you are at camp: time does not pass, HP is restored and statuses cleared. Choose the next of 3 offers with start_expedition { offer } (you restart from the stairs you extracted on). You may stop instead and resume_run later.
- A disconnect does not end an expedition; resume_run continues it.
- Every observation includes expedition (objective, progress, can_extract).`,
    actions: `# Actions
Turn-consuming: move{dir} / wait{turns?} / rest{until_hp?,max_turns?} / explore{mode?,hp_floor?,pickup?} / travel_to{to,mode?,hp_floor?,pickup?} / collect{what?,mode?} / fight{target,with?,hp_floor?} / pickup{item?} / drop{slot,qty?} / equip{slot} / unequip{slot} / use_item{slot,target?,target_slot?} / throw_item{slot,target} / interact{dir?} / use_stairs / extract{confirm?}
At camp: start_expedition{offer} / retire
Free: observe / wait_for_turn / expedition / look / get_map / inventory / recall / get_messages / notes / say / set_options / get_rules
- Directions: n ne e se s sw w nw. Origin is top-left; x grows east, y grows south.
- move attacks a hostile in that cell, opens a closed door (without moving), or swaps with an ally.
- Principle: one call, one decision. When a macro cannot take a single step it is refused without spending a turn, with a reason (hostile_adjacent / hostile_in_view / hp_floor / blocked / nothing_to_do ...).
- explore: macro that walks to the nearest unseen area (max ${r.macroStepLimit} steps). With pickup (default true) it also picks up items on the way and known items (not the relic, not identified harmful items, not when full). Areas known only from a mapping scroll still count as unseen.
- travel_to: macro to {x,y}, "stairs_down", "stairs_up" or an entity id over the known map; if the destination is an item it picks it up. Known stairs carry path_len.
- Movement macro mode (explore / travel_to / collect):
  - careful (default): stops on a species you have never seen, a hunting (not fleeing) enemy that can reach you appearing, a visible monster starting to hunt, being attacked (even if missed), non-poison damage, a status, HP crossing 50% / 25%, stairs found (explore). Known species asleep/unaware, stationary monsters not adjacent, poison ticks and items found do not stop it (they appear in changes). It will not move while an awake non-fleeing enemy is adjacent.
  - steady: stops when a hunting enemy is adjacent, a never-seen species appears, HP falls below hp_floor (default 50% of max), or you first see the floor's down stairs. For moving on through weak shots or poison.
  - flee: stops on arrival, a blocked path or HP below hp_floor (default 25%). Moves even with enemies adjacent (a retreat; every attack taken shows in the result).
  - Every mode walks with ordinary moves and enemies attack as usual. Macros never attack (an enemy in the next cell stops them: blocked). valid_actions only lists modes that can move right now.
  - careful and steady also stop when you first see the floor's down stairs (where the crossing decision starts). Paths avoid cells next to visible stationary monsters like traps (unless there is no other way).
- fight{target,with?,hp_floor?}: settle it with that target. Without with: keep attacking it in melee; while it is hunting you but not adjacent, wait until it is (max 10 turns); a hit-and-run target hunting within 2 cells is waited for up to 2 turns (never chased). With a slot in with: fight by throwing that item, waiting until it is in range with a clear line. Stops when it falls, moves away / flees out of range, (with) it becomes adjacent, the item runs out, or the line is blocked 3 turns in a row, your HP falls below hp_floor (default 50%), another hunting enemy appears, or you get a status. It never waits for sleeping/unaware targets (approach with travel_to or open with throw_item). The result reports swings, hits and damage both ways.
- wait{turns?}: wait one turn. With turns (2-10) it keeps waiting, stopping when a monster appears, one becomes adjacent, or you are attacked / take non-poison damage.
- rest: waits until HP is full and poison is gone, or until until_hp / max_turns (max ${r.restMaxTurns} turns). It stops when any monster comes into view (but not when an already-seen fleeing monster wanders in and out). Stationary monsters do not block resting unless adjacent.
- throw_item at an entity id is refused with no_line_of_sight when the path is blocked and out_of_range when it is too far (no turn, no item lost; shots in visible.monsters gives clear / blocked / out_of_range per item). Targeting a position lands where it is blocked or at the end of the range. The result always says hit / missed / blocked / fell short and where it landed.
- Items you threw are picked up just by stepping on them (free). collect visits your known thrown items (what: thrown, default) or known items (what: items) in order.
- use_item target_slot: the item an identify scroll identifies. Without it, the first unidentified item by slot order (other than the scroll's own kind).
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
- Melee damage: weapon dice + might - armor (min 1). Thrown: thrown dice - armor (min 1). Reported damage is the HP actually lost (overkill excluded).
- Statuses: poison (1 dmg/turn), haste (x2 speed), slow (x0.5), sleep (helpless, damage wakes), recalling (lifeline; helpless, then back to camp). Processed at turn start. A monster killed by poison counts as killed by whoever poisoned it (bounty, kill points, XP). While your poison works on something out of sight you learn nothing about it; only its death is reported ("something fell to your poison").
- Level up at total XP = 15*Lv^2: more max HP, acc, might, eva.
- Regeneration: 1 HP every max(${rg.minInterval}, ${rg.baseInterval} - floor(Lv/${rg.levelDiv})) turns. wait with no hunting enemy in view (each rest turn too) counts as resting and regenerates ${rg.restMultiplier}x faster. self.rest_estimate shows turns/time to full and expected wanderers.
- Monster HP is shown in 4 bands: healthy (>= ${b1}%), wounded (>= ${b2}%), badly_wounded (>= ${b3}%), near_death (below).
- Monster HP is rolled per individual; affixes and tiers raise it, and guardians are far sturdier.
- When you see a monster die you learn its max HP; recall keeps an HP record per species (guardians are left out of HP and hit records, but count toward the worst hit). For recorded species, observations include damage_seen and hp_left_est, phrased as "if typical" because the record is a sample, not the species range (lower bound only until ${r.estimateMinSamples} are recorded).
- When an unseen attacker hits you, you learn the direction it came from.
- threat (1-5) is estimated from your HP and the biggest hit you have taken from that species; null if it has never hit you ("unknown, first sighting" only for a species you have truly never met). worst_hit shows that biggest hit, and alerts carry lethal_range when a hunting enemy's worst_hit, or the sum over hunting enemies, is at least your HP.
- What you can see is shown from the first sighting: speed (slow / normal / fast compared with your current speed) and traits (pack, ranged, stationary). HP, power, evasion and weaknesses stay hidden.
- Hit records: per species, your attacks (melee and thrown separately) and its attacks on you, as hits/tries in visible.monsters hits ("your hits melee 1/6, its hits 3/5"). No probabilities are given.
- Pack danger: with 2+ hunting enemies in view, alerts carry incoming (how many, the sum of their recorded worst hits, how many have no record, your HP). Escape: with hunting enemies in view and known reachable stairs, alerts carry escape (nearest stairs, path length, how many hunters are faster than you).
- Packs are small on shallow floors: at most depth + 1 (2 on depth 1, 3 on depth 2).
- Teleport scroll: prefers a landing cell at least ${r.teleport.minDistance} cells away that no hunting enemy can see (then distance only, then anywhere).
- XP comes from kills, first arrival at a new depth and completing an expedition objective. Level-up messages list the stat gains.
- Noise from combat and doors may wake nearby sleepers.`,
    items: `# Items
- Weapons/armor: equip them. Some have affixes (e.g. keen = +2 acc).
- Your identified items show their stats (affixes included): "short sword[1d6, acc +1]", "throwing knife x8[thrown 1d4+1, range 7, acc +1]", "scale mail[armor 3, eva -1]". self.attack.throws lists throwables with total acc, dice and range.
- Treasure: no use, only a value, known as soon as you see it ("silver goblet (value 180)"). Counts toward the haul while carried and is cashed in on extract. Takes an inventory slot.
- Potions and scrolls start unidentified ("red potion"); the mapping is shuffled per run. Using one identifies it; so do identify scrolls and altars.
- Some unidentified potions are harmful. Some potions affect the target when thrown.
- Throwing weapons: throw_item at an entity id, position or direction. They land and can be picked up again.
- The relic (retrieve_relic) has no effect; extract on stairs while carrying it.
- Lifeline: camp gives one per expedition. use_item it to return to camp after ${r.lifeline.turns} turns (${r.lifeline.pct}% of the haul is banked). It cannot be dropped or thrown and does not count toward capacity.
- Features: fountain (heal, once), altar (identify inventory, once). Traps are hidden until found (search happens when adjacent). Known traps are avoided by pathing.`,
    observation: `# Observation and the turn block
- Every response has turn: state (your_turn / waiting_others / at_camp / expedition_ended / run_ended), turn_no, reason, awaiting (action / camp_choice / nothing), changes (important changes since your last response). The final ▶ line of the text says the same.
- change codes: new_hostile (first time this run), reappeared, killed (by you), died_seen, hostile_gone (left view without dying), hp_dropped, hp_low, status_gained, status_lost, level_up, item_found, stairs_found, floor_changed, objective_progress, objective_complete, can_extract. alerts = current state, changes = what changed.
- Every action outcome states how many attacks you took until your next turn, how many hit and the total damage (HP before/after, plus "healed +N" if you recovered in between).
- summary, alerts (enemy_adjacent, low_hp, critical_hp, incoming, lethal_range, escape, poisoned, on_stairs, item_here, inventory_full, new_floor, can_extract, at_camp, ...; incoming and escape carry numbers in data).
- expedition: objective, progress, can_extract, extract_blocked_by, extract_outcome (complete / withdraw if you extract now). At camp, camp lists the next offers.
- Wounded monsters running away carry fleeing; a fleeing monster does not block extract or resting.
- self: hp, level, statuses, position, equipment, inventory (brief: compact line; full: details), turns, speed, score (banked points and completed expeditions), rest_estimate (when hurt).
- visible.monsters: id, name, pos, dir, dist, hp_state, awareness (asleep/unaware/hunting), speed, traits, threat, first_seen, worst_hit, hits, role, damage_seen, hp_left_est, shot (clear / blocked), bounty. Items (same kind on one cell merged; all your thrown items on one line with the count and the nearest position, marked mine; treasure has value) / players / features too.
- expedition.haul: the unbanked haul (total, multiplier_pct, parts, if_extract_now, if_lifeline_now, next_overreach, next_camp, next_camp_after_crossing). self.floor: draft and explored. expedition.sense: on the target floor, the direction to the guardian/relic and whether it is within 10. camp.offers: slot, traits, multiplier_pct, recommended_level, level_gap, trait_danger.
- Remembered items in view: nearest 3 only (none while a hunting enemy is in view); the rest as a count (see get_map). navigation.unsighted counts cells whose terrain is known but not yet seen.
- rest_estimate is omitted while you cannot rest (a hunting enemy is in view).
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
