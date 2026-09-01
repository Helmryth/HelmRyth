import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { routeSpokenGroupMessage } from "./group-call";

function member(id: string, name: string): Bot {
  return {
    id,
    threadId: `thread-${id}`,
    name,
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "test", model: "test" },
    messages: [],
  };
}

const members = [member("atlas", "Atlas"), member("divyam", "Divyam"), member("research", "Deep Research")];

describe("routeSpokenGroupMessage", () => {
  it("turns a spoken member name into an explicit mention", () => {
    expect(routeSpokenGroupMessage("Atlas, can you take this?", members)).toEqual({
      text: "@Atlas can you take this?",
      addressed: true,
    });
    expect(routeSpokenGroupMessage("Hey Deep Research: find the source", members)).toEqual({
      text: "@Deep Research find the source",
      addressed: true,
    });
    expect(routeSpokenGroupMessage("Atlas", members)).toEqual({
      text: "@Atlas",
      addressed: true,
    });
  });

  it("turns natural room-wide addresses into @everyone", () => {
    expect(routeSpokenGroupMessage("Everyone, give me your view", members)).toEqual({
      text: "@everyone give me your view",
      addressed: true,
    });
    expect(routeSpokenGroupMessage("everyone", members)).toEqual({
      text: "@everyone",
      addressed: true,
    });
  });

  it("preserves explicit tags and ordinary speech", () => {
    expect(routeSpokenGroupMessage("@Divyam please continue", members)).toEqual({
      text: "@Divyam please continue",
      addressed: true,
    });
    expect(routeSpokenGroupMessage("What should we build next?", members)).toEqual({
      text: "What should we build next?",
      addressed: false,
    });
  });
});
