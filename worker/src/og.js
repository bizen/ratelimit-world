// シェアカードを PNG にする。X や LINE などは SVG の画像を表示しないので、サーバーで描いて PNG で返す。
// 文字は Google Fonts から「カードに出る文字だけ」の小さなフォントを取ってきて使う (Cache API に残す)
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

let ready = null;
const init = () => (ready ??= initWasm(resvgWasm));

const FONTS = [
  { family: "Dela Gothic One", spec: "Dela+Gothic+One" },
  { family: "Zen Maru Gothic", spec: "Zen+Maru+Gothic:wght@700" },
];

async function cached(key, load) {
  const cache = globalThis.caches?.default;
  const req = new Request(key);
  const hit = await cache?.match(req);
  if (hit) return hit.arrayBuffer();
  const buf = await load();
  await cache?.put(req, new Response(buf, { headers: { "cache-control": "public, max-age=2592000" } })).catch(() => {});
  return buf;
}

// text に含まれる文字だけのフォント (TrueType)。古いブラウザのふりをすると woff2 ではなく ttf が返る
async function fontFor(spec, text) {
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${spec}&text=${encodeURIComponent(text)}`, { headers: { "user-agent": "Mozilla/5.0" } }).then((r) => r.text());
  const url = css.match(/src: url\(([^)]+)\) format\('truetype'\)/)?.[1];
  if (!url) throw new Error(`font not found: ${spec}`);
  return cached(url, () => fetch(url).then((r) => r.arrayBuffer()));
}

// GitHub のアイコンを埋め込める形 (data URI) にする。取れなければ null
export async function avatarData(url) {
  if (!url || !/^https:\/\/avatars\.githubusercontent\.com\//.test(url)) return null;
  try {
    const u = new URL(url);
    u.searchParams.set("s", "160");
    const r = await fetch(u, { cf: { cacheTtl: 86400 } });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") || "image/png";
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

export async function svgToPng(svg) {
  // カードに出る文字 (タグの外の部分) だけを集めて、フォントを小さく取る
  const text = [...new Set(svg.replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/g, " ").replace(/\s/g, ""))].join("") + " ";
  const [, ...buffers] = await Promise.all([init(), ...FONTS.map((f) => fontFor(f.spec, text))]);
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    font: { fontBuffers: buffers.map((b) => new Uint8Array(b)), loadSystemFonts: false, defaultFontFamily: "Zen Maru Gothic" },
  });
  const png = r.render().asPng();
  r.free();
  return png;
}
