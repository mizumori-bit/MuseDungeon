// 情報パネル（Preact）。表示名は公開カタログ、状態は PlayerView / World から。
import type { AgentActivity, Alert, Catalog, CommandRecord, PlayerView, RunSummary, World } from '@muse/shared';
import { hpState, itemDisplayName, kindName, nameOf, xpForLevel } from '@muse/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PLAYER_COLORS } from '../render/scene';
import { getLocale, tr } from '../util';

function HpBar({ hp, max }: { hp: number; max: number }) {
  const frac = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
  const color = frac > 0.6 ? '#4caf50' : frac > 0.35 ? '#ffc107' : frac > 0.2 ? '#ff7043' : '#e53935';
  return (
    <div class="hpbar"><div style={{ width: `${frac * 100}%`, background: color }} /><span>{hp}/{max}</span></div>
  );
}

export function StatusPanel({ view, catalog }: { view: PlayerView; catalog: Catalog }) {
  const L = getLocale();
  const s = view.self;
  const f = view.floor;
  return (
    <section class="panel">
      <h3>{s.name} <small>{kindName(catalog, L, s.classId)} Lv{s.level}</small></h3>
      <HpBar hp={s.stats.hp} max={s.stats.maxHp} />
      <div class="kv">
        <span>XP</span><span>{s.xp} / {xpForLevel(s.level)}</span>
        <span>{tr('階層', 'Depth')}</span><span>{f ? `${tr('地下', 'B')}${f.depth}${tr('階', 'F')} ${nameOf(catalog.biomes[f.biome]?.name, L, f.biome)}` : '-'}</span>
        <span>{tr('命中/ダメージ', 'Acc/Dmg')}</span><span>+{s.stats.acc} / {s.stats.dmg}{s.stats.might ? (s.stats.might > 0 ? `+${s.stats.might}` : s.stats.might) : ''}</span>
        <span>{tr('回避/装甲', 'Eva/Armor')}</span><span>{s.stats.eva} / {s.stats.armor}</span>
        <span>{tr('状態', 'Status')}</span>
        <span>{s.statuses.length ? s.statuses.map((x) => `${nameOf(catalog.statuses[x.id]?.name, L, x.id)}(${x.turnsLeft})`).join(' ') : tr('なし', 'none')}</span>
        <span>{tr('時刻', 'Time')}</span><span>{f?.time ?? 0}</span>
      </div>
    </section>
  );
}

export type InvAction = 'use' | 'equip' | 'unequip' | 'drop' | 'throw';

export function InventoryPanel({ view, catalog, onAction, focused, selected, onSelect }: {
  view: PlayerView; catalog: Catalog; onAction?: (a: InvAction, slot: string) => void; focused?: boolean; selected?: string | null; onSelect?: (slot: string) => void;
}) {
  const L = getLocale();
  return (
    <section class={`panel inv ${focused ? 'focused' : ''}`}>
      <h3>{tr('所持品', 'Inventory')} <small>{view.inventory.length}/{view.self.capacity}</small></h3>
      {view.inventory.length === 0 && <div class="muted">{tr('なし', 'empty')}</div>}
      <ul>
        {view.inventory.map((it) => {
          const ci = it.kind ? catalog.items[it.kind] : undefined;
          const cat = ci?.category ?? (it.appearanceId ? catalog.appearances[it.appearanceId]?.category : undefined);
          const usable = cat === 'potion' || cat === 'scroll' || ci?.usable;
          const throwable = ci?.throwable || cat === 'throwing' || cat === 'potion';
          const name = itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes);
          return (
            <li key={it.id} class={selected === it.slot ? 'sel' : ''} onClick={() => onSelect?.(it.slot)} title={ci ? nameOf(ci.desc, L, '') : tr('未鑑定', 'unidentified')}>
              <span class="slot">{it.slot})</span>
              <span class="name">{name}{it.qty > 1 ? ` x${it.qty}` : ''}{it.equipped ? <em> [{tr('装備', 'eq')}]</em> : null}{it.kind === null ? <em class="muted"> ?</em> : null}</span>
              {onAction && (
                <span class="acts">
                  {usable && <button class="tiny" onClick={(e) => { e.stopPropagation(); onAction('use', it.slot); }}>{tr('使う', 'Use')}</button>}
                  {ci?.slot && !it.equipped && <button class="tiny" onClick={(e) => { e.stopPropagation(); onAction('equip', it.slot); }}>{tr('装備', 'Equip')}</button>}
                  {it.equipped && <button class="tiny" onClick={(e) => { e.stopPropagation(); onAction('unequip', it.slot); }}>{tr('外す', 'Remove')}</button>}
                  {throwable && !it.equipped && <button class="tiny" onClick={(e) => { e.stopPropagation(); onAction('throw', it.slot); }}>{tr('投げる', 'Throw')}</button>}
                  <button class="tiny" onClick={(e) => { e.stopPropagation(); onAction('drop', it.slot); }}>{tr('置く', 'Drop')}</button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface LogLine { seq: number; text: string; kind?: 'error' | 'info' | 'chat' | 'thought' }

export function MessageLog({ lines, title }: { lines: LogLine[]; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, lines[lines.length - 1]?.seq]);
  return (
    <section class="panel log">
      <h3>{title ?? tr('メッセージ', 'Messages')}</h3>
      <div class="lines" ref={ref}>
        {lines.slice(-200).map((l, i) => <div key={`${l.seq}-${i}`} class={`line ${l.kind ?? ''}`}>{l.text}</div>)}
      </div>
    </section>
  );
}

export function AlertsBar({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return null;
  return (
    <div class="alerts">
      {alerts.map((a) => <span key={a.code} class={`alert ${a.code}`}>{a.text}</span>)}
    </div>
  );
}

export function PartyPanel({ world, catalog, follow, onFollow }: { world: World; catalog: Catalog; follow: string | null; onFollow?: (pid: string) => void }) {
  const L = getLocale();
  return (
    <section class="panel">
      <h3>{tr('パーティ', 'Party')}</h3>
      <ul class="party">
        {world.playerOrder.map((pid, i) => {
          const p = world.players[pid];
          const e = world.entities[p.entityId];
          const depth = e?.pos ? world.floors[e.pos.floor]?.depth : null;
          const hs = e?.stats ? hpState(e.stats.hp, e.stats.maxHp) : null;
          return (
            <li key={pid} class={follow === pid ? 'sel' : ''} onClick={() => onFollow?.(pid)}>
              <span class="dot" style={{ background: PLAYER_COLORS[i % PLAYER_COLORS.length] }} />
              <b>{p.name}</b> <small>{kindName(catalog, L, p.classId)} Lv{e?.level?.level ?? 1}</small>
              <span class={`tag ${p.controller.kind}`}>{p.controller.kind === 'agent' ? 'AI' : tr('人間', 'human')}</span>
              <div class="sub">
                {p.state === 'alive'
                  ? <>{depth ? `${tr('地下', 'B')}${depth}` : ''} {e?.stats && <HpBar hp={e.stats.hp} max={e.stats.maxHp} />} {hs && <span class="muted">{hs}</span>}</>
                  : <span class="muted">{p.state === 'dead' ? tr('死亡', 'dead') : tr('離脱', 'left')}{p.stats.deathCause ? ` (${kindName(catalog, L, p.stats.deathCause)})` : ''}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface ThoughtLine { seq: number; player: string; name: string; text: string }

export function AiPanel({ thoughts, activities, commands, observationText }: {
  thoughts: ThoughtLine[]; activities?: AgentActivity[]; commands?: CommandRecord[]; observationText: string | null;
}) {
  const [tab, setTab] = useState<'thought' | 'calls' | 'obs'>('thought');
  return (
    <section class="panel ai">
      <h3>
        {tr('AI パネル', 'AI panel')}
        <span class="tabs">
          <button class={`tiny ${tab === 'thought' ? 'on' : ''}`} onClick={() => setTab('thought')}>{tr('思考', 'Thoughts')}</button>
          <button class={`tiny ${tab === 'calls' ? 'on' : ''}`} onClick={() => setTab('calls')}>{tr('ツール呼び出し', 'Tool calls')}</button>
          <button class={`tiny ${tab === 'obs' ? 'on' : ''}`} onClick={() => setTab('obs')}>{tr('観測テキスト', 'Observation')}</button>
        </span>
      </h3>
      {tab === 'thought' && (
        <div class="lines">
          {thoughts.length === 0 && <div class="muted">{tr('まだ thought はありません', 'No thoughts yet')}</div>}
          {thoughts.slice(-30).reverse().map((t) => <div key={t.seq} class="line thought"><b>{t.name}</b> <small>#{t.seq}</small><br />{t.text}</div>)}
        </div>
      )}
      {tab === 'calls' && (
        <div class="lines">
          {activities && activities.slice(-20).reverse().map((a, i) => (
            <details key={`${a.seq}-${i}`} class="call">
              <summary><code>{a.tool}</code> {JSON.stringify(a.args)} <small>#{a.seq}</small></summary>
              <pre>{a.text}</pre>
            </details>
          ))}
          {commands && commands.slice(-20).reverse().map((c) => (
            <div key={c.cseq} class="call"><code>{c.command.type}</code> {JSON.stringify(c.command)} <small>{c.source} #{c.resultSeq?.[0] ?? '-'}</small>{c.thought ? <div class="thought">💭 {c.thought}</div> : null}</div>
          ))}
          {!activities?.length && !commands?.length && <div class="muted">{tr('記録なし', 'None')}</div>}
        </div>
      )}
      {tab === 'obs' && <pre class="obs">{observationText ?? tr('（プレイヤーを選択）', '(select a player)')}</pre>}
    </section>
  );
}

export function SummaryDialog({ summary, catalog, onClose }: { summary: RunSummary; catalog: Catalog | null; onClose: () => void }) {
  const L = getLocale();
  return (
    <div class="modal" onClick={onClose}>
      <div class="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('冒険の記録', 'Run summary')}</h2>
        <p class="muted">{summary.reason}{summary.seed ? ` / seed: ${summary.seed}` : ''}</p>
        <table>
          <thead><tr><th>{tr('名前', 'Name')}</th><th>{tr('到達', 'Deepest')}</th><th>Lv</th><th>{tr('撃破', 'Kills')}</th><th>{tr('手数', 'Turns')}</th><th>{tr('死因', 'Cause')}</th><th>{tr('スコア', 'Score')}</th></tr></thead>
          <tbody>
            {summary.players.map((p) => (
              <tr key={p.id}><td>{p.name}</td><td>{p.deepest}</td><td>{p.level}</td><td>{p.kills}</td><td>{p.turns}</td><td>{p.deathCause ? (catalog ? kindName(catalog, L, p.deathCause) : p.deathCause) : '-'}</td><td>{p.score}</td></tr>
            ))}
          </tbody>
        </table>
        <div class="row">
          <a class="button" href={`#/replay/${summary.runId}`}>{tr('リプレイを見る', 'Watch replay')}</a>
          <a class="button" href="#/">{tr('ロビーへ', 'Lobby')}</a>
          <button onClick={onClose}>{tr('閉じる', 'Close')}</button>
        </div>
      </div>
    </div>
  );
}
