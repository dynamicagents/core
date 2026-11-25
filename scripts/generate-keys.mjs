#!/usr/bin/env node
/**
 * Generate the Ed25519 keypair an agent signs its AgentCard with.
 *
 * The private half becomes the `A2A_SIGNING_KEY` secret; the public half is
 * served at the agent's JWKS path and pinned by the gatekeeper on first
 * registration (Trust-On-First-Use). No secret is shared in either direction —
 * see `src/a2a/verify.ts` for the other half of the contract.
 *
 *   node scripts/generate-keys.mjs              # print the private JWK
 *   node scripts/generate-keys.mjs --kid my-key # choose the key id
 *
 * The `kid` is required, not decorative: it goes in the JWS protected header and
 * is what a gatekeeper pins, so `parsePrivateJwk` refuses a key without one. Rotate
 * by generating a new key with a *new* kid and serving both public keys until
 * every gatekeeper has re-fetched.
 */
import { generateKeyPair, exportJWK } from "jose";
import { A2A_JWS_ALG } from "@dynamicagents/g2a-protocol";

const args = process.argv.slice(2);
const kidFlag = args.indexOf("--kid");
const kid =
  kidFlag !== -1 && args[kidFlag + 1]
    ? args[kidFlag + 1]
    : `a2a-${new Date().toISOString().slice(0, 10)}`;

// The algorithm is `@dynamicagents/g2a-protocol`'s `A2A_JWS_ALG` rather than a
// literal, because that package owns the wire's one signature algorithm and a
// key generated for any other is useless. This is a bin shipped in `files`, and
// it may import that package for the same reason it may import `jose`: both are
// plain dependencies of this one, so an installed tarball resolves them.
//
// `extractable` is required to export the private half at all. Only the
// private half is printed: the public one is derived from it at runtime and
// served at the JWKS route, so there is nothing to copy anywhere.
const { privateKey } = await generateKeyPair(A2A_JWS_ALG, {
  crv: "Ed25519",
  extractable: true
});

const priv = { ...(await exportJWK(privateKey)), kid };

console.log(`\nGenerated Ed25519 keypair (kid: ${kid})\n`);
console.log(
  "Add this line to .env — it is the private half, never commit it:\n"
);
console.log(`A2A_SIGNING_KEY=${JSON.stringify(priv)}\n`);
console.log(
  "To deploy it, push the whole file or just this one secret:\n\n" +
    "  npx wrangler deploy --secrets-file .env\n" +
    "  npx wrangler secret put A2A_SIGNING_KEY\n\n" +
    "The public half is not configured anywhere — the Worker derives it from\n" +
    "the private key and serves it at the JWKS route.\n"
);
