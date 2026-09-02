import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { limitedOTPResponse } from "../src/otp-rate-limit";


const SEND_PATH = "https://registry.test/api/auth/email-otp/send-verification-otp";

const send = (email: string) =>
  limitedOTPResponse(
    new Request(SEND_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    }),
    env,
  );

/** Returns true when the limiter swallowed the request (cap reached). */
const capped = async (email: string) => (await send(email)) !== null;

describe("per-recipient OTP cap", () => {
  it("stops the fourth send to one address inside the window", async () => {
    const email = "ordinary@example.com";
    expect(await capped(email)).toBe(false);
    expect(await capped(email)).toBe(false);
    expect(await capped(email)).toBe(false);
    expect(await capped(email)).toBe(true);
  });

  it("counts an address too long for its own schema, instead of failing open", async () => {
    // The limiter's schema used to cap email at 254 chars. A longer address made
    // normalizedRecipient return null, limitedOTPResponse bail out, and the
    // per-recipient row never get written — so an overlong address could be
    // mailed without limit while only the coarse IP limiter applied.
    const overlong = `${"a".repeat(300)}@example.com`;
    expect(await capped(overlong)).toBe(false);
    expect(await capped(overlong)).toBe(false);
    expect(await capped(overlong)).toBe(false);
    expect(await capped(overlong), "the 4th send to an overlong address must be capped").toBe(true);
  });

  it("keeps separate addresses on separate budgets", async () => {
    const a = `${"b".repeat(300)}@example.com`;
    const b = `${"c".repeat(300)}@example.com`;
    for (let i = 0; i < 3; i += 1) expect(await capped(a)).toBe(false);
    expect(await capped(a)).toBe(true);
    expect(await capped(b), "a different recipient must not inherit the cap").toBe(false);
  });

  it("ignores requests with no usable email", async () => {
    const noEmail = new Request(SEND_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "sign-in" }),
    });
    expect(await limitedOTPResponse(noEmail, env)).toBeNull();
  });
});
