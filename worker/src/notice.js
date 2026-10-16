// スマホ通知の文面を、その人の言語で組み立てる (文言そのものは i18n.js の push)
import { localTime, comboXp, WINDOW_MS, WEEKLY_XP } from "./logic.js";
import { push, tierName, fmtWhen } from "./i18n.js";

// スマホ通知の文面を、その人の言語で組み立てる
export function notice(u, kind, s, now, { tool, w, minutes } = {}) {
  const lang = u.lang === "en" ? "en" : "ja";
  const P = push(lang);
  const nextTier = s ? tierName(lang, s.nextTier) : "";
  let m;
  if (kind === "reset") m = P.reset(tool, s, { next: localTime(now + WINDOW_MS, s.tz), nextXp: s.nextXp, nextTier });
  else if (kind === "soon") m = P.soon(tool, s, { minutes: Math.max(1, Math.round((w.reset_at - now) / 60000)), at: localTime(w.reset_at, s.tz) });
  else if (kind === "late") m = P.late(tool, minutes, s, { next: localTime(now + WINDOW_MS, s.tz) });
  else if (kind === "pinch") m = P.pinch(s);
  else if (kind === "goal") m = P.goal(s, { nextXp: s.nextXp, nextTier });
  else if (kind === "weekly") m = P.weekly(tool, s, { when: fmtWhen(lang, w.reset_at, s.tz), xp: WEEKLY_XP });
  else if (kind === "hit") {
    const tw = s.todayWindows.find((x) => x.tool === tool && x.resetAt === w.reset_at) ?? s.todayWindows.at(-1);
    const n = tw?.n ?? s.todayCount;
    m = P.hit(tool, s, { n, xp: tw?.xp ?? comboXp(n), tier: tierName(lang, tw?.tier ?? s.tier), resetAt: localTime(w.reset_at, s.tz), nextXp: comboXp(n + 1) });
  } else m = P.test();
  return { ...m, tag: tool ? `${kind}-${tool}` : kind };
}
