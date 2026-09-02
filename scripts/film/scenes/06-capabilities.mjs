// Film 06 — Capabilities. 500 real connectors, brokered so the key never sits
// in the transcript.
import { resetLane, seedOperators, openApp, startFilm, endFilm, ASSETS, sh } from "./scenes.mjs";
resetLane({ fresh: true });
seedOperators([{ name: "Vesper", title: "Watch officer", description: "Watches the channels you connect.", color: "blue" }]);
const d = openApp("film");
startFilm(d, "06-capabilities.webm");

d.chapter("Capabilities — what your operators can reach");
d.sleep(2200);
d.clickNamed("^Capabilities$"); d.sleep(5000);

d.chapter("Five hundred connectors, live from the broker");
d.sleep(3000);
d.fillNamed("Search", "gmail"); d.sleep(3200);
d.fillNamed("Search", "github"); d.sleep(3000);
d.fillNamed("Search", "notion"); d.sleep(2800);
d.fillNamed("Search", ""); d.sleep(2000);

d.chapter("Connecting one is an explicit, named act");
d.clickNamed("Connect Slack|Connect Notion|Connect GitHub", "button", { required: false });
d.sleep(4500);
d.press("Escape"); d.sleep(1600);

d.chapter("Granted capabilities are listed, and revocable");
// "Active" is a plain button in this panel, not role=tab — matching on tab left
// the last 8s of the film on a dead grey pane.
d.evalJs("() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Active'); if(b){b.click(); return 'ACTIVE-TAB'; } return 'NOT-FOUND'; }");
d.sleep(4200);
d.evalJs("() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Catalog'); if(b) b.click(); return 1; }");
d.sleep(2600);
endFilm(d);
console.log(sh(`ls -la ${ASSETS}/raw/06-capabilities.webm`));
