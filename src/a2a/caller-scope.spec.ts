import { describe, it, expect } from "vitest";
import { verifiedCaller } from "./caller-scope.js";
import { normalizeGatekeeperOrigins } from "./verify.js";
import {
  GATEKEEPER_ORIGIN,
  SECOND_GATEKEEPER_ORIGIN
} from "../testing/fixtures.js";

/**
 * What a caller's scope has to be true of, stated as arithmetic rather than as a
 * story about an attack.
 *
 * The composition is the whole of the isolation `DurableTaskStore` claims and
 * `defineAgent` routes on: a scope names one object, so two callers sharing a
 * scope share a task list, a parked question and a push channel. Injective in
 * (issuer, key) is therefore not a nicety here. It is the property, and the
 * cases below are the ways it could fail.
 */

const KEY = "remote:7:analytics";

describe("verifiedCaller", () => {
  it("names one object per verified origin and claimed key, the same way every time", () => {
    const first = verifiedCaller(GATEKEEPER_ORIGIN, { key: KEY });
    const again = verifiedCaller(GATEKEEPER_ORIGIN, {
      key: KEY,
      name: "other"
    });

    expect(first.scope).toBe(`${GATEKEEPER_ORIGIN}#${KEY}`);
    // Only the key is read out of the claim: a gatekeeper that renames an
    // instance, or omits a field it used to send, must keep reaching the object
    // holding that caller's tasks.
    expect(again.scope).toBe(first.scope);
    expect(first.issuer).toBe(GATEKEEPER_ORIGIN);
    expect(first.identity.key).toBe(KEY);
  });

  it("gives two listed gatekeepers claiming one key two objects", () => {
    // The case a flat allowlist cannot express on its own: both tokens are
    // honest about who signed them, and both name the same caller.
    const mine = verifiedCaller(GATEKEEPER_ORIGIN, { key: KEY });
    const theirs = verifiedCaller(SECOND_GATEKEEPER_ORIGIN, { key: KEY });

    expect(theirs.scope).not.toBe(mine.scope);
  });

  it("keeps one gatekeeper's own callers apart", () => {
    // The other half of the same property, and the one that was already true:
    // binding to the issuer must not collapse a gatekeeper's callers into one.
    const one = verifiedCaller(GATEKEEPER_ORIGIN, { key: "remote:7:a" });
    const two = verifiedCaller(GATEKEEPER_ORIGIN, { key: "remote:7:b" });

    expect(two.scope).not.toBe(one.scope);
  });

  it("cannot be made to spell another gatekeeper's scope through its key", () => {
    // A separator an issuer could write into its key would make the two halves
    // ambiguous, and then a chosen key could reproduce a scope nobody granted.
    // The issuer half cannot contain the separator, so the first one always ends
    // it, whatever the key holds.
    const victim = verifiedCaller(SECOND_GATEKEEPER_ORIGIN, { key: KEY });
    const attempts = [
      victim.scope,
      `#${victim.scope}`,
      `${SECOND_GATEKEEPER_ORIGIN}#${KEY}`,
      `..#${KEY}`
    ];

    for (const key of attempts) {
      const mine = verifiedCaller(GATEKEEPER_ORIGIN, { key });
      expect(mine.scope).not.toBe(victim.scope);
      // Stronger than inequality, and the reason for it: every scope this
      // origin can produce is still readable as this origin's.
      expect(mine.scope.slice(0, mine.scope.indexOf("#"))).toBe(
        GATEKEEPER_ORIGIN
      );
    }
  });

  it("does not move when a configured origin is re-spelled", () => {
    // Re-keying every caller is a deploy-time cost (`README.md` says what it
    // costs), so it must answer to the allowlist's *value* and not to how an
    // operator typed it. The normalizer is the single home of that, and this is
    // the coupling: a scope moves only if normalization does.
    const spellings = normalizeGatekeeperOrigins([
      "gatekeeper.test",
      "http://gatekeeper.test",
      "https://gatekeeper.test/"
    ]);
    const scopes = new Set(
      spellings.map((origin) => verifiedCaller(origin, { key: KEY }).scope)
    );

    expect(scopes.size).toBe(1);
    expect([...scopes][0]).toBe(`${GATEKEEPER_ORIGIN}#${KEY}`);
  });

  it("refuses a caller with no key rather than naming a shared object", () => {
    // An absent claim yields an empty identity by design, which is exactly the
    // caller that must not be routed: a default name here would be one object
    // every keyless caller shares.
    expect(() => verifiedCaller(GATEKEEPER_ORIGIN, {})).toThrow(
      /identity key/i
    );
    expect(() => verifiedCaller(GATEKEEPER_ORIGIN, { key: "" })).toThrow(
      /identity key/i
    );
  });

  it("refuses an issuer that is not an origin", () => {
    // The separator argument rests on the issuer being an origin, so anything
    // that could carry a path, a query or a fragment of its own is refused here
    // rather than silently composed into an ambiguous name.
    for (const issuer of [
      "",
      "gatekeeper.test",
      "https://gatekeeper.test/",
      "https://gatekeeper.test/hooks",
      "https://gatekeeper.test#x",
      "not a url"
    ]) {
      expect(() => verifiedCaller(issuer, { key: KEY })).toThrow(/origin/i);
    }
  });
});
