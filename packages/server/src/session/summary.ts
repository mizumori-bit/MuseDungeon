// ラン終了時の「冒険の記録」(summary.md)。
import type { Catalog, GameEvent, RunSummary } from '@muse/shared';
import { kindName } from '@muse/shared';

export function summaryMarkdown(summary: RunSummary, history: readonly GameEvent[], catalog: Catalog): string {
  const L = 'ja';
  const lines: string[] = [];
  lines.push(`# 冒険の記録 — ${summary.runId}`);
  lines.push('');
  lines.push(`- 終了理由: ${summary.reason}`);
  lines.push(`- シード: \`${summary.seed}\`（同じシードで同じダンジョンを再現できる）`);
  lines.push(`- 最終 seq: ${summary.endedSeq}`);
  lines.push('');
  lines.push('| 名前 | クラス | 操作 | 到達深度 | Lv | 撃破 | 手数 | 死因 | スコア |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const p of summary.players) {
    const cause = p.deathCause ? (catalog.monsters[p.deathCause] ? kindName(catalog, L, p.deathCause) : p.deathCause) : '-';
    lines.push(`| ${p.name} | ${kindName(catalog, L, p.classId)} | ${p.controller.kind}:${p.controller.label} | ${p.deepest} | ${p.level} | ${p.kills} | ${p.turns} | ${cause} | ${p.score} |`);
  }
  lines.push('');
  for (const p of summary.players) {
    const eq = Object.entries(p.equipment).map(([slot, k]) => `${slot}: ${kindName(catalog, L, k ?? null)}`).join(', ');
    lines.push(`- ${p.name} の最終装備: ${eq || 'なし'}`);
  }
  lines.push('');
  lines.push('## 出来事');
  lines.push('');
  const entityToPlayer = new Map<string, string>();
  const kills = new Map<string, number>();
  for (const ev of history) {
    if (ev.type === 'player_joined') {
      entityToPlayer.set(ev.entity.id, ev.player.name);
      lines.push(`- seq ${ev.seq}: ${ev.player.name}（${kindName(catalog, L, ev.player.classId)}）が地下1階に降り立った`);
    } else if (ev.type === 'entity_changed_floor' && entityToPlayer.has(ev.id)) {
      lines.push(`- seq ${ev.seq}: ${entityToPlayer.get(ev.id)} が ${ev.to.floor.replace('main:', '地下')}階へ（${ev.dir === 'down' ? '下り' : '上り'}）`);
    } else if (ev.type === 'level_up' && entityToPlayer.has(ev.target)) {
      lines.push(`- seq ${ev.seq}: ${entityToPlayer.get(ev.target)} がレベル ${ev.levelAfter} に上がった`);
    } else if (ev.type === 'died') {
      if (entityToPlayer.has(ev.id)) {
        lines.push(`- seq ${ev.seq}: ${entityToPlayer.get(ev.id)} は${ev.killerKind ? kindName(catalog, L, ev.killerKind) + 'に倒された' : '力尽きた'}`);
      } else if (ev.killer && entityToPlayer.has(ev.killer)) {
        kills.set(ev.kind, (kills.get(ev.kind) ?? 0) + 1);
      }
    } else if (ev.type === 'thought') {
      // 思考は多いので節目だけ
    }
  }
  if (kills.size) {
    lines.push('');
    lines.push('## 撃破');
    lines.push('');
    for (const [k, n] of [...kills.entries()].sort((a, b) => b[1] - a[1])) lines.push(`- ${kindName(catalog, L, k)} × ${n}`);
  }
  lines.push('');
  return lines.join('\n');
}
