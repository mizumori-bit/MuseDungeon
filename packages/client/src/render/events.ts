// ゲームイベント（World 用・プレイヤー向け縮約版のどちらでも）→ 演出用 ViewEvent。
import type { Catalog } from '@muse/shared';
import type { AssetRef } from '../theme/types';
import type { ViewEvent } from './types';

type AnyEv = Record<string, any> & { type: string };

/** director=true のとき、未鑑定になり得る種別は常に外見で描く */
export function toViewEvents(events: readonly AnyEv[], catalog: Catalog | null, director = false): ViewEvent[] {
  const out: ViewEvent[] = [];
  for (const ev of events) {
    switch (ev.type) {
      case 'entity_moved':
        if (ev.from && ev.to) out.push({ kind: 'move', id: ev.id, from: ev.from, to: ev.to, teleport: ev.mode === 'teleport' });
        break;
      case 'attack':
        if (ev.to) out.push({ kind: 'attack', id: ev.attacker ?? null, from: ev.from ?? null, to: ev.to, hit: !!ev.hit, crit: !!ev.crit, ranged: !!ev.ranged });
        break;
      case 'damaged':
        if (ev.amount > 0) out.push({ kind: 'damage', id: ev.target, amount: ev.amount });
        break;
      case 'healed':
        out.push({ kind: 'heal', id: ev.target, amount: ev.amount });
        break;
      case 'died':
        if (ev.pos) out.push({ kind: 'die', id: ev.id, pos: ev.pos });
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
