/**
 * The session a person drives to connect a no-API platform.
 *
 * This is the shape of bug a unit test is actually for: both fields were wrong
 * in a way that throws nothing. `api_timeout` is not a Browserbase field, so it
 * was silently dropped; keepAlive was missing, so the session ended the instant
 * the CDP client disconnected, which this flow does on purpose. The symptom
 * reached the user as "410 Session stopped" on the live URL, a long way from
 * the cause.
 */
import { describe, expect, it } from "vitest";

import { loginSessionOptions } from "../../lib/influencer/browser";

describe("loginSessionOptions", () => {
  it("keeps the session alive after we disconnect", () => {
    // The flow opens the sign-in page over CDP and then lets go so the live
    // view can take over. Without this the session is gone before the person
    // clicks the link.
    expect(loginSessionOptions("proj", "ctx").keepAlive).toBe(true);
  });

  it("uses the field name Browserbase actually reads", () => {
    const opts = loginSessionOptions("proj", "ctx", { timeoutSeconds: 900 });
    expect(opts.timeout).toBe(900);
    expect(opts).not.toHaveProperty("api_timeout");
  });

  it("defaults to fifteen minutes, which is a password plus a 2FA prompt", () => {
    expect(loginSessionOptions("proj", "ctx").timeout).toBe(15 * 60);
  });

  it("persists the context, because the login IS the credential", () => {
    // Nothing else is stored: no password, just the cookie jar Browserbase
    // writes back when the session ends.
    expect(loginSessionOptions("proj", "ctx-1").browserSettings).toEqual({
      context: { id: "ctx-1", persist: true },
    });
  });

  it("only asks for proxies when told to", () => {
    expect(loginSessionOptions("proj", "ctx")).not.toHaveProperty("proxies");
    expect(loginSessionOptions("proj", "ctx", { proxies: true }).proxies).toBe(true);
  });
});
