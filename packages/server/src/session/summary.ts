// 「冒険の記録」(summary.md)。ラン終了時と、遠征の終了ごとに書き直す。遠征ごとの節を持つ。
import type { Catalog, GameEvent, RunSummary } from '@muse/shared';
import { endReasonText, kindName, objectiveText } from '@muse/shared';

export function summaryMarkdown(summary: RunSummary, history: readonly GameEvent[], catalog: Catalog): string {
  const L = 'ja';
  const lines: string[] = [];
  const ongoing = !summary.seed;
  lines.push(`# 冒険の記録 — ${summary.runId}${ongoing ? '（途中経過）' : ''}`);
  lines.push('');
  lines.push(`- ${ongoing ? '記録の時点' : '終了理由'}: ${summary.reason}`);
  if (summary.seed) lines.push(`- シード: \`${summary.seed}\`（同じシードで同じダンジョンを再現できる）`);
  lines.push(`- 最終 seq: ${summary.endedSeq}`);
  lines.push('');
  lines.push(`- スコア: ${summary.scoreVersion === 2 ? '版 2（確定点 = 遠征で持ち帰った戦利品の払い戻しの合計）' : '版 1（深度×1000 ほか）'}`);
  lines.push('');
  lines.push('| 名前 | クラス | 操作 | 達成した遠征 | 到達深度 | Lv | 撃破 | 手数 | 死因 | スコア |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const p of summary.players) {
    const cause = p.deathCause ? (catalog.monsters[p.deathCause] ? kindName(catalog, L, p.deathCause) : p.deathCause) : '-';
    lines.push(`| ${p.name} | ${kindName(catalog, L, p.classId)} | ${p.controller.kind}:${p.controller.label} | ${p.expeditions ?? 0} | ${p.deepest} | ${p.level} | ${p.kills} | ${p.turns} | ${cause} | ${p.score} |`);
  }
  lines.push('');
  for (const p of summary.players) {
    const eq = Object.entries(p.equipment).map(([slot, k]) => `${slot}: ${kindName(catalog, L, k ?? null)}`).join(', ');
    lines.push(`- ${p.name} の最終装備: ${eq || 'なし'}`);
  }
  lines.push('');
  const entityToPlayer = new Map<string, string>();
  const kills = new Map<string, number>();
  let section = '## 出来事';
  lines.push(section);
  lines.push('');
  for (const ev of history) {
    if (ev.type === 'player_joined') {
      entityToPlayer.set(ev.entity.id, ev.player.name);
      lines.push(`- seq ${ev.seq}: ${ev.player.name}（${kindName(catalog, L, ev.player.classId)}）が地下1階に降り立った`);
    } else if (ev.type === 'expedition_started') {
      const x = ev.expedition;
      section = `## 遠征 ${x.no}: ${objectiveText(L, x.objective)}`;
      lines.push('');
      lines.push(section);
      lines.push('');
      lines.push(`- seq ${ev.seq}: 遠征 ${x.no} を開始（達成 +${x.points} 点）`);
    } else if (ev.type === 'objective_completed') {
      lines.push(`- seq ${ev.seq}: 目的を達成した`);
    } else if (ev.type === 'expedition_ended') {
      const r = ev.result;
      const pay = r.payout ? `確定 +${r.payout.banked}${r.payout.lost ? `（失った戦利品 ${r.payout.lost}）` : ''}` : `獲得 +${r.points} 点`;
      lines.push(`- seq ${ev.seq}: 遠征 ${ev.no} 終了（${endReasonText(L, ev.reason)}）。${pay}、最深 地下${r.deepest}階、撃破 ${r.kills}、手番 ${r.turns}`);
    } else if (ev.type === 'player_state' && ev.state === 'at_camp') {
      lines.push(`- seq ${ev.seq}: ${summary.players.find((p) => p.id === ev.player)?.name ?? ev.player} がキャンプに戻った（${ev.reason === 'extracted' ? '帰還' : '撤退'}）`);
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
