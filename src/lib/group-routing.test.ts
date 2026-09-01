import { describe, expect, it } from "vitest";

import {
  groupComposerHint,
  groupResponseHint,
  roomRespondersForComposer,
} from "./group-routing";

describe("roomRespondersForComposer", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "divyam", name: "Divyam" },
  ];

  it("routes an unmentioned message to the configured lead", () => {
    expect(
      roomRespondersForComposer("hello there", members, {
        defaultResponder: { kind: "member", botId: "atlas" },
      }),
    ).toEqual([members[0]]);
  });

  it("lets explicit mentions override the configured lead", () => {
    expect(
      roomRespondersForComposer("@Divyam take this", members, {
        defaultResponder: { kind: "member", botId: "atlas" },
      }),
    ).toEqual([members[1]]);
  });

  it("supports everyone and mentions-only room policies", () => {
    expect(
      roomRespondersForComposer("hello", members, {
        defaultResponder: { kind: "everyone" },
      }),
    ).toEqual(members);
    expect(
      roomRespondersForComposer("hello", members, {
        defaultResponder: { kind: "mentions" },
      }),
    ).toEqual([]);
    expect(
      roomRespondersForComposer("@everyone hello", members, {
        defaultResponder: { kind: "mentions" },
      }),
    ).toEqual(members);
  });

  it("uses Helmryth operator and workstream language in routing hints", () => {
    // SAFETY: The direct-workstream branch reads only `dm`; unrelated persisted Group fields are intentionally absent.
    const directCrew = { dm: true } as Parameters<typeof groupResponseHint>[0];
    // SAFETY: The routing-hint branch reads only `dm` and `defaultResponder`; this fixture supplies both invariants.
    const everyoneCrew = {
      dm: false,
      defaultResponder: { kind: "everyone" as const },
    } as Parameters<typeof groupResponseHint>[0];

    expect(groupResponseHint(directCrew, [])).toBe(
      "Reply here to continue the operator-to-operator workstream.",
    );
    expect(groupResponseHint(everyoneCrew, [])).toBe(
      "Every operator responds unless you @mention specific operators.",
    );
    expect(groupComposerHint(everyoneCrew, [])).toBe("every operator responds");
  });
});
