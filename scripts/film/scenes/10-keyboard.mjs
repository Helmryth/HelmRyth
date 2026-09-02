// Film 10 — Keyboard-first, and private by construction.
import { resetLane, seedOperators, openApp, startFilm, endFilm, ASSETS, sh } from "./scenes.mjs";
resetLane({ fresh: true });
seedOperators([
  { name: "Vesper", title: "Watch officer", description: "Raises what needs a decision.", color: "blue" },
  { name: "Cairn", title: "Research keeper", description: "Holds the evidence file.", color: "teal" },
  { name: "Forge", title: "Implementation operator", description: "Turns a plan into a change.", color: "orange" },
]);
const d = openApp("film");
startFilm(d, "10-keyboard.webm");

d.chapter("Command palette — everything is one chord away");
d.sleep(2200);
d.press("ControlOrMeta+k"); d.sleep(2600);
d.type("cairn"); d.sleep(2600);
d.press("Enter"); d.sleep(2800);
d.press("ControlOrMeta+k"); d.sleep(1800);
d.type("forge"); d.sleep(2200);
d.press("Enter"); d.sleep(2600);

d.chapter("Drive the whole app from the keyboard");
for (let i = 0; i < 7; i += 1) { d.press("Tab"); d.sleep(420); }
d.sleep(2000);
d.press("Escape"); d.sleep(1400);

d.chapter("Your keys are write-only");
d.clickNamed("^System$"); d.sleep(2400);
d.clickNamed("^Connections$", "button", { required: false }); d.sleep(4000);
d.evalJs("() => { const s=[...document.querySelectorAll('[role=dialog] .overflow-y-auto')].pop(); if(s) s.scrollTop=160; return 1; }");
d.sleep(3600);

d.chapter("Telemetry is off, and it is a switch you own");
d.evalJs("() => { const b=[...document.querySelectorAll('[role=dialog] button')].find(x=>x.textContent.trim()==='System'); if(b) b.click(); return 1; }");
d.sleep(2600);
// Scroll to the analytics row itself rather than the bottom of the pane.
d.evalJs("() => { const el=[...document.querySelectorAll('[role=dialog] *')].find(n=>/telemetry|analytics|Product analytics/i.test(n.textContent||'') && n.children.length<=3); if(el){ el.scrollIntoView({block:'center'}); return 'FOUND:'+el.textContent.trim().slice(0,50);} return 'NOT-FOUND'; }");
d.sleep(4200);
d.press("Escape"); d.sleep(1800);
endFilm(d);
console.log(sh(`ls -la ${ASSETS}/raw/10-keyboard.webm`));
