/**
 * This deployment's own public origin — learned from the request path, never
 * configured.
 *
 * ## Why an agent needs it at all
 *
 * A Worker that only *answers* never needs to know its own name.
 * {@link file://../worker/index.ts createA2AWorker} derives its audience, its
 * card and its `jku` from `new URL(request.url).origin`, and none of it outlives
 * the request. An agent that **calls out** mint-signed does need it:
 * {@link file://./caller-token.ts signCallerToken} puts it in `iss` and derives
 * the token's `jku` from it. That call happens inside a Durable Object, where
 * there is no `Request` — which is the whole difficulty.
 *
 * The obvious answer is a `SELF_ORIGIN` secret, and it is the wrong one. It
 * restates a value the request already carries, and it has to be kept
 * byte-identical by hand with the origin allowlist on the far side, in every
 * environment, forever. `slack-gatekeeper` discovers its own origin from the
 * first signature-verified request rather than being told, for the same reason.
 *
 * ## Where the value comes from
 *
 * Core already sends the origin into the Durable Object on every turn, one field
 * short of this use. `A2AExecutor` computes `jku` as `${origin}${jwksPath}` and
 * it rides {@link file://./push.ts TurnPushContext} into the agent on every
 * accepted turn.
 *
 * That is the same origin `signCallerToken` needs, and not by coincidence: a
 * caller token's `jku` **must** be the JWKS the verifier fetches, and `iss` must
 * agree with it — the third check in {@link file://./verify.ts verify.ts}. An
 * origin derived from anywhere else is exactly what that check exists to catch,
 * so deriving it from the `jku` core already serves makes the agreement
 * structural instead of clerical.
 *
 * ## Pinned on the first turn, and in memory
 *
 * The first origin an isolate is told wins, and later ones are ignored. That is
 * not laziness about staleness — it is what makes the value safe to *read*.
 *
 * A Durable Object's input gate stays open across a non-storage await, and
 * one object serves RPCs, queue items and its own turn concurrently. Mutable
 * instance state can therefore change while a turn is awaiting a model call, and the credential
 * thunks that read this are lazy — they run several frames below the turn, when
 * the client is built. Pinned, the field is immutable after its first write, so
 * every concurrent reader in the isolate gets the same string and no turn can
 * sign as another turn's origin.
 *
 * The cost of pinning is what an agent does not have: several identities. An
 * agent has one endpoint — the one its card advertises, the one a gatekeeper calls
 * and a verifier allowlists — so there is nothing to follow. Note the asymmetry
 * with a *verifier*, which derives the audience it expects per request and must
 * not cache it: a verifier has to accept every hostname it answers on, while a
 * signer needs one stable identity.
 *
 * Nothing is persisted, which is what keeps a pin from outliving its truth. An
 * isolate is fresh on every `wrangler deploy` and recycles on its own, so a moved
 * deployment re-learns its origin from the next turn it serves.
 */
export class SelfOrigin {
  private observed?: string;

  /**
   * Offer the origin of an absolute URL seen on the request path — a `jku`, an
   * endpoint, or a bare origin. Only `.origin` is kept, so a path or a trailing
   * slash cannot reach a token claim.
   *
   * **The first usable value wins**; every later call is a no-op, including one
   * naming a different origin. Called at each RPC entry and again when the push
   * channel is built, so most calls are already no-ops — but the reason for the
   * pin is the read side, not the write side. See the note above the class.
   *
   * Silently ignores anything unusable (absent, relative, or a scheme that has
   * no meaningful origin), and an unusable value never pins: the parse comes
   * first and the field is assigned only on success. This runs at the top of a
   * turn, where a diagnostic value must never be the thing that fails it; the
   * throw belongs at {@link require}, where something actually wanted the value.
   */
  note(url: string | undefined): void {
    if (this.observed || !url) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    this.observed = parsed.origin;
  }

  /** The pinned origin, or `undefined` when nothing has carried one yet. */
  peek(): string | undefined {
    return this.observed;
  }

  /**
   * The pinned origin, for a caller that cannot proceed without it.
   *
   * Throws naming the timing, because that is what the mistake always is: the
   * value arrives with a turn, so `onStart`, a constructor and a scheduled
   * callback all run before any request has said what this deployment is called.
   */
  require(): string {
    if (!this.observed) {
      throw new Error(
        "this deployment's own origin is not known on this instance yet: it is " +
          "learned from the `jku` that arrives with every turn, so it is " +
          "available once a turn has been accepted — not from onStart, a " +
          "constructor or a scheduled callback"
      );
    }
    return this.observed;
  }
}
