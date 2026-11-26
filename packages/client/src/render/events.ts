// ゲームイベント（World 用・プレイヤー向け縮約版のどちらでも）→ 演出用 ViewEvent。
import type { Catalog } from '@muse/shared';
import type { AssetRef } from '../theme/types';
import { getLocale } from '../util';
import type { ViewEvent } from './types';

type AnyEv = Record<string, any> & { type: string };

/** 敵の大きな行動の短い名前（S16a。観測・文と同じ呼び方。カタログに名前の無い行動） */
function foeActName(kind: 'swing' | 'charge' | 'summon' | 'rage'): string {
  const ja = getLocale() === 'ja';
  switch (kind) {
    case 'swing': return ja ? '大振り' : 'Heavy swing';
    case 'charge': return ja ? '突進' : 'Charge';
    case 'summon': return ja ? '手下を呼ぶ' : 'Call minions';
    default: return ja ? '怒り' : 'Rage';
  }
}

/** 能動技の表示名（カタログの名前。無ければ ID の後ろ） */
export function abilityName(catalog: Catalog | null, id: string): string {
  const n = catalog?.abilities[id]?.name;
  return n ? n[getLocale()] ?? n.ja : id.split(':').pop() ?? id;
}

/**
 * director=true のとき、未鑑定になり得る種別は常に外見で描く。
 * 見えていない者（ID が伏せられた）の分は作らない（届いた出来事だけから。S16a）
 */
export function toViewEvents(events: readonly AnyEv[], catalog: Catalog | null, director = false): ViewEvent[] {
  const out: ViewEvent[] = [];
  // 同じ束に攻撃の出来事が届いている一撃（攻撃者 > 相手）。その被害からは、踏み込みを重ねない
  const swung = new Set<string>();
  for (const ev of events) if (ev.type === 'attack' && ev.attacker && ev.target) swung.add(`${ev.attacker}>${ev.target}`);
  for (const ev of events) {
    switch (ev.type) {
      case 'entity_moved':
        if (ev.from && ev.to) out.push({ kind: 'move', id: ev.id, from: ev.from, to: ev.to, teleport: ev.mode === 'teleport' });
        break;
      case 'attack':
        if (ev.to) out.push({ kind: 'attack', id: ev.attacker ?? null, from: ev.from ?? null, to: ev.to, hit: !!ev.hit, crit: !!ev.crit, ranged: !!ev.ranged });
        break;
      case 'damaged':
        // 攻撃の出来事が届いていない当たり（会心でない当たりは文にならず、遊ぶ画面・追従だけの観戦の枠に届かない。S16a）: 被害から踏み込みを作る
        if (ev.source && ev.target && (ev.via === 'melee' || ev.via === 'ranged') && !swung.has(`${ev.source}>${ev.target}`)) {
          out.push({ kind: 'strike', id: ev.source, target: ev.target, ranged: ev.via === 'ranged' });
          swung.add(`${ev.source}>${ev.target}`);
        }
        if (ev.amount > 0) out.push({ kind: 'damage', id: ev.target, amount: ev.amount });
        break;
      case 'healed':
        out.push({ kind: 'heal', id: ev.target, amount: ev.amount });
        break;
      case 'died':
        if (ev.pos) out.push({ kind: 'die', id: ev.id, pos: ev.pos });
        break;
      case 'ability_used':
        // 能動技の名前（S16a。§70.3 の 2）: 使った者が見えているときだけ（見えていなければ actor は伏せてある）
        if (ev.actor && ev.ability) out.push({ kind: 'ability', id: ev.actor, name: abilityName(catalog, ev.ability) });
        break;
      case 'monster_acted':
        if (ev.id) out.push({ kind: 'ability', id: ev.id, name: foeActName('swing') });
        break;
      case 'guardian_acted':
        if (ev.id && ev.act !== 'missed') out.push({ kind: 'ability', id: ev.id, name: foeActName(ev.act === 'charged' ? 'charge' : ev.act === 'summoned' ? 'summon' : 'rage') });
        break;
      case 'item_thrown': {
        const to = ev.landed ?? ev.to;
        if (ev.from && to) {
          let ref: AssetRef | undefined;
          const app: string | null = ev.appearanceId ?? null;
          if (app && (!ev.kind || director)) ref = { cls: 'appearance', id: app, category: catalog?.appearances[app]?.category };
          else if (ev.kind) ref = { cls: 'item', id: ev.kind, alt: app ? { cls: 'appearance', id: app } : undefined, category: catalog?.items[ev.kind]?.category };
          out.push({ kind: 'projectile', from: ev.from, to, ref });
        }
        break;
      }
      case 'level_up':
        out.push({ kind: 'levelup', id: ev.target });
        break;
      case 'status_applied':
        out.push({ kind: 'status', id: ev.target, status: ev.status?.id ?? '' });
        break;
      case 'trap_triggered':
        if (ev.pos) out.push({ kind: 'trap', pos: ev.pos });
        break;
      default:
        break;
    }
  }
  return out;
}
