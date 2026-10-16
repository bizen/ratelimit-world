// API 料金表 (USD / 100万トークン)。サブスクの枠を「API で同じ仕事をさせたらいくらか」に換算するのに使う。
// 料金が変わったらここだけ直す。PC 側はトークン数だけを送ってくる。
//
// 出典 (2026-10 時点):
// - Claude: Anthropic の料金表 (claude-api リファレンス, 2026-10-06 版)。
//   キャッシュ書き込みは入力の 1.25 倍 (5分) / 2 倍 (1時間)。キャッシュ読み出しは入力の 0.1 倍 (Opus 5.5 は $0.20)
// - OpenAI: GPT-6.1 Sol は公式発表 (https://openai.com/index/introducing-gpt-6-1-sol/)。
//   GPT-6 Sol と GPT-5.5 は第三者の料金まとめ。codex-auto-review などの非公開モデルは GPT-6.1 Sol と同じとみなす
export const PRICING_AS_OF = "2026-10";

// [入力, 出力, キャッシュ読み出し] (USD / 100万トークン)
const CLAUDE = [
  [/^claude-fable-5-1/, 10, 50, 0.25],
  [/^claude-(fable|mythos)-5/, 10, 50, 1],
  [/^claude-opus-5-5/, 4, 20, 0.2],
  [/^claude-opus-(5|4-[5-8])/, 5, 25, 0.5],
  [/^claude-opus/, 15, 75, 1.5],
  [/^claude-sonnet-5/, 2, 10, 0.2],
  [/^claude-sonnet/, 3, 15, 0.3],
  [/^claude-haiku-5-5/, 0.1, 0.5, 0.01],
  [/^claude-haiku/, 1, 5, 0.1],
];
const OPENAI = [
  [/^gpt-6\.1-sol/, 2, 10, 0.1],
  [/^gpt-6-sol/, 2, 10, 0.2],
  [/^gpt-5\.5/, 5, 30, 0.5],
];
const FALLBACK = { claude: [4, 20, 0.2], codex: [2, 10, 0.1] };

export function priceOf(tool, model) {
  const table = tool === "claude" ? CLAUDE : OPENAI;
  const hit = table.find(([re]) => re.test(model || ""));
  return hit ? { p: hit.slice(1), estimated: false } : { p: FALLBACK[tool], estimated: true };
}

// tokens: { model: [入力, キャッシュ書き込み5分, キャッシュ書き込み1時間, キャッシュ読み出し, 出力] } → USD
export function costOf(tool, tokens) {
  let usd = 0, estimated = false;
  for (const [model, t] of Object.entries(tokens || {})) {
    if (!Array.isArray(t) || t.length !== 5) continue;
    const { p: [inp, out, read], estimated: e } = priceOf(tool, model);
    // OpenAI のキャッシュ書き込みは入力と同じ扱い (公表されている割増しが確かでないため)
    const w5 = tool === "claude" ? inp * 1.25 : inp, w1 = tool === "claude" ? inp * 2 : inp;
    usd += (t[0] * inp + t[1] * w5 + t[2] * w1 + t[3] * read + t[4] * out) / 1e6;
    estimated ||= e;
  }
  return { usd, estimated };
}

// 出遅れ d 分は、その日の枠を d / (300 + d) 枠ぶん減らす (5時間の枠が 5時間+d 分かかるのと同じ)
export const lostWindowsOf = (delayMin) => delayMin / (300 + delayMin);

export const USD_JPY = 150; // 表示用の目安
