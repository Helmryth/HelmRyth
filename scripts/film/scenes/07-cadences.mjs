// Film 07 — Cadences and webhooks. Work that starts without you.
import { resetLane, seedOperators, openApp, startFilm, endFilm, ASSETS, sh } from "./scenes.mjs";
resetLane({ fresh: true });
seedOperators([{ name: "Vesper", title: "Watch officer", description: "Runs the morning brief.", color: "blue" }]);
const d = openApp("film");
startFilm(d, "07-cadences.webm");

d.chapter("Runs & cadences");
d.sleep(2000);
d.clickNamed("Runs & cadences"); d.sleep(3000);

d.chapter("Schedule a run that starts without you");
d.clickNamed("New cadence"); d.sleep(2600);
d.fillNamed("Cadence name", "Monday release brief"); d.sleep(1200);
d.evalJs("() => { const t=document.querySelector('[role=dialog] textarea'); if(t) t.focus(); return 1; }");
d.sleep(500);
d.type("Summarise what changed on the release channel since Friday and flag anything that needs a decision.");
d.sleep(2600);
d.evalJs("() => { const d=[...document.querySelectorAll('[role=dialog]')].pop(); const s=d.querySelector('.overflow-y-auto')||d; s.scrollTop=s.scrollHeight; return 1; }");
d.sleep(2600);
d.clickNamed("Create cadence", "button", { required: false }); d.sleep(3400);

d.chapter("It lands on a calendar you can read");
d.sleep(3000);

d.chapter("Webhooks — work triggered by an event");
d.evalJs("() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Webhooks'); if(b) b.click(); return 1; }");
d.sleep(3000);
d.clickNamed("New webhook", "button", { required: false });
d.sleep(3000);
// This dialog picks an operator and takes the run instruction; there is no name
// field, which is why the previous cut hunted for one and stalled.
d.evalJs("() => { const dlg=[...document.querySelectorAll('[role=dialog]')].pop(); const b=[...dlg.querySelectorAll('button')].find(x=>/Vesper/.test(x.textContent)); if(b) b.click(); return 1; }");
d.sleep(2400);
d.evalJs("() => { const dlg=[...document.querySelectorAll('[role=dialog]')].pop(); const s=dlg.querySelector('summary'); if(s) s.click(); return 1; }");
d.sleep(2600);
d.clickNamed("Create local webhook", "button", { required: false });
d.sleep(4500);

d.chapter("An endpoint you can call — with a credential you can rotate");
d.evalJs("() => { const s=document.querySelector('main .overflow-y-auto')||document.querySelector('main'); if(s) s.scrollTop=s.scrollHeight; return 1; }");
d.sleep(4000);
d.clickNamed("Rotate", "button", { required: false });
d.sleep(2200);
d.pw("dialog-accept");
d.sleep(3800);
endFilm(d);
console.log(sh(`ls -la ${ASSETS}/raw/07-cadences.webm`));
