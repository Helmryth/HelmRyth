export interface LeadOperatorRosterMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
  busy?: boolean;
  hidden?: boolean;
  section?: string;
}

// The roster is interpolated into a TRUSTED bot's system prompt on every
// turn, and its inputs (name/title/description) are user-editable and — via
// team import — third-party-authored. Caps bound both the token spend and
// how much room an imported persona gets to talk to the Chief with system
// authority. agents-proxy applies the same discipline (120-char list_bots
// descriptions); these are the roster's own limits.
const ROSTER_MAX_OPERATORS = 40;
const ROSTER_NAME_MAX = 80;
const ROSTER_ROLE_MAX = 120;
const ROSTER_ABOUT_MAX = 200;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const sectionKey = (section?: string): string => section?.trim() || "";

/** Dynamic system context for a section's lead operator.
 * It names the current crew on every turn, while list_operators remains the
 * authoritative tool for IDs and live availability at delegation time. */
export function leadOperatorSystemPrompt(
  chiefId: string,
  bots: LeadOperatorRosterMember[],
  canDelegate: boolean,
  trustedHelmrythStatus = "",
): string {
  const chief = bots.find((bot) => bot.id === chiefId);
  const chiefSection = sectionKey(chief?.section);
  const sectionName = chiefSection || "General";
  const team = bots.filter(
    (bot) => bot.id !== chiefId && !bot.hidden && sectionKey(bot.section) === chiefSection,
  );
  const listed = team.slice(0, ROSTER_MAX_OPERATORS);
  const overflow = team.length - listed.length;
  const roster = team.length
    ? listed
        .map((bot) => {
          const name = clip(bot.name, ROSTER_NAME_MAX);
          const role = clip(bot.title?.trim() || "General operator", ROSTER_ROLE_MAX);
          const about = bot.description?.trim();
          const availability = bot.busy ? "working right now" : "available";
          return `- ${name} — ${role}${about ? `: ${clip(about, ROSTER_ABOUT_MAX)}` : ""} (${availability})`;
        })
        .join("\n") + (overflow > 0 ? `\n- …and ${overflow} more (use list_operators for the full roster).` : "")
    : "- No other visible operators are available yet.";

  const delegation = canDelegate
    ? [
        "Use list_operators to confirm the live roster and IDs. Use ask_operator when a crew member is better suited to part of the request.",
        "When the user asks you to assemble a crew, use create_operator for each genuinely useful specialist. Give each one a clear role and instructions, then use delegate_operator to assign its work. Do not create duplicate or unnecessary operators.",
        "Delegate with a clear, self-contained brief and wait for the teammate's actual reply before claiming its work is complete.",
        "You may consult more than one teammate when the request genuinely benefits, then combine their results into one coherent answer.",
      ].join(" ")
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

  return [
    `You are the lead operator for the ${sectionName} section. You are the user's primary contact for this crew.`,
    "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
    "Do not delegate trivial work merely to appear busy. Never invent a crew member's progress or result. Normal gate rules still apply.",
    delegation,
    `Current ${sectionName} crew:`,
    roster,
    trustedHelmrythStatus,
  ].filter(Boolean).join("\n");
}
