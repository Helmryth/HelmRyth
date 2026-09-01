import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { copyWebhookCommand, terminalCommand, terminalCommandPreview } from "./WebhooksPanel";

const credential = {
  endpointUrl: "http://127.0.0.1:8800/hooks/wh_demo",
  secret: "whsec_demo",
  idempotencyKey: "hry_evt_demo",
};

describe("webhook terminal command", () => {
  it("keeps the secret out of the URL and sends bearer plus stable idempotency headers", () => {
    const command = terminalCommand(credential);
    expect(command).toContain("'http://127.0.0.1:8800/hooks/wh_demo'");
    expect(command).toContain("'Authorization: Bearer whsec_demo'");
    expect(command).toContain("'Idempotency-Key: hry_evt_demo'");
    expect(command).not.toContain("/whsec_demo");
    expect(terminalCommand(credential)).toBe(command);
  });

  it("changes retry identity only when the server returns a new key", () => {
    expect(terminalCommand({ ...credential, idempotencyKey: "hry_evt_next" })).not.toBe(terminalCommand(credential));
  });

  it("masks the bearer secret in the visible preview while preserving the copied command", () => {
    const preview = terminalCommandPreview(credential);
    expect(preview).toContain("'http://127.0.0.1:8800/hooks/wh_demo'");
    expect(preview).toContain("'Authorization: Bearer <hidden: copied to clipboard>'");
    expect(preview).toContain("'Idempotency-Key: hry_evt_demo'");
    expect(preview).not.toContain("whsec_demo");
    expect(preview).not.toBe(terminalCommand(credential));
  });

  it("propagates clipboard denial without consuming or changing the one-time credential", async () => {
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error("clipboard denied")) };
    await expect(copyWebhookCommand(credential, clipboard)).rejects.toThrow("clipboard denied");
    expect(clipboard.writeText).toHaveBeenCalledWith(terminalCommand(credential));
    expect(credential.secret).toBe("whsec_demo");
  });
});

describe("WebhooksPanel setup preview", () => {
  it("wires the setup pre to the masked preview and never the raw command helper", () => {
    const source = readFileSync(new URL("./WebhooksPanel.tsx", import.meta.url), "utf8");

    expect(source).toMatch(/const commandPreview = credential \? terminalCommandPreview\(credential\) : "";/);
    expect(source).toMatch(/<pre\b[^>]*>\{commandPreview\}<\/pre>/);
    expect(source).not.toMatch(/<pre\b[^>]*>\{terminalCommand\(credential\)\}<\/pre>/);
  });
});
