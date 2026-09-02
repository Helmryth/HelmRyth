// Film 05 — Isolated Workbench. A real container with a real desktop, and a
// control lease so you and the operator are never fighting over the mouse.
import { resetLane, seedOperators, openApp, startFilm, endFilm, ASSETS, sh } from "./scenes.mjs";
resetLane({ fresh: true });
seedOperators([{ name: "Forge", title: "Implementation operator", description: "Works inside an isolated desktop.", color: "orange" }]);
const d = openApp("film");
startFilm(d, "05-workbench.webm");

d.chapter("System — Workbench");
d.sleep(2200);
d.clickNamed("^System$"); d.sleep(2600);
d.clickNamed("^Workbench$", "button", { required: false }); d.sleep(4200);

d.chapter("A real container, with a real status");
d.sleep(3600);
d.evalJs("() => { const s=[...document.querySelectorAll('[role=dialog] .overflow-y-auto')].pop(); if(s) s.scrollTop=200; return 1; }");
d.sleep(3000);

d.chapter("Shared, or one desktop per operator");
d.clickNamed("Dedicated per operator|Shared workbench", "button", { required: false });
d.sleep(3600);
d.evalJs("() => { const s=[...document.querySelectorAll('[role=dialog] .overflow-y-auto')].pop(); if(s) s.scrollTop=420; return 1; }");
d.sleep(3200);
d.press("Escape"); d.sleep(2000);

d.chapter("Watch the operator work — and take the controls back");
d.evalJs("() => { const b=[...document.querySelectorAll('button')].find(x=>/Open operator workbench|operator workbench/i.test(x.getAttribute('aria-label')||'')); if(b){b.click(); return 'OPENED';} return 'NOT-FOUND'; }");
d.sleep(7000);
// The live surface and its control lease live in the right rail.
d.evalJs("() => { const el=[...document.querySelectorAll('*')].find(n=>/Take controls|Return controls|live surface/i.test(n.textContent||'') && n.children.length<=3); if(el){ el.scrollIntoView({block:'center'}); return 'FOUND:'+el.textContent.trim().slice(0,44);} return 'NOT-FOUND'; }");
d.sleep(4200);
d.clickNamed("Take controls", "button", { required: false });
d.sleep(4000);
endFilm(d);
console.log(sh(`ls -la ${ASSETS}/raw/05-workbench.webm`));
