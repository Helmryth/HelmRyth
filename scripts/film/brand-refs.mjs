// Render the reference sheets an image model needs in order to draw something
// that is actually Helmryth rather than generic AI-repo neon.
//
//   node scripts/film/brand-refs.mjs
//
// Three sheets are generated from the real assets — the icon's own SVG geometry,
// the DESIGN.md tokens, and the shipped webfonts — so nothing here is a
// second-hand description of the brand. A fourth reference is a real product
// frame lifted straight out of a film. Written to output/brand-refs/.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { PW, REPO } from "./paths.mjs";

const OUT = `${REPO}/output/brand-refs`;
const DIST = `${REPO}/dist`;
const PORT = 5959;

const CSS = readFileSync(`${DIST}/index.html`, "utf8").match(/\/assets\/index-[\w-]+\.css/)?.[0];
if (!CSS) throw new Error("could not find the built stylesheet in dist/index.html");

// The mark, lifted verbatim from build/icon.svg so the geometry cannot drift.
const ICON = readFileSync(`${REPO}/build/icon.svg`, "utf8")
  .replace(/<\?xml[^>]*\?>/, "")
  .replace(/<title[\s\S]*?<\/desc>/, "");

const shell = (title, body, extra = "") => `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="${CSS}">
<style>
  :root{--canvas:#F6F1E7;--ink:#1E2433;--mark:#C44F36;--score:#167A78;--rule:#D6CAB9}
  *{box-sizing:border-box;margin:0}
  body{width:1600px;height:1000px;background:var(--canvas);color:var(--ink);
       font-family:"Atkinson Hyperlegible Next Variable",system-ui,sans-serif;
       padding:64px 72px;display:flex;flex-direction:column;gap:34px}
  h1{font-family:"Geologica Variable",system-ui,sans-serif;font-weight:620;
     font-size:40px;letter-spacing:-.035em;line-height:1}
  .eyebrow{font-size:13px;font-weight:650;letter-spacing:.16em;text-transform:uppercase;
           color:var(--score)}
  .note{font-size:15px;line-height:1.5;color:#4A5163;max-width:78ch}
  ${extra}
</style>
<div class="eyebrow">Helmryth · brand reference</div>
<h1>${title}</h1>
${body}`;

const SHEETS = {
  "ref-1-mark": shell(
    "The mark, and the geometry that makes it",
    `<div class="row">
       <div class="tile">${ICON}</div>
       <div class="facts">
         <p class="note"><b>Square staves, clipped corners, hard right angles.</b> There is not one
         curve in this mark and there must not be one in the image. The corners are cut at 45°, the
         strokes are square-capped, and every angle is 90° or 45°.</p>
         <p class="note"><b>The score line runs behind and past it.</b> A single petrol rule crosses
         the full width, continuing beyond the mark on both sides. It is always behind.</p>
         <p class="note"><b>Flat, printed, matte.</b> No gradient, no bevel, no glow, no drop shadow
         in the mark itself. Ink on paper, not glass or chrome.</p>
         <ul class="note">
           <li>tile &amp; paper — <code>#F6F1E7</code></li>
           <li>mark — <code>#C44F36</code> vermilion</li>
           <li>score — <code>#167A78</code> petrol</li>
           <li>hairline — <code>#D6CAB9</code></li>
         </ul>
       </div>
     </div>`,
    `.row{display:flex;gap:56px;align-items:center;flex:1}
     .tile{width:520px;flex:none}.tile svg{width:100%;height:auto}
     .facts{display:flex;flex-direction:column;gap:18px}
     ul{padding-left:20px}li{margin:4px 0}
     code{font-family:ui-monospace,monospace;background:#EFE8DA;padding:1px 6px;border-radius:3px}`,
  ),

  "ref-2-palette": shell(
    "The only colours that exist in this image",
    `<div class="sw">
       ${[
         ["#F6F1E7", "canvas", "warm bone paper — the ground, ~60% of the frame"],
         ["#C44F36", "mark", "vermilion — the one saturated colour, used sparingly"],
         ["#167A78", "score", "petrol teal — a single rule, never a fill"],
         ["#1E2433", "ink", "navy-black — hairlines and shadow only"],
         ["#D6CAB9", "rule", "warm grey — edges and tooth"],
       ].map(([hex, name, use]) => `
         <div class="chip">
           <div class="patch" style="background:${hex}"></div>
           <div class="meta"><b>${name}</b><code>${hex}</code><span>${use}</span></div>
         </div>`).join("")}
     </div>
     <p class="note"><b>No other colour may appear.</b> No blue-purple tech gradient, no gold, no
     chrome, no neon. Brass, if present, is desaturated and warm. The image is overwhelmingly warm
     paper with two ink accents.</p>`,
    `.sw{display:flex;gap:22px;flex:1;align-items:stretch}
     .chip{flex:1;display:flex;flex-direction:column;gap:14px}
     .patch{flex:1;border:1px solid var(--rule);border-radius:4px}
     .meta{display:flex;flex-direction:column;gap:4px}
     .meta b{font-family:"Geologica Variable";font-size:19px;font-weight:590}
     .meta code{font-family:ui-monospace,monospace;font-size:14px;color:#4A5163}
     .meta span{font-size:13px;line-height:1.4;color:#5A6274}`,
  ),

  "ref-3-composition": shell(
    "Hero composition — 2:1, and mostly empty",
    `<div class="frame">
       <div class="air"><span>negative space — roughly 60% bare paper, no detail, no texture noise</span></div>
       <div class="scoreline"></div>
       <div class="subject">
         <span class="lab">subject sits in the lower third, left of centre</span>
         <div class="staves">${[70, 108, 88, 132, 96, 78].map((h, i) =>
           `<i style="height:${h}px${i === 3 ? ";background:#C44F36;outline:2px solid #1E2433" : ""}"></i>`).join("")}</div>
       </div>
     </div>
     <p class="note"><b>Light rakes from the upper left</b> at a low angle; real shadows pool to the
     lower right. One light source, no fill, no rim light. <b>One element steps forward</b> and
     catches more of it — that asymmetry is the whole composition.</p>`,
    `.frame{position:relative;flex:1;border:1px solid var(--rule);background:#FBF8F2;
            display:flex;flex-direction:column;justify-content:flex-end;padding:38px;overflow:hidden}
     .air{position:absolute;inset:0;display:flex;align-items:flex-start;justify-content:center;padding-top:56px}
     .air span{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#9A9384}
     .scoreline{position:absolute;left:0;right:0;bottom:126px;height:3px;background:var(--score)}
     .subject{position:relative;display:flex;flex-direction:column;gap:12px}
     .lab{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#9A9384}
     .staves{display:flex;align-items:flex-end;gap:16px}
     .staves i{width:44px;background:#C9705A;display:block}`,
  ),
};

mkdirSync(OUT, { recursive: true });
for (const [name, html] of Object.entries(SHEETS)) writeFileSync(`${DIST}/${name}.html`, html);

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", DIST], {
  stdio: "ignore", detached: true,
});
const pw = (...a) => execFileSync(PW, ["-s=brandrefs", ...a], { encoding: "utf8", stdio: "pipe" });

try {
  execFileSync("bash", ["-lc",
    `for _ in $(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:${PORT}/ && break; sleep 0.25; done`]);
  for (const name of Object.keys(SHEETS)) {
    pw("open", `http://127.0.0.1:${PORT}/${name}.html`);
    // Resize AFTER the navigation: opening a page resets the viewport, so a
    // resize hoisted out of this loop silently leaves every sheet cropped to
    // the 1280x720 default with its right-hand column cut off.
    pw("resize", "1600", "1000");
    execFileSync("bash", ["-lc", "sleep 1.2"]); // let the variable webfonts settle before the shot
    pw("screenshot", "--full-page", "--hires", "--filename", `${OUT}/${name}.png`);
    console.log(`  ${name}.png`);
  }
  pw("close");
} finally {
  process.kill(-server.pid, "SIGTERM");
}

// The fourth reference is not a diagram: it is the product itself, so the model
// can see the warm instrument-panel palette sitting in a real interface.
copyFileSync(`${REPO}/docs/media/04-gates.png`, `${OUT}/ref-4-product.png`);
console.log("  ref-4-product.png (real frame from film 04)");
console.log(`\nwritten to ${OUT}`);
