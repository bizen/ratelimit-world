// リーグ: 同じツール×課金プランの最大 30人で、1週間の XP を競う。上位は昇格、下位は降格。
// 週は世界共通 (月曜 0:00 UTC 〜 次の月曜)。その週に初めて枠を使い切った時点で、空きのあるグループに入る
import { DAY } from "./logic.js";

export const LEAGUE_SIZE = 30;
export const LEAGUE_TIERS = 10; // 0 = ブロンズ … 9 = ダイヤモンド
export const TIER_EMOJI = ["🥉", "🥈", "🥇", "💙", "❤️", "💚", "💜", "🤍", "🖤", "💎"];

// その時刻を含む週: id は月曜の日付 (UTC)
export function leagueWeek(now = Date.now()) {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  return { id: new Date(start).toISOString().slice(0, 10), start, end: start + 7 * DAY };
}

export const prevWeek = (w) => leagueWeek(w.start - DAY);

// 週の XP: computeStats の xpLog のうち、その週に入るもの
export const leagueXp = (s, w) => s.xpLog.reduce((n, e) => (e.at >= w.start && e.at < w.end ? n + e.xp : n), 0);

// 昇格・降格する人数。人数が少ないグループでは減らす (最上位は昇格なし、最下位は降格なし)
export function zones(n, tier) {
  const up = tier >= LEAGUE_TIERS - 1 ? 0 : Math.min(7, Math.ceil(n / 4));
  const down = tier <= 0 || n < 5 ? 0 : Math.min(5, Math.floor(n / 5));
  return { up, down: Math.min(down, Math.max(0, n - up)) };
}

// 並び順: XP が多い順、同じなら先に参加した人が上
export const byStanding = (a, b) => b.xp - a.xp || a.joined_at - b.joined_at;

// 週が終わったグループの結果: [{user_id, rank, result: 'up' | 'down' | 'stay'}]
export function settle(members, tier) {
  const sorted = [...members].sort(byStanding);
  const { up, down } = zones(sorted.length, tier);
  return sorted.map((m, i) => ({
    user_id: m.user_id, rank: i + 1,
    result: i < up && m.xp > 0 ? "up" : i >= sorted.length - down ? "down" : "stay",
  }));
}

// 前の週の結果から、次に入るリーグの段位
export const nextTier = (prev) => (!prev ? 0 : Math.max(0, Math.min(LEAGUE_TIERS - 1, prev.tier + (prev.result === "up" ? 1 : prev.result === "down" ? -1 : 0))));
