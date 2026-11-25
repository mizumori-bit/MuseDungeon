// イベント → 文章（ja / en）。入力はプレイヤー向けに縮約済みのイベントのみ。
import type { Catalog } from './catalog';
import { nameOf } from './catalog';
import { endReasonText, objectiveText } from './expedition';
import type { ProjectedEvent } from './filter';
import type { DirectiveWish, Locale, Names } from './types';
import { dirTo } from './util';
import { wishLabel } from './directive';
import type { Pos } from './types';

export interface NarrateCtx {
  locale: Locale;
  catalog: Catalog;
  selfId: string | null;
  /** 自分のプレイヤー ID（出来事の player はプレイヤー ID。entityId の selfId と比べない） */
  selfPlayerId?: string | null;
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

/** 相手の方角と距離（「北東に 5」。自分の位置から） */
function relWhere(from: Pos, to: Pos, ja: boolean): string {
  const dx = to.x - from.x, dy = to.y - from.y;
  const ns = dy < 0 ? (ja ? '北' : 'N') : dy > 0 ? (ja ? '南' : 'S') : '';
  const ew = dx > 0 ? (ja ? '東' : 'E') : dx < 0 ? (ja ? '西' : 'W') : '';
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  return ja ? `${ns}${ew || ''}に ${d}` : `${ns}${ew} ${d}`;
}

/** 置き場の場所（「地下4階の下り階段 (12,7)」） */
function supplyWhere(ctx: NarrateCtx, ev: Record<string, unknown>): string {
  const ja = ctx.locale !== 'en';
  const p = ev.place === 'stairs_up' ? (ja ? '上り階段' : 'the stairs up') : ev.place === 'stairs_down' ? (ja ? '下り階段' : 'the stairs down') : (ja ? '野営の火' : 'the campfire');
  return ja ? `地下${ev.depth}階の${p} (${ev.x},${ev.y})` : `${p} on depth ${ev.depth} (${ev.x},${ev.y})`;
}

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
      // 誰のものでもない効果（崩れた天井の落石など。原因は直前の文に出る）
      if (ev.via === 'effect' && !src) return ja ? `${tg}は ${amt} ダメージを受けた。` : `${cap(tg)} take${ev.target === self ? '' : 's'} ${amt} damage.`;
      // とどめ: 与えるはずだった値（会心の値）を出し、残り HP で切られたことを添える（Muse の実プレイ、V3-4b §28.11）
      if (ev.source === self && ev.amount > amt) return ja ? `あなたは${tg}に ${ev.amount} ダメージを与えた（とどめ。残りは ${amt} だった）。` : `You hit ${tg} for ${ev.amount} (the finishing blow; it had ${amt} left).`;
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
      // 野営の火（S1）は fire_used の文に戻った HP が出る
      if (ev.via === 'regen' || ev.via === 'rest' || ev.via === 'fire') return null;
      const tg = who(ctx, ev.target, ev.targetKind);
      return ja ? `${tg}は ${ev.amount} 回復した。` : `${cap(tg)} recover${ev.target === self ? '' : 's'} ${ev.amount} HP.`;
    }
    case 'max_hp_changed':
      return ja ? `最大 HP が ${ev.maxHpAfter} になった。` : `Your max HP is now ${ev.maxHpAfter}.`;
    case 'died': {
      const v = who(ctx, ev.id, ev.kind, ev.affixes);
      if (ev.id === self) return ja ? 'あなたは死んだ……' : 'You die...';
      const hpNote = typeof ev.maxHp === 'number' ? (ja ? `（この${v}の体力は ${ev.maxHp} だった）` : ` (it had ${ev.maxHp} HP)`) : '';
      // 視界の外で毒が倒した相手（種族は伏せてある。V3-2R2 §18.7）
      if (ev.killer === self && ev.via === 'poison') return ev.kind ? (ja ? `${v}はあなたの毒で倒れた。${hpNote}` : `${cap(v)} falls to your poison.${hpNote}`) : (ja ? 'あなたの毒で何かが倒れた。' : 'Something fell to your poison.');
      if (ev.killer === self) return ja ? `${v}を倒した。${hpNote}` : `You kill ${v}.${hpNote}`;
      return ja ? `${v}は倒れた。${hpNote}` : `${cap(v)} dies.${hpNote}`;
    }
    case 'status_applied': {
      // 火からの帰り支度（S1c）は fire_return の文に出る
      if (ev.status?.id === 'core:fire_return') return null;
      const tg = who(ctx, ev.target, ev.targetKind, ev.targetAffixes);
      const st = nameOf(ctx.catalog.statuses[ev.status?.id]?.name, L, ev.status?.id);
      return ja ? `${tg}は${st}状態になった。` : `${cap(tg)} ${ev.target === self ? 'are' : 'is'} now ${st}.`;
    }
    case 'status_expired': {
      if (ev.statusId === 'core:fire_return') return null;
      const tg = who(ctx, ev.target, ev.targetKind, ev.targetAffixes);
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
    case 'xp_gained': {
      // 経験値が増えた理由（S0b。SEASON.md §6.2 の 1）。理由は engine の出来事が持つ（S1 §8.9 の 2）。古い出来事には無い。俯瞰では出さない
      if (!self || ev.target !== self) return null;
      const why = ev.reason === 'kill' ? (ja ? `${who(ctx, null, ev.victimKind, ev.victimAffixes)}を倒した` : `killed ${who(ctx, null, ev.victimKind, ev.victimAffixes)}`)
        : ev.reason === 'depth' ? (ja ? `初めて地下${ev.depth ?? '?'}階に着いた` : `first time on depth ${ev.depth ?? '?'}`)
          : ev.reason === 'objective' ? (ja ? '遠征の目的を達成した' : 'expedition objective complete') : null;
      if (ja) return why ? `経験値 +${ev.amount}（${why}）。` : `経験値 +${ev.amount}。`;
      return why ? `+${ev.amount} XP (${why}).` : `+${ev.amount} XP.`;
    }
    // ビルド（V3-4）
    case 'perk_offered': {
      if (ev.target !== self) return null;
      const opts = (ev.options as string[]).map((id, i) => `${i + 1} ${nameOf(ctx.catalog.perks[id]?.name, L, id)}`);
      if (!opts.length) return ja ? `Lv${ev.level} の特技は、前の候補を選んだ後に出る。` : `The Lv${ev.level} perk is offered after you choose the earlier one.`;
      return ja ? `特技を選べる（Lv${ev.level}）: ${opts.join(' / ')}（choose_perk。手番は使わない）` : `Choose a perk (Lv${ev.level}): ${opts.join(' / ')} (choose_perk; takes no turn)`;
    }
    case 'perk_chosen': {
      if (ev.target !== self) return null;
      const pk = nameOf(ctx.catalog.perks[ev.perk]?.name, L, ev.perk);
      const ab = ev.ability ? nameOf(ctx.catalog.abilities[ev.ability]?.name, L, ev.ability) : null;
      return ja ? `特技「${pk}」を取った。${ab ? `能動技「${ab}」を覚えた（use_ability）。` : ''}` : `You take the perk ${pk}.${ab ? ` You learn ${ab} (use_ability).` : ''}`;
    }
    case 'monster_woke': {
      // 目を覚ました理由（V3-4b §28.8）
      const m = who(ctx, ev.id, ev.kind);
      const verb = ev.wasAsleep ? (ja ? '目を覚ました' : 'wakes up') : (ja ? '気づいた' : 'notices');
      if (ev.reason === 'noise' && ev.by === self) {
        const ring = ev.ring ? nameOf(ctx.catalog.items[ev.ring]?.name, L, ev.ring) : null;
        const note = ring ? (ja ? `（${ring}の欠点: 自分の立てた音では眠っている敵が必ず起きる）` : ` (${ring}'s drawback: your own noise always wakes sleepers)`) : '';
        return ja ? `あなたの立てた音で${m}が${verb}。${note}` : `Your noise: ${m} ${verb}.${note}`;
      }
      if (ev.reason === 'noise') return ja ? `物音で${m}が${verb}。` : `A noise: ${m} ${verb}.`;
      if (ev.reason === 'pack') return ja ? `仲間の声で${m}が${verb}。` : `Its pack's call: ${m} ${verb}.`;
      return ja ? `${m}が${verb}（あなたの気配で）。` : `${cap(m)} ${verb} (it sensed you).`;
    }
    case 'perk_triggered': {
      // 条件付きの特技が効いた（V3-4b §28.6）
      if (ev.actor !== self) return null;
      const pk = nameOf(ctx.catalog.perks[ev.perk]?.name, L, ev.perk);
      const sub = ev.subject ? who(ctx, ev.subject, ev.subjectKind ?? null) : (ja ? '何か' : 'something');
      switch (ev.effect) {
        case 'not_woken': return ja ? `${pk}: ${sub}は目を覚まさなかった。` : `${pk}: ${sub} did not wake.`;
        case 'crit': return ja ? `${pk}: ${sub}に会心。` : `${pk}: a critical hit on ${sub}.`;
        case 'picked': return ja ? `${pk}: 隣のマスから ${ev.amount ?? 1} 本拾った。` : `${pk}: picked up ${ev.amount ?? 1} from the next cells.`;
        case 'braced': return ja ? `${pk}: 装甲 +${ev.amount ?? 0} で受けた。` : `${pk}: took the hit with armor +${ev.amount ?? 0}.`;
        case 'might': return ja ? `${pk}: 威力 +${ev.amount ?? 0}。` : `${pk}: might +${ev.amount ?? 0}.`;
        case 'poison_halved': return ja ? `${pk}: 毒の手番が半分になった。` : `${pk}: the poison lasts half as long.`;
        case 'cowed': return ja ? `${pk}: ${sub}が怯えた。` : `${pk}: ${sub} is cowed.`;
        default: return null;
      }
    }
    case 'ability_used': {
      const ab = nameOf(ctx.catalog.abilities[ev.ability]?.name, L, ev.ability);
      const tg = ev.target ? who(ctx, ev.target, ev.targetKind, ev.targetAffixes) : null;
      const cd = ev.actor === self && ev.cooldownLeft > 0 ? (ja ? `（再使用まで ${ev.cooldownLeft} 手番）` : ` (ready again in ${ev.cooldownLeft} turns)`) : '';
      if (ev.actor === self) return ja ? `${ab}を使った${tg ? `（${tg}へ）` : ''}。${cd}` : `You use ${ab}${tg ? ` on ${tg}` : ''}.${cd}`;
      return ja ? `${who(ctx, ev.actor, ev.actorKind)}は${ab}を使った。` : `${cap(who(ctx, ev.actor, ev.actorKind))} uses ${ab}.`;
    }
    case 'curse_revealed': {
      const n = kindName(ctx.catalog, L, (ev.kind as string | null) ?? null, (ev.appearanceId as string | null) ?? null);
      const cs = (ev.affixes as string[]).map((a) => nameOf(ctx.catalog.affixes[a]?.name, L, a)).join(ja ? '・' : ', ');
      if (ev.actor !== self) return null;
      return ev.via === 'equip'
        ? (ja ? `${n}は呪われていた（${cs}）。外せない（解呪の巻物か祭壇で解ける）。` : `The ${n} is cursed (${cs}). It will not come off (a scroll of remove curse or an altar lifts it).`)
        : (ja ? `${n}は呪われている（${cs}）。装備すると外せない。` : `The ${n} is cursed (${cs}). It will not come off once equipped.`);
    }
    case 'item_inspected': {
      if (ev.actor !== self) return null;
      // 接辞付きの名前で（「補強された革鎧に呪いは無い」。V3-8 の確認の評価）
      const n = itemName(ctx, ev as unknown as Record<string, unknown>);
      return ja ? `${n}に呪いは無い。` : `The ${n} is not cursed.`;
    }
    case 'curse_lifted': {
      if (ev.actor !== self) return null;
      const n = kindName(ctx.catalog, L, (ev.kind as string | null) ?? null, (ev.appearanceId as string | null) ?? null);
      const cs = (ev.affixes as string[]).map((a) => nameOf(ctx.catalog.affixes[a]?.name, L, a)).join(ja ? '・' : ', ');
      return ja ? `${n}の呪いが解けた（${cs}）。` : `The curse on the ${n} is lifted (${cs}).`;
    }
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
      // 落ちた所が見えないときは「見えない所に落ちた」（V3-7a 後の評価: 「消えた」で、壊れたのか分からなかった）
      const fall = ev.broke ? (ja ? '砕け散った。' : ' It shatters.') : at ? (ja ? `${at} に落ちた。` : ` It lands at ${at}.`) : (ja ? '見えない所に落ちた。' : ' It lands somewhere out of sight.');
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
    case 'item_issued':
      return ev.actor === self ? (ja ? `キャンプで${kindName(ctx.catalog, L, ev.kind)}を 1 本持たされた。` : `Camp hands you a ${kindName(ctx.catalog, L, ev.kind)}.`) : null;
    case 'item_identified': {
      const real = kindName(ctx.catalog, L, ev.kind);
      const app = ev.appearanceId ? kindName(ctx.catalog, L, null, ev.appearanceId) : null;
      return ja ? `${app ? `${app}は` : ''}${real}だと判明した。` : `${app ? `${cap(app)} is ` : 'Identified: '}${real}.`;
    }
    case 'tile_changed': {
      const t = ctx.catalog.terrain[ev.terrainId as string];
      if (ev.reason === 'door_open') return ev.by === self ? (ja ? '扉を開けた。' : 'You open the door.') : (ja ? '扉が開いた。' : 'A door opens.');
      if (ev.reason === 'door_close') return ev.by === self ? (ja ? '扉を閉めた。' : 'You close the door.') : (ja ? '扉が閉まった。' : 'A door closes.');
      if (ev.reason === 'unlock') return ev.by === self ? (ja ? '鍵で格子扉を開けた（鍵は無くなった）。' : 'You unlock the grate (the key is used up).') : (ja ? '格子扉が開いた。' : 'A grate opens.');
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
      // 護りの火が消えた（V3-3）
      if (ev.kind === 'core:ward_fire' && ev.state === 'out') return ja ? '護りの火が消えた。' : 'A ward fire goes out.';
      // バイオームの仕掛け（V3-5 §5.2。V3-7 の評価: 天井が崩れても文が無かった）
      if (ev.kind === 'core:brittle_ceiling' && ev.state === 'fallen') return ja ? '脆い天井が崩れ落ちた（真下と周り 1 マスに落石）。' : 'A brittle ceiling comes down (falling rock on and around it).';
      if (ev.kind === 'core:spore_pod' && ev.state === 'burst') return ja ? '胞子嚢が弾け、毒の胞子が広がった。' : 'A spore pod bursts in a cloud of poison.';
      return null;
    case 'guardian_acted': {
      const nm = nameOf(ev.guardianName, L, '?');
      switch (ev.act) {
        // 呼べる場所が無ければ 0 体（V3-5a 後の AI 評価: 「0 体呼んだ」が奇妙だった）
        case 'summoned': return (ev.count ?? 0) > 0
          ? (ja ? `${nm}が手下を ${ev.count} 体呼んだ。` : `${nm} calls ${ev.count} minions.`)
          : (ja ? `${nm}は手下を呼ぼうとしたが、呼べる場所が無かった。` : `${nm} tries to call minions, but there is no room for them.`);
        case 'charged': return ja ? `${nm}が直線を突進した。` : `${nm} charges down the line.`;
        case 'missed': return ja ? `${nm}の突進が外れ、体勢を崩した（1 手無防備）。` : `${nm}'s charge misses and it staggers (helpless for a turn).`;
        case 'enraged': return ja ? `${nm}が怒った（速さ・威力が上がった）。` : `${nm} rages (faster and stronger).`;
        default: return null;
      }
    }
    case 'boon_granted': {
      if (ev.target !== self) return null;
      const b = ctx.catalog.boons?.[ev.boon];
      const from = ev.source === 'warden' ? (ja ? '大守護者を倒し、' : 'The warden falls; ') : ctx.catalog.items[ev.source] ? (ja ? `${nameOf(ctx.catalog.items[ev.source].name, L, ev.source)}を納め、` : `You deliver the ${nameOf(ctx.catalog.items[ev.source].name, L, ev.source)}; `) : '';
      return ja ? `${from}加護「${nameOf(b?.name, L, ev.boon)}」を得た（${nameOf(b?.desc, L, '')}）。` : `${from}you gain the boon ${nameOf(b?.name, L, ev.boon)} (${nameOf(b?.desc, L, '')}).`;
    }
    case 'story':
      return nameOf(ev.line as Names, L, '');
    case 'archive_recalled': {
      const nm = nameOf(ev.guardianName as Names, L, '?');
      if (ev.memory === 'weakness') {
        const w = nameOf(ctx.catalog.guardianWeaknesses[ev.weakness as string]?.name, L, String(ev.weakness));
        return ja ? `記録庫が思い出した: 地下${ev.depth}階の番人「${nm}」の弱点は「${w}」。` : `The archive remembers: the keeper "${nm}" of depth ${ev.depth} is "${w}".`;
      }
      if (ev.memory === 'vitals') return ja ? `記録庫が思い出した: 地下${ev.depth}階の番人「${nm}」は、体力およそ ${ev.hp}、一撃は ${ev.maxHit} まで。` : `The archive remembers: the keeper "${nm}" of depth ${ev.depth} has about ${ev.hp} HP and hits for up to ${ev.maxHit}.`;
      return null;
    }
    case 'guardian_rested': {
      const nm = nameOf(ev.guardianName as Names, L, '?');
      // 手下が去った（V3-3b §40.3）
      const gone = ev.dispersed ? (ja ? `${nm}の手下は散っていた。` : ` Its minions have scattered.`) : '';
      return (ev.full ? (ja ? `守護者「${nm}」は傷を癒やしていた（体力が戻っている）。` : `The guardian "${nm}" has healed its wounds (back to full).`)
        : (ja ? `守護者「${nm}」の傷が少し癒えている（追われていない間に回復した）。` : `The guardian "${nm}" has healed a little while it was not chasing you.`)) + gone;
    }
    case 'clue_noted':
      return null;
    case 'clue_learned': {
      const app = kindName(ctx.catalog, L, null, ev.appearanceId);
      return ja ? `${app}の手がかりに気づいた: ${nameOf(ev.clue, L, '')}。` : `You notice something about the ${app}: ${nameOf(ev.clue, L, '')}.`;
    }
    case 'room_found': {
      const mine = ev.player === self || (!!ctx.selfPlayerId && ev.player === ctx.selfPlayerId);
      // 見えた部屋の一角の方角と歩数（見つけた時点では中の地物がまだ見えていないことがある。V3-8 の確認の評価）
      const d = ctx.selfPos && ev.at ? dirTo(ctx.selfPos, ev.at) : null;
      const n = ctx.selfPos && ev.at ? Math.max(Math.abs(ev.at.x - ctx.selfPos.x), Math.abs(ev.at.y - ctx.selfPos.y)) : 0;
      const where = d ? (ja ? `。${DIR_JA[d]}・${n} マス先に部屋の一角が見えた` : ` A corner of it is ${n} cells to the ${DIR_EN[d]}.`) : '';
      return ja ? `${mine ? '' : '仲間が'}「${nameOf(ev.name, L, ev.room)}」を見つけた（発見${where}）。` : `${mine ? 'Found' : 'An ally found'}: ${nameOf(ev.name, L, ev.room)} (discovery).${where}`;
    }
    case 'inscription_read': {
      // 書き置きは、ずっと昔の探索者のもの（S4 §42.2 の 1: シーズンのほかの参加者の痕跡と読まれないように）
      const what = ev.note ? (ja ? '昔の探索者の書き置き' : 'the old delver\'s note') : (ja ? '碑文' : 'the inscription');
      const body = ev.lore ? (ja ? `${nameOf(ev.lore, L, '')}` : ` ${nameOf(ev.lore, L, '')}`) : '';
      const clue = ev.clueText ? (ja ? ` 手がかり: ${nameOf(ev.clueText, L, '')}` : ` Clue: ${nameOf(ev.clueText, L, '')}`) : '';
      return ja ? `${what}を読んだ: ${body}${clue}` : `You read ${what}:${body}${clue}`;
    }
    case 'gamble_rolled':
      return ja ? `祭壇に祈った。起きたこと: ${nameOf(ev.outcome, L, '?')}（${ev.pct}%）。` : `You pray at the altar. Result: ${nameOf(ev.outcome, L, '?')} (${ev.pct}%).`;
    case 'item_altered': {
      const n = kindName(ctx.catalog, L, ev.kind);
      const af = nameOf(ctx.catalog.affixes[ev.affix]?.name, L, ev.affix);
      return ev.cursed ? (ja ? `${n}が呪われた（${af}）。外せない。` : `Your ${n} is cursed (${af}). It cannot be removed.`) : (ja ? `${n}に「${af}」が付いた。` : `Your ${n} gains "${af}".`);
    }
    case 'monster_acted': {
      const nm = who(ctx, ev.id, ev.kind);
      if (ev.act === 'swing_missed') return ja ? `${nm}の大振りは空を切った（1 手、朦朧になる）。` : `${cap(nm)}'s heavy swing hits nothing (stunned for a turn).`;
      return ja ? `${nm}の大振りが当たった（2 倍）。` : `${cap(nm)}'s heavy swing lands (double damage).`;
    }
    case 'guardian_departed': {
      const nm = nameOf(ev.guardianName as Names, L, '?');
      if (ev.elite) return ja ? `地下${ev.depth}階の強敵「${nm}」は階を去っていた。` : `The elite "${nm}" of depth ${ev.depth} has left the floor.`;
      return ja ? `地下${ev.depth}階の守護者「${nm}」は棲み処を去っていた（目的ではなくなった）。` : `The guardian "${nm}" of depth ${ev.depth} has left its lair (no longer an objective).`;
    }
    case 'floor_reset': {
      const nm = ev.guardianName ? nameOf(ev.guardianName, L, '?') : null;
      return ja
        ? `地下${ev.depth}階は姿を変えた。${nm ? `大守護者「${nm}」` : '大守護者'}の間になっている（その階の地図と記憶は消え、床に残していた品は失われた）。`
        : `Depth ${ev.depth} has changed shape: it is now the hall of ${nm ? `the warden "${nm}"` : 'its warden'} (your map and memories of it are gone, and items left on its floor are lost).`;
    }
    case 'warden_slain': {
      const nm = nameOf(ev.guardianName, L, '?');
      return ja ? `節目の大守護者${nm}が倒れた（地下${ev.depth}階）。下り階段の封印が解けた。` : `The warden ${nm} falls (depth ${ev.depth}). The stairs down are unsealed.`;
    }
    case 'boon_offered': {
      if (ev.target !== self) return null;
      const names = (ev.options as string[]).map((id: string, i: number) => `${i + 1}) ${nameOf(ctx.catalog.boons?.[id]?.name, L, id)}`).join(ja ? '・' : ', ');
      return ja ? `加護を 1 つ選べる（choose_boon）: ${names}。` : `Choose one boon (choose_boon): ${names}.`;
    }
    case 'boon_triggered': {
      if (ev.actor !== self) return null;
      const bn = nameOf(ctx.catalog.boons?.[ev.boon]?.name, L, ev.boon);
      if (ev.effect === 'last_stand') return ja ? `加護「${bn}」: 倒れずに HP 1 で踏みとどまった（この遠征ではもう効かない）。` : `Boon ${bn}: you stay on your feet with 1 HP (not again this expedition).`;
      if (ev.effect === 'returned') return ja ? `加護「${bn}」: 投げた${ev.itemKind ? kindName(ctx.catalog, L, ev.itemKind) : '物'}が手元に戻った。` : `Boon ${bn}: the thrown ${ev.itemKind ? kindName(ctx.catalog, L, ev.itemKind) : 'item'} comes back to your hand.`;
      return ja ? `加護「${bn}」: 階段を抜けて足が速くなった。` : `Boon ${bn}: you are hasted after the stairs.`;
    }
    case 'guardian_intel': {
      // 本人にだけ届く（filter の SELF_ONLY）
      const nm = nameOf(ev.guardianName, L, '?');
      const w = nameOf(ctx.catalog.guardianWeaknesses[ev.weakness]?.name, L, ev.weakness);
      const ws = nameOf(ctx.catalog.guardianWeaknesses[ev.weakness]?.short ?? ctx.catalog.guardianWeaknesses[ev.weakness]?.name, L, ev.weakness);
      if (ev.miss) return ja ? `${nm}の弱点は${ws}ではない。` : `${nm}'s weakness is not ${ws}.`;
      return ja ? `${nm}の弱点が分かった: ${w}。` : `You learn ${nm}'s weakness: ${w}.`;
    }
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
      // 再開する階が作り直された（V4-0a §1.1）: floor_reset の文に任せる
      if (ev.reason === 'floor_reset') return null;
      if (ev.state === 'at_camp' && ev.reason === 'joined') return ja ? `${ctx.playerNames[ev.player] ?? 'プレイヤー'} はキャンプにいる。最初の遠征を選ぶ。` : `${ctx.playerNames[ev.player] ?? 'A player'} is at camp, choosing the first expedition.`;
      if (ev.state === 'at_camp' && ev.reason === 'lifeline') {
        const lost = ev.relicLost ? (ja ? '遺物は持ち帰れず、失われた。' : ' The relic could not come along and is lost.') : '';
        return ja ? `${ctx.playerNames[ev.player] ?? 'プレイヤー'} は帰還の綱でキャンプに戻った（全回復）。${lost}` : `${ctx.playerNames[ev.player] ?? 'A player'} is pulled back to camp by the lifeline (fully healed).${lost}`;
      }
      // シーズンの行動予算が尽きた（S0 §9.2）
      if (ev.state === 'at_camp' && ev.reason === 'time_up') return ja ? 'シーズンの行動予算が尽きた。時間切れでキャンプへ戻された（未確定の戦利品は失った。持ち物は残っている。倒れた扱いにはならない）。' : 'The season budget has run out. Time up: you are sent back to camp (the unbanked haul is lost; you keep your items; this does not count as dying).';
      if (ev.state === 'at_camp') return ja ? `${ctx.playerNames[ev.player] ?? 'プレイヤー'} はキャンプに戻った（全回復）。` : `${ctx.playerNames[ev.player] ?? 'A player'} returns to camp (fully healed).`;
      return null;
    // シーズン（S0 §9.4）: 公開された階段を地図に載せた・階段の報告の結果
    case 'knowledge_updated':
      // 共有層の野営の火（S1 §9.10）
      if (ev.publicFire) return ja ? `この階には ${ev.publicFire} の野営の火がある。地図に載せた（途中の道はまだ分からない）。` : `${ev.publicFire}'s campfire is on this floor. It is on your map (the way there is still unknown).`;
      // 公開された特別な場所（S1c §14.5）
      if (ev.publicSpot) {
        const r = (ev.rememberedSet as { kind: string; pos: Pos }[] | undefined)?.[0];
        const nm = r ? kindName(ctx.catalog, L, r.kind) : (ja ? '特別な場所' : 'a special place');
        return ja ? `この階の${nm}は公開されている（${ev.publicSpot} が報告。(${r?.pos.x},${r?.pos.y})）。地図に載せた（途中の道はまだ分からない）。` : `This floor's ${nm} has been published (reported by ${ev.publicSpot}; (${r?.pos.x},${r?.pos.y})). It is on your map (the way there is still unknown).`;
      }
      if (!ev.publicStairs) return null;
      // 道しるべ（S1b §12.4 の 1）: 入口からの道も載せた
      if (ev.publicPath) return ja ? `この階の下り階段は公開されている（${ev.publicStairs} が報告）。入口から階段までの道しるべと一緒に地図に載せた（travel_to stairs_down で向かえる）。` : `This floor's down stairs have been published (reported by ${ev.publicStairs}). They are on your map with a trail from the entrance (travel_to stairs_down goes there).`;
      return ja ? `この階の下り階段は公開されている（${ev.publicStairs} が報告）。地図に載せた（途中の道はまだ分からない）。` : `This floor's down stairs have been published (reported by ${ev.publicStairs}). They are on your map (the way there is still unknown).`;
    case 'fire_placed':
      return ja ? `野営の火を置いた（地下${ev.depth}階 (${ev.x},${ev.y})。確定点から ${ev.cost} 点を払った。キャンプに着くと、ほかの参加者の世界にも現れる）。` : `You set a campfire (depth ${ev.depth} (${ev.x},${ev.y}); paid ${ev.cost} banked points. It reaches the other participants once you are back at camp).`;
    case 'fire_used':
      return ja ? `${ev.by} の野営の火で休んだ。HP +${ev.amount}（この遠征では、この階の火はもう使えない）。` : `You rest at ${ev.by}'s campfire: HP +${ev.amount} (no more campfires on this floor this expedition).`;
    // 補給の置き場（S3 §25.2）
    case 'supply_deposited': {
      const where = supplyWhere(ctx, ev);
      return ja ? `${itemName(ctx, ev)}を${where}の置き場に預けた（キャンプに着くと、ほかの参加者の世界の同じ置き場にも現れる。取られると支援賞に数える）。` : `You deposit ${itemName(ctx, ev)} in the cache at ${where} (it reaches the other participants once you are back at camp; their takes count for your support award).`;
    }
    case 'supply_taken': {
      const where = supplyWhere(ctx, ev);
      return ja ? `${where}の置き場から、${ev.by} が預けた${itemName(ctx, ev)}を取った（${ev.slot}。1 回の遠征で置き場から取れるのは 1 つまで）。` : `You take ${itemName(ctx, ev)} deposited by ${ev.by} from the cache at ${where} (${ev.slot}; one take per expedition).`;
    }
    case 'stairs_reported': {
      const list = (ev.stairs as { depth: number; first: boolean }[]) ?? [];
      // 特別な場所（S1c §14.5）: 祭壇・賭けの祭壇・碑文
      const spots = (ev.spots as { depth: number; x: number; y: number; kind: string; first: boolean }[] | undefined) ?? [];
      const spotName = (x: { depth: number; x: number; y: number; kind: string }) => (ja ? `地下${x.depth}階の${kindName(ctx.catalog, L, x.kind)} (${x.x},${x.y})` : `the ${kindName(ctx.catalog, L, x.kind)} on depth ${x.depth} (${x.x},${x.y})`);
      const firsts = [...list.filter((x) => x.first).map((x) => (ja ? `地下${x.depth}階の階段` : `depth ${x.depth} stairs`)), ...spots.filter((x) => x.first).map(spotName)];
      const others = [...list.filter((x) => !x.first).map((x) => (ja ? `地下${x.depth}階の階段` : `depth ${x.depth} stairs`)), ...spots.filter((x) => !x.first).map(spotName)];
      const what = ja
        ? [list.length ? `下り階段を ${list.length} つ` : '', spots.length ? `特別な場所を ${spots.length} つ` : ''].filter(Boolean).join('と')
        : [list.length ? `${list.length} down staircase(s)` : '', spots.length ? `${spots.length} special place(s)` : ''].filter(Boolean).join(' and ');
      return ja
        ? `${what}報告した。${firsts.length ? `最初の報告: ${firsts.join('・')}（貢献 +${firsts.length}）。` : '最初の報告は無かった。'}${others.length ? `すでに公開されていた: ${others.join('・')}。` : ''}`
        : `Reported ${what}. ${firsts.length ? `First reports: ${firsts.join(', ')} (contribution +${firsts.length}).` : 'None were first.'}${others.length ? ` Already published: ${others.join(', ')}.` : ''}`;
    }
    // 野営の火から帰る（S1c §14.3 の 1）
    case 'fire_return': {
      if (ev.phase === 'start') return ja ? `${ev.by} の野営の火で帰り支度を始めた（${ev.turns} 手番。この手番を含む。その間に追ってくる敵が見えたら取りやめになる）。` : `You start packing up at ${ev.by}'s campfire (${ev.turns} turns including this one; it is called off if a hunting enemy comes into view).`;
      if (ev.phase === 'done') return ja ? `${ev.by} の野営の火から${ev.completed ? '帰還した（遠征達成）' : '撤退した'}。次の遠征は、この火のそばから始まる。` : `You ${ev.completed ? 'return home (expedition complete)' : 'withdraw'} from ${ev.by}'s campfire. The next expedition starts beside this fire.`;
      // 何で取りやめになったか（S3a §27.6 の 4）: 見えた敵の名前・ID・方角と距離、受けた被害とその相手
      const foe = ev.foe as { id: string; kind: string; pos: Pos } | undefined;
      const foeText = foe ? (ja ? `: ${kindName(ctx.catalog, L, foe.kind)} ${foe.id}${ctx.selfPos ? `（${relWhere(ctx.selfPos, foe.pos, true)}）` : ''}` : `: ${kindName(ctx.catalog, L, foe.kind)} ${foe.id}${ctx.selfPos ? ` (${relWhere(ctx.selfPos, foe.pos, false)})` : ''}`) : '';
      const src = typeof ev.sourceKind === 'string' ? kindName(ctx.catalog, L, ev.sourceKind) : null;
      const why = ev.reason === 'hostile' ? (ja ? `追ってくる敵が見えた${foeText}` : `a hunting enemy came into view${foeText}`)
        : ev.reason === 'damaged' ? (ja ? `被害を受けた${ev.dealt ? `: ${ev.dealt}` : ''}${src ? `（${src}から）` : ''}` : `you took damage${ev.dealt ? `: ${ev.dealt}` : ''}${src ? ` (from ${src})` : ''}`)
        : ev.reason === 'moved' ? (ja ? '火のそばから離された' : 'you were moved away from the fire')
          : (ja ? '目的が未達成になった（撤退するなら extract confirm: true）' : 'the objective is no longer complete (to withdraw, extract confirm: true)');
      return ja ? `帰り支度を取りやめた（${why}）。過ごした手番は戻らない。帰るなら、もう一度 extract（最初から）。` : `Packing up is called off (${why}). The turns spent are gone; extract again to start over.`;
    }
    case 'expedition_started':
      return ja ? `遠征 ${ev.expedition?.no} が始まった: ${objectiveText(L, ev.expedition?.objective)}` : `Expedition ${ev.expedition?.no} begins: ${objectiveText(L, ev.expedition?.objective)}`;
    // 指図（S8。SEASON.md §54.4）: 本人にだけ届く（ほかの参加者には渡らない）
    case 'directive_set': {
      const d = ev.directiveAfter as { hold?: string[]; message?: string } | undefined;
      return directiveSetText(L, d?.hold ?? [], !!d?.message);
    }
    case 'owner_decided':
      return ownerDecidedText(ctx, ev);
    // 支度の札（S9。SEASON.md §58.1）: 持ち主の prepare だけを文にする（キャンプに着いたときの置き直し・決めた後の戻りは出さない）
    case 'directive_prep': {
      if (ev.why !== 'owner') return null;
      const d = ev.directiveAfter as { hold?: string[]; prep?: { state?: string; objective?: number | 'endless' } } | undefined;
      const o = d?.hold?.includes('objective') ? d?.prep?.objective : undefined;
      const ot = o === undefined ? '' : o === 'endless' ? (ja ? '（目的: 目的なし）' : ' (objective: none, endless)') : (ja ? `（目的: 候補 ${o}）` : ` (objective: offer ${o})`);
      return d?.prep?.state === 'ready' ? (ja ? `持ち主の支度: 準備完了${ot}。` : `Your owner's preparations: ready${ot}.`) : (ja ? `持ち主の支度: まだ${ot}。` : `Your owner's preparations: not ready${ot}.`);
    }
    // 希望（S9 §58.2）: 握られた項目の命令を、持ち主に伝えた
    case 'directive_wish': {
      const w = ev.wish as DirectiveWish | undefined;
      if (!w) return null;
      const label = wishLabel(L, ctx.catalog, w, w.item === 'loadout' ? { kind: (ev.kind as string | null) ?? null, appearanceId: (ev.appearanceId as string | null) ?? null } : null);
      return ja ? `希望を持ち主に伝えた: ${label}${w.reason ? `（${w.reason}）` : ''}。` : `Wish passed to your owner: ${label}${w.reason ? ` (${w.reason})` : ''}.`;
    }
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

/** 指図の項目の名前（S8。SEASON.md §54。並びは目的・装備・特技と加護） */
export function directiveItemsText(L: Locale, items: readonly string[]): string {
  const name = (x: string) => x === 'objective' ? (L === 'en' ? 'objective' : '目的') : x === 'loadout' ? (L === 'en' ? 'equipment' : '装備') : (L === 'en' ? 'perks and boons' : '特技と加護');
  const order = ['objective', 'loadout', 'perks'];
  return order.filter((x) => items.includes(x)).map(name).join(L === 'en' ? ', ' : '・');
}

/** 持ち主が指図を変えた（S8 §54.4）。伝言の中身は出さない（キャンプの観測の「持ち主から」に出る） */
export function directiveSetText(L: Locale, hold: readonly string[], message: boolean): string {
  const held = directiveItemsText(L, hold);
  return L === 'en'
    ? `Your owner changed the directive: ${held ? `they decide ${held} at camp` : 'they hold nothing (you decide everything)'}${message ? '; a message is in the camp observation ("From your owner")' : ''}.`
    : `持ち主が指図を変えた: ${held ? `${held}は持ち主がキャンプで決める` : '何も握っていない（すべてあなたが決める）'}${message ? '。伝言あり（キャンプの観測の「持ち主から」）' : ''}。`;
}

/** 持ち主が、握った項目を決めた（S8 §54.4 の 4） */
function ownerDecidedText(ctx: NarrateCtx, ev: Record<string, any>): string | null {
  const L = ctx.locale;
  const ja = L !== 'en';
  switch (ev.act) {
    case 'start_expedition':
      // S9（§58.1）: 始めたのはプレイヤーで、目的は持ち主が選んだもの（offer がある）。S8 の版の記録は、持ち主が始めた遠征
      if (ev.offer !== undefined) return ja ? `持ち主が決めた目的で、遠征 ${ev.no ?? '?'} を始めた。` : `Expedition ${ev.no ?? '?'} began with the objective your owner chose.`;
      return ja ? `持ち主が、遠征 ${ev.no ?? '?'} を始めた。` : `Your owner started expedition ${ev.no ?? '?'}.`;
    case 'equip':
      return ja ? `持ち主が、装備を変えた: ${itemName(ctx, ev)}を装備。` : `Your owner changed your gear: equipped ${itemName(ctx, ev)}.`;
    case 'unequip':
      return ja ? `持ち主が、装備を変えた: ${itemName(ctx, ev)}を外した。` : `Your owner changed your gear: removed ${itemName(ctx, ev)}.`;
    case 'choose_perk':
      return ja ? `持ち主が、特技を選んだ: ${nameOf(ctx.catalog.perks[ev.choice]?.name, L, ev.choice ?? '?')}。` : `Your owner chose a perk: ${nameOf(ctx.catalog.perks[ev.choice]?.name, L, ev.choice ?? '?')}.`;
    case 'choose_boon':
      return ja ? `持ち主が、加護を選んだ: ${nameOf(ctx.catalog.boons?.[ev.choice]?.name, L, ev.choice ?? '?')}。` : `Your owner chose a boon: ${nameOf(ctx.catalog.boons?.[ev.choice]?.name, L, ev.choice ?? '?')}.`;
    default:
      return null;
  }
}
