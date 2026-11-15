// ID → ハンドラのレジストリ。データからは ID で参照し、コンテンツ追加時にコアの switch を増やさない。
export class Registry<T> {
  private readonly map = new Map<string, T>();
  constructor(readonly kind: string) {}

  register(id: string, handler: T): this {
    if (this.map.has(id)) throw new Error(`${this.kind}: duplicate handler ${id}`);
    this.map.set(id, handler);
    return this;
  }

  get(id: string): T {
    const h = this.map.get(id);
    if (!h) throw new Error(`${this.kind}: unknown handler ${id}`);
    return h;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  ids(): string[] {
    return [...this.map.keys()].sort();
  }
}

import type { Rng } from '@muse/shared';
import { parseDice } from '@muse/shared';

export function roll(rng: Rng, dice: string, crit = false): number {
  const d = parseDice(dice);
  const n = crit ? d.n * 2 : d.n;
  let total = d.bonus;
  for (let i = 0; i < n; i++) total += rng.range(1, d.sides);
  return total;
}
