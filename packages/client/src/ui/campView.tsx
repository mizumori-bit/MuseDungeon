// 自分で潜るときのキャンプ（S16c。SEASON.md §70.5）: 遊ぶ画面で、キャンプにいる間は、地図の代わりにこの 1 枚を出す（拠点・支度と同じ札・余白・色）。
// 上から「今、決めること」（特技・加護の候補 → 次の遠征の目的と、主のボタン「この目的で、出発」）、その下に「見るだけのもの」（シーズン・記録庫・能力と持ち物・メモ・ログ・できること）。
// 出す命令は前と同じ（start_expedition・choose_perk・choose_boon・report_stairs・retire・say）。出す情報も前と同じ（目的の札の「くわしく」に、候補の文＝AI に届く形）。
// 断りと知らせは主のボタンの下、キャンプに着いた手番の変化は前の遠征の結果の札の中（S16d）。拠点のタブは出さない（見出しの「← 拠点へ」だけ）。
// キャンプの絵（ASSET_SPEC §7.7）は、テーマに絵があれば、いちばん上の札の帯に出す（地図は出さない。絵は情報を運ばない）。
import type { Catalog, Change, Observation, PlayerView } from '@muse/shared';
import { itemDisplayName, kindName, nameOf, slayGroupText, slaysAt } from '@muse/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Theme } from '../theme';
import { getLocale, tr } from '../util';
import { BoonChoicePanel, PerkChoicePanel } from './build';
import { CampScene } from './camp';
import { DecideCard, FoldCard, ObjectiveList, offerTextsOf, UndecidedDialog } from './campCards';
import { CampRecords, NotesBlock, ResultBlock, rulesOf } from './expedition';
import { HubPill } from './hub';
import { campClosedOf, campHeadline, campStart, pickFor, type CampPick } from './objectiveCard';
import { InventoryPanel, MessageLog, ObsPartyPanel, StatusPanel, carriedCount, type LogLine } from './panels';
import { prepLine } from './prepState';
import { SeasonCampPanel } from './season';

export function CampView({ runId, view, obs, catalog, theme, perkFocused, perkSent, onChoosePerk, onChooseBoon, onStart, onRetire, onReport, log, onSay, notice, turnText, changes, onDialog }: {
  runId: string; view: PlayerView; obs: Observation | null; catalog: Catalog | null; theme: Theme | null;
  /** p で特技の候補に番号の受付を向けている・選んで返事を待っている */
  perkFocused: boolean; perkSent: boolean;
  onChoosePerk: (option: number) => void; onChooseBoon: (option: number) => void;
  onStart: (offer: number | 'endless') => void; onRetire: () => void; onReport: () => void;
  log: LogLine[]; onSay: (text: string) => void;
  /** 断りと知らせ（遊ぶ画面の flash。S16d: 主のボタンのすぐ下に出す。出発の断り＝協力の still_inside・予算・シーズンの終わり など） */
  notice?: ComponentChildren;
  /** ▶ の状態行と、前の手番からの変化（S16d: キャンプに着いた手番の変化＝レベルが上がった・持ち主が決めた・納めた欠片 など。前の遠征の結果の札の中に出す） */
  turnText?: string; changes?: readonly Change[];
  /** 確かめの窓を開いた・閉じた（S16d: 開いている間は、遊ぶ画面のキーの受け口を止める） */
  onDialog?: (open: boolean) => void;
}) {
  const L = getLocale();
  const rules = rulesOf(catalog);
  const camp = view.camp;
  const x = view.expedition;
  const rec = view.record;
  const first = !x;
  const name = view.self.name;
  const [picked, setPicked] = useState<CampPick | null>(null);
  const [confirm, setConfirmState] = useState<string[] | null>(null);
  const setConfirm = (v: string[] | null) => { setConfirmState(v); onDialog?.(v !== null); };
  // 画面を離れる（迷宮へ出た）ときは、キーの受け口を戻す
  useEffect(() => () => onDialog?.(false), []);
  const [chat, setChat] = useState('');
  const selected = pickFor(picked, camp?.nextNo ?? null, camp?.offers ?? []);
  const closed = campClosedOf(view.season);
  const perk = view.status !== 'dead' && view.status !== 'ended' ? obs?.self.perk_choice : undefined;
  const boon = view.self.boonChoice;
  const start = campStart({ selected, waiting: !camp, closed, perk, boon });
  const art = !!theme?.sceneArt?.('scene:camp');
  const className = catalog ? kindName(catalog, L, view.self.classId) : view.self.classId;
  const equipNames = catalog
    ? (['weapon', 'armor', 'accessory'] as const).map((s) => view.inventory.find((i) => i.equipped === s)).filter((i): i is NonNullable<typeof i> => !!i)
      .map((i) => itemDisplayName(catalog, L, i.kind, i.appearanceId, i.affixes))
    : [];
  const perkNames = catalog ? view.self.build.perks.map((id) => nameOf(catalog.perks[id]?.name, L, id.split(':').pop() ?? id)) : [];
  const boonNames = catalog ? view.self.boons.map((id) => nameOf(catalog.boons?.[id]?.name, L, id.split(':').pop() ?? id)) : [];
  const slayDepths = [...new Set((view.season?.slays ?? []).map((s) => s.depth))].sort((a, b) => a - b);
  const canReport = !!obs?.valid_actions.some((l) => l.startsWith('report_stairs'));
  const go = () => { if (selected !== null) onStart(selected); };
  const press = () => {
    if (!start.canStart || selected === null) return;
    if (start.confirm) setConfirm(start.confirm);
    else go();
  };

  return (
    <>
      {/* 遊ぶ画面では、拠点のタブは出さない（見出しの「← 拠点へ」だけ。S16d） */}
      <div class="hub camp">
        <div class="hub-col">
          {/* いちばん上の札: だれが・今どこに・成績・前の遠征の結果 */}
          <section class="prep-hero camp-hero">
            {art && <div class="camp-art"><CampScene theme={theme} /></div>}
            <header class="hub-cardhead">
              <div class="hub-who">
                <h1 class="hub-name">{name}</h1>
                <div class="hub-sub">{[className, `Lv${view.self.level}`, `HP ${view.self.stats.hp}/${view.self.stats.maxHp}`].filter(Boolean).join(' · ')}</div>
              </div>
              <div class="hub-pills">
                <HubPill text={tr('キャンプ', 'At camp')} tone="green" />
                {closed && <HubPill text={tr('終わり', 'Done')} tone="muted" />}
              </div>
            </header>
            <p class="prep-headline">{campHeadline({ first, waiting: !camp, closed, pendingChoice: !!(perk || boon) })}</p>
            <p class="hub-note">{tr('盤面の外にいる（時間は進まない）。ここで終えてもよい。', 'You are off the board (time does not pass). You may stop here.')}</p>
            <dl class="hub-stats">
              <div><dt>{tr('確定点', 'Banked')}</dt><dd>{rec.banked}</dd></div>
              <div><dt>{tr('達成した遠征', 'Completed')}</dt><dd>{rec.expeditions}</dd></div>
              {!first && <div><dt>{tr('最深到達', 'Deepest')}</dt><dd>{tr(`地下${view.deepestDepth}階`, `Depth ${view.deepestDepth}`)}</dd></div>}
              {rec.lost > 0 && <div><dt>{tr('失った戦利品', 'Haul lost')}</dt><dd class="low">{rec.lost}</dd></div>}
              {view.season && <div><dt>{tr('残りの手番', 'Turns left')}</dt><dd class={view.season.budgetLeft < Math.min(100, Math.ceil(view.season.budget.limit / 10)) ? 'low' : ''}>{view.season.budgetLeft}<small> / {view.season.budget.limit}</small></dd></div>}
            </dl>
            {x?.result && <div class="camp-result"><ResultBlock x={x} playerId={view.playerId} rules={rules} /></div>}
            {/* キャンプに着いた手番の変化（S16d。迷宮の画面の TurnBar と同じ中身: 守護者が倒れた・レベルが上がった・持ち主が決めた・納めた欠片 など） */}
            {(changes?.length ?? 0) > 0 && (
              <div class="camp-result camp-changes">
                <div class="camp-changeshead">{tr('前の手番からの変化', 'Since your last turn')}</div>
                <ul>{changes!.map((c, i) => <li key={`${c.code}-${i}`} class={`chg ${c.code}`}>{c.text}</li>)}</ul>
              </div>
            )}
            {turnText && <p class="camp-turnline" title={turnText}>{turnText}</p>}
          </section>

          {/* 今、決めること 1: 特技・加護の候補（手番を使わない。遠征の中でも選べる: 特技は p、加護は地図の上の枠） */}
          {perk && (
            <DecideCard title={tr('特技を選ぶ', 'Choose a perk')} held line={prepLine('perks', { name, held: true, perks: perkNames, boons: boonNames })}>
              <div class="prep-body">
                <PerkChoicePanel choice={perk} catalog={catalog} classId={view.self.classId} focused={perkFocused} sent={perkSent} onChoose={onChoosePerk} />
              </div>
            </DecideCard>
          )}
          {boon && (
            <DecideCard title={tr('加護を選ぶ', 'Choose a boon')} held>
              <div class="prep-body"><BoonChoicePanel choice={boon} catalog={catalog} onChoose={onChooseBoon} /></div>
            </DecideCard>
          )}

          {/* 今、決めること 2: 次の遠征の目的（支度の画面と同じ札）と、主のボタン */}
          <DecideCard title={camp ? tr(`次の遠征の目的（遠征 ${camp.nextNo}）`, `Objective for expedition ${camp.nextNo}`) : tr('次の遠征の目的', 'Next objective')} held extraClass="camp-objective">
            {camp && !closed && (
              <ObjectiveList offers={camp.offers} rules={rules} level={view.self.level} view={view} catalog={catalog} fullTexts={offerTextsOf(obs?.camp)}
                chosen={selected} selectLabel={tr('この目的を選ぶ', 'Choose this')} onSelect={(pick) => setPicked({ no: camp.nextNo, pick })} />
            )}
            <div class="camp-go">
              <button class="hub-btn primary big" disabled={!start.canStart} onClick={press}>{start.label}</button>
              {start.hint && <p class="hub-note">{start.hint}</p>}
              {/* 断りと知らせ（S16d C1: 押して断られたときに、何も起きないように見えないように） */}
              {notice && <div class="camp-notice">{notice}</div>}
            </div>
          </DecideCard>

          {/* 見るだけのもの（小さく・たたむ） */}
          {obs?.season && (
            <DecideCard title={tr('シーズン', 'Season')} extraClass="camp-small">
              <div class="prep-body"><SeasonCampPanel season={obs.season} canReport={canReport} onReport={onReport} /></div>
            </DecideCard>
          )}
          {catalog && slayDepths.length > 0 && (
            <FoldCard title={tr('記録庫・討伐の記録', 'Archive: warden kills')} summary={slayDepths.map((d) => tr(`地下${d}階`, `Depth ${d}`)).join(tr('・', ', '))}>
              <ul class="camp-slays">{slayDepths.map((depth) => (
                <li key={depth}><b>{tr(`地下${depth}階`, `Depth ${depth}`)}</b>{slaysAt(L, catalog, view, depth).map((r, i) => <div key={i} class="slay">{slayGroupText(L, [r])}</div>)}</li>
              ))}</ul>
            </FoldCard>
          )}
          {catalog && (
            <FoldCard title={tr('能力・装備・持ち物', 'Stats, gear and inventory')}
              summary={`${prepLine('loadout', { name, held: true, equipment: equipNames })}${tr('・', ' · ')}${tr('所持品', 'items')} ${carriedCount(view, catalog)}/${view.self.capacity}`}>
              <StatusPanel view={view} catalog={catalog} speed={obs?.self.speed} floor={null} />
              <InventoryPanel view={view} catalog={catalog} />
              <p class="prep-cost">{tr('装備の付け替え・使う・捨てるは、遠征の中で（キャンプでは見るだけ）。', 'Equipping, using and dropping happen during an expedition (at camp you can only look).')}</p>
            </FoldCard>
          )}
          {view.notes.length > 0 && (
            <FoldCard title={tr('メモ', 'Notes')} summary={tr(`${view.notes.length} 件`, `${view.notes.length}`)}>
              <NotesBlock notes={view.notes} />
            </FoldCard>
          )}
          {obs && obs.party.length > 0 && (
            <FoldCard title={tr('仲間', 'Party')} summary={tr(`${obs.party.length} 人`, `${obs.party.length}`)} open>
              <ObsPartyPanel party={obs.party} />
            </FoldCard>
          )}
          <FoldCard title={tr('ログ', 'Log')} summary={log.length ? log[log.length - 1].text : null}>
            <MessageLog lines={log} />
            <form class="chat" onSubmit={(e) => { e.preventDefault(); if (chat.trim()) { onSay(chat.trim().slice(0, 280)); setChat(''); } }}>
              <input class="hub-input" value={chat} placeholder={tr('チャット（COOP）', 'Chat (COOP)')} onInput={(e) => setChat((e.target as HTMLInputElement).value)} />
            </form>
          </FoldCard>
          {obs && (
            <FoldCard title={tr('できること', 'Valid actions')} summary={tr(`${obs.valid_actions.length} 件`, `${obs.valid_actions.length}`)}>
              <p class="prep-cost">{obs.valid_actions.join(' / ')}</p>
            </FoldCard>
          )}
          <div class="camp-foot">
            {camp && <CampRecords runId={runId} nextNo={camp.nextNo} />}
            <p class="hub-note">{tr('キー: p 特技の候補を番号で選ぶ（もう一度 p で戻る）・Esc 取消', 'Keys: p to choose a perk by number (p again to go back), Esc to cancel')}</p>
            <button class="hub-btn small camp-retire" onClick={onRetire}>{tr('引退してランを終える', 'Retire (end the run)')}</button>
          </div>
        </div>
      </div>
      {confirm && (
        <UndecidedDialog items={confirm}
          note={tr('このまま出発してもよい（遠征の中でも選べる。特技は p、加護は地図の上の枠で。手番は使わない）。', 'You may set out anyway (you can still choose during the expedition: a perk with p, a boon in the box above the map; it uses no turn).')}
          goLabel={tr('このまま出発', 'Set out anyway')} onBack={() => setConfirm(null)} onGo={() => { setConfirm(null); go(); }} />
      )}
    </>
  );
}
