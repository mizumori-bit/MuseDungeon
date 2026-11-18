// 同時に鳴る音の上限（SOUND_SPEC §6 の 16）を守るための間引き。Web Audio に触れない純粋な部分。
// 場面を切り替えた直後は、前の型の余韻と新しい型が重なって一時的に上限を超える（SOUND_DIRECTION.md §12）。
// 新しい音を置くたびに、その音が鳴る間のどの時点でも上限を超えないよう、ほかの音を早めに止める。

export interface VoiceSlot {
  id: number;
  /** 鳴り始め・押さえ終わり（ここから余韻）・鳴り終わり（秒。AudioContext の時刻） */
  start: number;
  holdEnd: number;
  end: number;
  kind: 'music' | 'cue';
}

/**
 * 止める順: 余韻に入った音楽 → 古い音楽 → 余韻に入った合図 → 古い合図（合図は短く、聞かせたいので後に回す）。
 * 返すのは、止める音と止める時刻（その時点から先を消す）
 */
export function planSteals(voices: readonly VoiceSlot[], add: VoiceSlot, max: number): { victim: VoiceSlot; at: number }[] {
  const out: { victim: VoiceSlot; at: number }[] = [];
  // 止めると決めた音は、その時刻で鳴り終わったものとして数える
  const endOf = new Map<number, number>();
  const end = (v: VoiceSlot) => endOf.get(v.id) ?? v.end;
  // 調べる時点: 新しい音の鳴り始めと、その間に鳴り始めるほかの音の鳴り始め（重なりが最も多くなるのは、どれかの鳴り始め）
  const points = [add.start, ...voices.filter((v) => v.start > add.start && v.start < add.end).map((v) => v.start)].sort((a, b) => a - b);
  for (const t of points) {
    const live = voices.filter((v) => v.start <= t && end(v) > t);
    let over = live.length + 1 - max;
    if (over <= 0) continue;
    const rank = (v: VoiceSlot): [number, number, number] => [v.kind === 'music' ? 0 : 1, v.holdEnd <= t ? 0 : 1, v.start];
    const order = [...live].sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.id - b.id;
    });
    for (const v of order) {
      if (over <= 0) break;
      out.push({ victim: v, at: t });
      endOf.set(v.id, t);
      over--;
    }
  }
  return out;
}

/** 時刻 t に鳴っている音の数（上限の確かめ用） */
export function liveAt(voices: readonly VoiceSlot[], t: number): number {
  return voices.filter((v) => v.start <= t && v.end > t).length;
}
