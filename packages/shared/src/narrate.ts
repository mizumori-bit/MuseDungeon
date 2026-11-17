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
      // 視界の外で毒が倒した相手（種族は伏せてある。V3-2R2 §18.7）
      if (ev.killer === self && ev.via === 'poison') return ev.kind ? (ja ? `${v}はあなたの毒で倒れた。${hpNote}` : `${cap(v)} falls to your poison.${hpNote}`) : (ja ? 'あなたの毒で何かが倒れた。' : 'Something fell to your poison.');
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
      const tg = ev.target ? who(ctx, ev.target, ev.targetKind) : null;
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
      const n = kindName(ctx.catalog, L, (ev.kind as string | null) ?? null, (ev.appearanceId as string | null) ?? null);
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
      return null;
    case 'guardian_acted': {
      const nm = nameOf(ev.guardianName, L, '?');
      switch (ev.act) {
        case 'summoned': return ja ? `${nm}が手下を ${ev.count ?? 0} 体呼んだ。` : `${nm} calls ${ev.count ?? 0} minions.`;
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
      if (ev.state === 'at_camp' && ev.reason === 'joined') return ja ? `${ctx.playerNames[ev.player] ?? 'プレイヤー'} はキャンプにいる。最初の遠征を選ぶ。` : `${ctx.playerNames[ev.player] ?? 'A player'} is at camp, choosing the first expedition.`;
      if (ev.state === 'at_camp' && ev.reason === 'lifeline') {
        const lost = ev.relicLost ? (ja ? '遺物は持ち帰れず、失われた。' : ' The relic could not come along and is lost.') : '';
        return ja ? `${ctx.playerNames[ev.player] ?? 'プレイヤー'} は帰還の綱でキャンプに戻った（全回復）。${lost}` : `${ctx.playerNames[ev.player] ?? 'A player'} is pulled back to camp by the lifeline (fully healed).${lost}`;
      }
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
