// イベント → 文章（ja / en）。入力はプレイヤー向けに縮約済みのイベントのみ。
import type { Catalog } from './catalog';
import { nameOf } from './catalog';
import { endReasonText, objectiveText } from './expedition';
import type { ProjectedEvent } from './filter';
import type { Locale } from './types';
import { dirTo } from './util';
import type { Pos } from './types';

export interface NarrateCtx {
  locale: Locale;
  catalog: Catalog;
  selfId: string | null;
  /** entityId → プレイヤー名 */
  playerNames: Record<string, string>;
  selfPos?: Pos | null;
}

const DIR_JA: Record<string, string> = { n: '北', ne: '北東', e: '東', se: '南東', s: '南', sw: '南西', w: '西', nw: '北西' };
const DIR_EN: Record<string, string> = { n: 'north', ne: 'northeast', e: 'east', se: 'southeast', s: 'south', sw: 'southwest', w: 'west', nw: 'northwest' };

export function kindName(catalog: Catalog, locale: Locale, kind: string | null, appearanceId?: string | null): string {
  if (kind) {
    const n = catalog.monsters[kind]?.name ?? catalog.items[kind]?.name ?? catalog.classes[kind]?.name
      ?? catalog.features[kind]?.name ?? catalog.terrain[kind]?.name;
    if (n) return nameOf(n, locale);
  }
  if (appearanceId) {
    const a = catalog.appearances[appearanceId];
    if (a) return nameOf(a.name, locale);
  }
  return locale === 'en' ? 'something' : '何か';
}

function who(ctx: NarrateCtx, id: unknown, kind: unknown, affixes?: unknown): string {
  if (typeof id === 'string' && id === ctx.selfId) return ctx.locale === 'en' ? 'you' : 'あなた';
  if (typeof id === 'string' && ctx.playerNames[id]) return ctx.playerNames[id];
  const base = kindName(ctx.catalog, ctx.locale, (kind as string | null) ?? null);
  const af = Array.isArray(affixes) ? (affixes as string[]).map((a) => nameOf(ctx.catalog.affixes[a]?.name, ctx.locale, a)) : [];
  if (!af.length) return base;
  return ctx.locale === 'en' ? `${af.join(' ')} ${base}` : `${af.join('')}${base}`;
}

function itemName(ctx: NarrateCtx, ev: Record<string, unknown>): string {
  const base = kindName(ctx.catalog, ctx.locale, (ev.kind as string | null) ?? null, (ev.appearanceId as string | null) ?? null);
  const affixes = Array.isArray(ev.affixes) && ev.kind ? (ev.affixes as string[]) : [];
  if (!affixes.length) return base;
  const af = affixes.map((a) => nameOf(ctx.catalog.affixes[a]?.name, ctx.locale, a));
  return ctx.locale === 'en' ? `${af.join(' ')} ${base}` : `${af.join('')}${base}`;
}

const DIR_FROM_JA: Record<string, string> = { n: '北', ne: '北東', e: '東', se: '南東', s: '南', sw: '南西', w: '西', nw: '北西' };

function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** 文章化。表示する価値の無いイベントは null */
export function narrate(evIn: ProjectedEvent, ctx: NarrateCtx): string | null {
  const ev = evIn as unknown as Record<string, any>;
  const L = ctx.locale;
  const ja = L === 'ja';
  const self = ctx.selfId;
  switch (ev.type) {
    case 'attack': {
      if (ev.hit && !ev.crit) return null;
      const unseen = ev.attacker === null && ev.fromDir ? (ja ? `${DIR_FROM_JA[ev.fromDir]}からの何か` : `something from the ${DIR_EN[ev.fromDir]}`) : null;
      const a = unseen ?? who(ctx, ev.attacker, ev.attackerKind, ev.attackerAffixes);
      const tg = who(ctx, ev.target, ev.targetKind, ev.targetAffixes);
      if (ev.crit) return ja ? `${a}の会心の一撃！` : `${cap(a)} land${ev.attacker === self ? '' : 's'} a critical hit!`;
      if (ja) return ev.attacker === self ? `${tg}への攻撃は外れた。` : `${a}の${ev.ranged ? '射撃' : '攻撃'}は${tg === 'あなた' ? 'あなたに' : tg + 'に'}当たらなかった。`;
      return `${cap(a)} miss${ev.attacker === self ? '' : 'es'} ${tg}.`;
    }
    case 'damaged': {
      const tg = who(ctx, ev.target, ev.targetKind, ev.targetAffixes);
      const src = ev.source ? who(ctx, ev.source, ev.sourceKind, ev.sourceAffixes) : null;
      // 実際に減った HP（とどめの超過分を含めない）
      const amt = ev.dealt ?? ev.amount;
      if (amt <= 0 && ev.amount <= 0) return null;
      if (ev.via === 'poison') return ja ? `${tg}は毒で ${amt} ダメージを受けた。` : `${cap(tg)} take${ev.target === self ? '' : 's'} ${amt} poison damage.`;
      if (ev.via === 'trap') return ja ? `${tg}は罠で ${amt} ダメージを受けた。` : `${cap(tg)} take${ev.target === self ? '' : 's'} ${amt} damage from a trap.`;
      if (ev.source === self) return ja ? `あなたは${tg}に ${amt} ダメージを与えた。` : `You hit ${tg} for ${amt}.`;
      const verb = ev.via === 'ranged' ? (ja ? '射撃' : 'shot') : (ja ? '攻撃' : 'attack');
      if (ev.target === self) {
        if (!src && ev.fromDir) {
          return ja ? `${DIR_FROM_JA[ev.fromDir]}から${ev.via === 'ranged' ? '飛んできた何か' : '何か'}の${verb}。あなたは ${amt} ダメージを受けた。` : `A ${verb} from the ${DIR_EN[ev.fromDir]} hits you for ${amt}.`;
        }
        return ja ? `${src ?? '何か'}の${verb}。あなたは ${amt} ダメージを受けた。` : `${cap(src ?? 'something')}'s ${verb} hits you for ${amt}.`;
      }
      return ja ? `${src ?? '何か'}が${tg}に ${amt} ダメージを与えた。` : `${cap(src ?? 'something')} hits ${tg} for ${amt}.`;
    }
    case 'healed': {
      // 自然回復・休息は 1 ずつ頻繁に起きるので文章にしない（rest の結果に合計が出る）
      if (ev.via === 'regen' || ev.via === 'rest') return null;
      const tg = who(ctx, ev.target, ev.targetKind);
      return ja ? `${tg}は ${ev.amount} 回復した。` : `${cap(tg)} recover${ev.target === self ? '' : 's'} ${ev.amount} HP.`;
    }
    case 'max_hp_changed':
      return ja ? `最大 HP が ${ev.maxHpAfter} になった。` : `Your max HP is now ${ev.maxHpAfter}.`;
    case 'died': {
      const v = who(ctx, ev.id, ev.kind, ev.affixes);
      if (ev.id === self) return ja ? 'あなたは死んだ……' : 'You die...';
      const hpNote = typeof ev.maxHp === 'number' ? (ja ? `（この${v}の体力は ${ev.maxHp} だった）` : ` (it had ${ev.maxHp} HP)`) : '';
      if (ev.killer === self) return ja ? `${v}を倒した。${hpNote}` : `You kill ${v}.${hpNote}`;
      return ja ? `${v}は倒れた。${hpNote}` : `${cap(v)} dies.${hpNote}`;
    }
    case 'status_applied': {
      const tg = who(ctx, ev.target, ev.targetKind, ev.targetAffixes);
      const st = nameOf(ctx.catalog.statuses[ev.status?.id]?.name, L, ev.status?.id);
      return ja ? `${tg}は${st}状態になった。` : `${cap(tg)} ${ev.target === self ? 'are' : 'is'} now ${st}.`;
    }
    case 'status_expired': {
      const tg = who(ctx, ev.target, ev.targetKind);
      const st = nameOf(ctx.catalog.statuses[ev.statusId]?.name, L, ev.statusId);
      return ja ? `${tg}の${st}状態が解けた。` : `${cap(tg)} ${ev.target === self ? 'are' : 'is'} no longer ${st}.`;
    }
    case 'level_up': {
      // 上がった能力値を並べる（V3-2R §14.5）
      const g = ev.gains;
      const ups = g ? ([[g.maxHp, '最大HP', 'max HP'], [g.acc, '命中', 'acc'], [g.might, '威力', 'might'], [g.eva, '回避', 'eva']] as [number, string, string][])
        .filter(([v]) => v > 0).map(([v, j, e]) => (ja ? `${j}+${v}` : `${e} +${v}`)) : [];
      const tail = ups.length ? (ja ? `（${ups.join('・')}）` : ` (${ups.join(', ')})`) : '';
      return ja ? `レベル ${ev.levelAfter} に上がった！${tail}` : `You reach level ${ev.levelAfter}!${tail}`;
    }
    case 'xp_gained':
      return null;
    case 'item_picked_up': {
      const n = itemName(ctx, ev);
      const q = ev.qty > 1 ? ` x${ev.qty}` : '';
      if (ev.actor === self && ev.auto) return ja ? `${n}${q}を回収した（${ev.slot}）。` : `You recover ${n}${q} (${ev.slot}).`;
      if (ev.actor === self) return ja ? `${n}${q}を拾った（${ev.slot}）。` : `You pick up ${n}${q} (${ev.slot}).`;
      return ja ? `${who(ctx, ev.actor, null)}は${n}を拾った。` : `${cap(who(ctx, ev.actor, null))} picks up ${n}.`;
    }
    case 'item_dropped': {
      const n = itemName(ctx, ev);
      if (ev.actor === self) return ja ? `${n}を置いた。` : `You drop ${n}.`;
      if (ev.actor === null || ev.actor === undefined) return null;
      return ja ? `${who(ctx, ev.actor, null)}は${n}を落とした。` : `${cap(who(ctx, ev.actor, null))} drops ${n}.`;
    }
    case 'item_equipped':
      return ev.actor === self ? (ja ? `${itemName(ctx, ev)}を装備した。` : `You equip ${itemName(ctx, ev)}.`) : null;
    case 'item_unequipped':
      return ev.actor === self ? (ja ? `${itemName(ctx, ev)}を外した。` : `You unequip ${itemName(ctx, ev)}.`) : null;
    case 'item_used': {
      const n = itemName(ctx, ev);
      const a = who(ctx, ev.actor, null);
      const verbJa = ev.category === 'potion' ? '飲んだ' : ev.category === 'scroll' ? '読んだ' : '使った';
      const verbEn = ev.category === 'potion' ? 'drink' : ev.category === 'scroll' ? 'read' : 'use';
      if (ev.actor === self) return ja ? `${n}を${verbJa}。` : `You ${verbEn} ${n}.`;
      return ja ? `${a}は${n}を${verbJa}。` : `${cap(a)} ${verbEn}s ${n}.`;
    }
    case 'item_thrown': {
      const n = itemName(ctx, ev);
      const a = who(ctx, ev.actor, ev.actorKind);
      const hit = ev.hit ? who(ctx, ev.hit, ev.hitKind, ev.reachedAffixes) : null;
      const reached = ev.reached ? who(ctx, ev.reached, ev.reachedKind, ev.reachedAffixes) : (ja ? '何か' : 'something');
      const at = ev.landed ? `(${ev.landed.x},${ev.landed.y})` : '';
      const fall = ev.broke ? (ja ? '砕け散った。' : ' It shatters.') : at ? (ja ? `${at} に落ちた。` : ` It lands at ${at}.`) : '';
      if (!ev.outcome) {
        if (ja) return `${a}は${n}を投げた。${hit ? `${hit}に命中した。` : ''}${ev.broke ? '砕け散った。' : ''}`;
        return `${cap(a)} throw${ev.actor === self ? '' : 's'} ${n}.${hit ? ` It hits ${hit}.` : ''}${ev.broke ? ' It shatters.' : ''}`;
      }
      if (ja) {
        const head = `${a}は${n}を投げた。`;
        switch (ev.outcome) {
          case 'hit': return `${head}${hit ?? reached}に命中した。${fall}`;
          case 'missed': return `${head}${reached}には当たらず、${fall || '消えた。'}`;
          case 'blocked': return ev.blockedBy === 'actor'
            ? `${head}途中の${reached}${hit ? 'に当たった。' : 'に阻まれ、'}${hit ? fall : fall || '消えた。'}`
            : `${head}壁に当たり、${fall || '砕けた。'}`;
          case 'fell_short': return `${head}届かず、${fall || '消えた。'}`;
          default: return `${head}${fall || ''}`;
        }
      }
      const head = `${cap(a)} throw${ev.actor === self ? '' : 's'} ${n}.`;
      switch (ev.outcome) {
        case 'hit': return `${head} It hits ${hit ?? reached}.${fall}`;
        case 'missed': return `${head} It misses ${reached}.${fall}`;
        case 'blocked': return ev.blockedBy === 'actor' ? `${head} ${cap(reached)} is in the way${hit ? ' and is hit' : ''}.${fall}` : `${head} It hits a wall.${fall}`;
        case 'fell_short': return `${head} It falls short.${fall}`;
        default: return `${head}${fall}`;
      }
    }
    case 'item_identified': {
      const real = kindName(ctx.catalog, L, ev.kind);
      const app = ev.appearanceId ? kindName(ctx.catalog, L, null, ev.appearanceId) : null;
      return ja ? `${app ? `${app}は` : ''}${real}だと判明した。` : `${app ? `${cap(app)} is ` : 'Identified: '}${real}.`;
    }
    case 'tile_changed': {
      const t = ctx.catalog.terrain[ev.terrainId as string];
      if (ev.reason === 'door_open') return ev.by === self ? (ja ? '扉を開けた。' : 'You open the door.') : (ja ? '扉が開いた。' : 'A door opens.');
      if (ev.reason === 'door_close') return ev.by === self ? (ja ? '扉を閉めた。' : 'You close the door.') : (ja ? '扉が閉まった。' : 'A door closes.');
      return t ? null : null;
    }
    case 'entity_moved':
      if (ev.mode === 'teleport') return ja ? `${who(ctx, ev.id, ev.kind)}は瞬間移動した。` : `${cap(who(ctx, ev.id, ev.kind))} teleport${ev.id === self ? '' : 's'}.`;
      if (ev.mode === 'swap' && ev.id === self) return ja ? '味方と位置を入れ替えた。' : 'You swap places with your ally.';
      return null;
    case 'entity_changed_floor': {
      const to = ev.to?.floor as string | undefined;
      const depth = to ? to.split(':')[1] : '?';
      if (ev.id === self) {
        return ev.dir === 'down'
          ? (ja ? `階段を降りた。地下${depth}階。` : `You descend to depth ${depth}.`)
          : (ja ? `階段を上った。地下${depth}階。` : `You climb to depth ${depth}.`);
      }
      return ja ? `${who(ctx, ev.id, ev.kind)}は階段を使った。` : `${cap(who(ctx, ev.id, ev.kind))} takes the stairs.`;
    }
    case 'feature_state':
      return null;
    case 'trap_revealed':
      return ja ? `罠を見つけた: ${kindName(ctx.catalog, L, ev.kind)}` : `You find a trap: ${kindName(ctx.catalog, L, ev.kind)}.`;
    case 'trap_triggered': {
      const by = who(ctx, ev.by, ev.byKind);
      return ja ? `${by}は${kindName(ctx.catalog, L, ev.kind)}を作動させた！` : `${cap(by)} trigger${ev.by === self ? '' : 's'} ${kindName(ctx.catalog, L, ev.kind)}!`;
    }
    case 'noise': {
      if (ctx.selfPos && ev.pos) {
        const d = dirTo(ctx.selfPos, ev.pos);
        if (!d) return null;
        return ja ? `${DIR_JA[d]}の方から物音がした。` : `You hear a noise to the ${DIR_EN[d]}.`;
      }
      return ja ? '物音がした。' : 'You hear a noise.';
    }
    case 'chat':
      return `[${ev.name}] ${ev.text}`;
    case 'thought':
      return null;
    case 'player_joined':
      return ja ? `${ev.player?.name} が参加した。` : `${ev.player?.name} joined.`;
    case 'player_state':
      if (ev.state === 'dead') return ja ? `${ctx.playerNames[ev.player] ?? '仲間'} は倒れた。` : `${ctx.playerNames[ev.player] ?? 'An ally'} has fallen.`;
      if (ev.state === 'left') return ja ? 'プレイヤーが離脱した。' : 'A player left.';
      if (ev.state === 'at_camp' && ev.reason === 'joined') return ja ? `${ctx.playerNames[ev.player] ?? 'プレイヤー'} はキャンプにいる。最初の遠征を選ぶ。` : `${ctx.playerNames[ev.player] ?? 'A player'} is at camp, choosing the first expedition.`;
      if (ev.state === 'at_camp') return ja ? `${ctx.playerNames[ev.player] ?? 'プレイヤー'} はキャンプに戻った（全回復）。` : `${ctx.playerNames[ev.player] ?? 'A player'} returns to camp (fully healed).`;
      return null;
    case 'expedition_started':
      return ja ? `遠征 ${ev.expedition?.no} が始まった: ${objectiveText(L, ev.expedition?.objective)}` : `Expedition ${ev.expedition?.no} begins: ${objectiveText(L, ev.expedition?.objective)}`;
    case 'objective_completed':
      return ja ? `遠征の目的を達成した: ${objectiveText(L, ev.objective)}` : `Objective complete: ${objectiveText(L, ev.objective)}`;
    case 'expedition_ended':
      return ja ? `遠征 ${ev.no} が終了した（${endReasonText(L, ev.reason)}）。` : `Expedition ${ev.no} has ended (${endReasonText(L, ev.reason)}).`;
    case 'expedition_offered':
      return null;
    case 'haul_changed': {
      // 撃破だけの増加は頻繁なので文章にしない（観測の戦利品の行に出る）
      const g = ev.gains ?? {};
      const parts: string[] = [];
      if (g.bounty) parts.push(ja ? `賞金 +${g.bounty}` : `bounty +${g.bounty}`);
      if (g.discovery) parts.push(ja ? `発見 +${g.discovery}` : `discovery +${g.discovery}`);
      if (!parts.length) return null;
      return ja ? `戦利品に ${parts.join('・')}（未確定）。` : `Haul: ${parts.join(', ')} (not banked yet).`;
    }
    case 'run_ended': {
      const why: Record<string, [string, string]> = {
        all_players_gone: ['盤面にもキャンプにも誰もいなくなった', 'no one is left on the board or at camp'],
      };
      const w = why[ev.reason];
      return ja ? `ランが終了した（${w ? w[0] : ev.reason}）。` : `The run has ended (${w ? w[1] : ev.reason}).`;
    }
    case 'entity_removed':
      return null;
    default:
      return null;
  }
}
