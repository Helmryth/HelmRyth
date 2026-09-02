// Film 04 — Gates. A consequential action becomes a card you answer, and the
// answer is written down.
import { resetLane, seedOperators, openApp, startFilm, endFilm, ASSETS, sh } from "./scenes.mjs";
resetLane({ fresh: true });
seedOperators([{ name: "Forge", title: "Implementation operator", description: "Runs real tools on your machine.", color: "orange" }]);
const d = openApp("film");
startFilm(d, "04-gates.webm");

d.chapter("Every operator carries a permission policy");
d.sleep(2400);
d.clickNamed("permission policy|Gate each action"); d.sleep(3400);
d.press("Escape"); d.sleep(1600);

d.chapter("Ask for something consequential");
d.evalJs("() => { const t=document.querySelector('main textarea'); if(t) t.focus(); return 1; }");
d.sleep(600);
d.type("Create a file at /tmp/helmryth-demo/report.txt containing the word READY, using the Bash tool.");
d.sleep(1600);
d.press("Enter");

d.chapter("The gate appears in the transcript");
d.sleep(26000);
d.evalJs("() => { const s=document.querySelector('main .overflow-y-auto'); if(s) s.scrollTop=s.scrollHeight; return 1; }");
d.sleep(3000);
d.clickNamed("Allow once|^Allow$", "button", { required: false });
d.sleep(9000);
d.evalJs("() => { const s=document.querySelector('main .overflow-y-auto'); if(s) s.scrollTop=s.scrollHeight; return 1; }");
d.sleep(4000);

d.chapter("Every decision is written down");
d.sleep(2600);
endFilm(d);
console.log(sh(`ls -la ${ASSETS}/raw/04-gates.webm`));
