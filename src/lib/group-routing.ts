import type { Bot, Group, GroupDefaultResponder } from "@/state/store";

/** Be defensive around rooms loaded while an older server is still running,
 * and around a lead removed by another client before the group patch arrives. */
export function effectiveDefaultResponder(
  group: Pick<Group, "defaultResponder">,
  members: Array<{ id: string }>,
): GroupDefaultResponder {
  const value = group.defaultResponder;
  if (value?.kind === "everyone" || value?.kind === "mentions") return value;
  if (
    value?.kind === "member" &&
    members.some((member) => member.id === value.botId)
  )
    return value;
  return members[0]
    ? { kind: "member", botId: members[0].id }
    : { kind: "mentions" };
}

export function defaultResponderName(
  group: Group,
  members: Bot[],
): string | null {
  const value = effectiveDefaultResponder(group, members);
  if (value.kind !== "member") return null;
  return members.find((member) => member.id === value.botId)?.name ?? null;
}

export function groupResponseHint(group: Group, members: Bot[]): string {
  if (group.dm)
    return "Reply here to continue the operator-to-operator workstream.";
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "everyone")
    return "Every operator responds unless you @mention specific operators.";
  if (value.kind === "mentions")
    return "Mention an operator with @ to bring them into this run.";
  const name = defaultResponderName(group, members) ?? "The lead operator";
  return `${name} responds by default — @mention another operator to route this entry to them.`;
}

export function groupComposerHint(group: Group, members: Bot[]): string {
  if (group.dm) return "continue the workstream";
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "everyone") return "every operator responds";
  if (value.kind === "mentions") return "@ to bring in an operator";
  return `${defaultResponderName(group, members) ?? "Lead operator"} responds`;
}

/** Same routing sendGroup uses: explicit @mentions win, otherwise the
 * room's default responder. Keep this aligned with server/store.ts
 * `roomResponders` / `mentionedBots`. */
export function roomRespondersForComposer<
  T extends { id: string; name: string; hidden?: boolean },
>(text: string, members: T[], group: Pick<Group, "defaultResponder">): T[] {
  const available = members.filter((member) => !member.hidden);
  if (/(?:^|\s)@everyone\b/i.test(text)) return available;
  const mentioned = mentionedMembers(text, available);
  if (mentioned.length) return mentioned;
  const fallback = effectiveDefaultResponder(group, available);
  if (fallback.kind === "everyone") return available;
  if (fallback.kind === "member") {
    const lead = available.find((member) => member.id === fallback.botId);
    return lead ? [lead] : [];
  }
  return [];
}

function mentionedMembers<T extends { name: string; hidden?: boolean }>(
  text: string,
  peers: T[],
): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue;
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest[name.length];
      return after === undefined || !/[a-z0-9]/i.test(after);
    });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}
