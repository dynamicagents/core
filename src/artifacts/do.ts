import { DurableObject } from "cloudflare:workers";
import {
  ARTIFACT_EVENTS,
  resumeFrom,
  sseFrame,
  type ReadyEvent,
  type SettledEvent
} from "./events.js";
import { parseArtifactPath } from "./path.js";
import {
  makeArtifactStore,
  type ArtifactEntryInput,
  type ArtifactStore
} from "./store.js";

/**
 * `Artifacts` — the Durable Object that stores what a run had to say, and
 * streams it to whoever holds the link.
 *
 * ## What it knows, and what it does not
 *
 * An artifact is a **kind** (a string), a **token**, an append-only list of
 * labelled notes, and — once something tells it — a **settle status**. That is
 * the whole model. This object never learns what a kind means, when a run is
 * finished, or what a status is called: the machinery that owns the work
 * decides all three and says so. `session-transcript` is the first kind and it
 * gets no code of its own here, which is the test of whether the abstraction
 * holds.
 *
 * ## Two doors, and only one of them is open
 *
 * **Ingest is RPC**, reached through the binding — {@link createArtifact},
 * {@link addEntry}, {@link settle}. There is no HTTP route that writes, so a
 * write is authenticated by being inside the Worker at all, and the token it
 * carries is an argument rather than a credential.
 *
 * **Reads are the token**, over {@link fetch}. The token is unguessable and
 * derived from nothing (see {@link file://./store.ts mintArtifactToken}), so it
 * is id and authorization in one, and a link is the whole of what a reader
 * needs. Nothing else here checks anything: hand out the link or do not.
 *
 * ## One object, addressed by a well-known name
 *
 * Every artifact of a deployment lives in one instance — see
 * {@link file://./binding.ts ARTIFACTS_OBJECT_NAME} for why a token cannot
 * select an object of its own, and what that costs.
 *
 * ## No alarms
 *
 * Retention is swept lazily on every write, past
 * {@link file://./store.ts ARTIFACT_RETENTION_MS}. An alarm per artifact would
 * be one durable timer per task for a deletion that nothing is waiting on, and
 * a Durable Object has one alarm to spend — see
 * {@link file://../alarm/index.ts installScheduler} for what that costs an
 * object that needs to wake for a second reason.
 */
/**
 * What {@link Artifacts.addEntry} answers: where the note landed, and whether
 * this artifact's link has already been delivered.
 *
 * `announced` is what a writer branches on to choose between sending the link
 * and staying silent. It is recorded rather than inferred from `sequence === 1`
 * because the send can fail: a note that opened the artifact is not a link
 * anybody received. See {@link Artifacts.announce}.
 */
export interface RecordedNote {
  sequence: number;
  announced: boolean;
}

export class Artifacts extends DurableObject {
  /**
   * Test-only clock injection (a field, so never on the RPC stub). Retention is the one
   * behaviour here that cannot be reached in a test any other way: a month is
   * not a thing a spec can wait for, and backdating a row would assert against
   * SQL rather than against the sweep.
   */
  clockOverride?: () => number;

  private _store?: ArtifactStore;

  /**
   * The streams open on each token, in memory.
   *
   * In memory is the only place they can be: a watcher *is* an open response
   * body on this isolate, so an instance that lost the map lost the connections
   * with it, and every reader's `EventSource` reconnects carrying
   * `Last-Event-ID`. Nothing durable would be describing anything real.
   */
  private readonly watchers = new Map<string, Set<Watcher>>();

  private get store(): ArtifactStore {
    return (this._store ??= makeArtifactStore(this.ctx.storage.sql, () =>
      this.now()
    ));
  }

  private now(): number {
    return this.clockOverride?.() ?? Date.now();
  }

  // --- ingest, over the binding --------------------------------------------

  /**
   * Open an artifact and return its token.
   *
   * `sourceKey` makes the call **idempotent**: the same kind and key return the
   * token already minted for them. That is what lets a caller with no memory of
   * its own — a replay, a fresh isolate, a retry — find the artifact it
   * opened earlier instead of starting a second one. Without a key every call
   * opens a new artifact.
   */
  async createArtifact(kind: string, sourceKey?: string): Promise<string> {
    return this.store.open(kind, sourceKey);
  }

  /** The token a `kind`/`sourceKey` pair already has, or `null`. Opens nothing. */
  async tokenFor(kind: string, sourceKey: string): Promise<string | null> {
    return this.store.tokenFor(kind, sourceKey);
  }

  /**
   * Append one note and wake everyone watching — or `null` when the token names
   * nothing, which is what a caller sees when retention swept the artifact out
   * from under it.
   *
   * The token is required for the reason a read needs one, not because ingest
   * is guarded: it names the artifact, and a writer that cannot name it has no
   * business appending to it.
   */
  async addEntry(
    token: string,
    entry: ArtifactEntryInput
  ): Promise<RecordedNote | null> {
    const recorded = this.store.append(token, entry);
    if (recorded === null) return null;
    // Only a note that was actually written is sent on. A replay the entry key
    // caught has already reached everyone watching, under this same event id,
    // and sending it again would render it twice.
    if (recorded.appended) {
      this.broadcast(
        token,
        sseFrame(ARTIFACT_EVENTS.entry, recorded.entry, recorded.entry.sequence)
      );
    }
    return {
      sequence: recorded.entry.sequence,
      announced: recorded.announced
    };
  }

  /**
   * Record that this artifact's link has reached whoever it was for, so a later
   * writer knows to stay silent instead of sending it again.
   *
   * Returns whether it applied — `false` for an unknown token and for one
   * already announced, the distinction {@link settle} draws. Nothing is
   * broadcast: a reader on the stream is by definition somebody the link already
   * reached. See {@link file://./store.ts ArtifactStore.announce} for why the
   * bit is durable at all.
   */
  async announce(token: string): Promise<boolean> {
    return this.store.announce(token);
  }

  /**
   * Record the status this artifact finished in, and end every stream on it.
   *
   * Returns whether it applied — `false` for an unknown token and for one
   * already settled, so a replayed settle is distinguishable from the first.
   * What "settled" *means* is entirely the caller's: this object has no idea
   * what work the artifact was describing or when it stopped.
   */
  async settle(token: string, status: string): Promise<boolean> {
    if (!this.store.settle(token, status)) return false;
    const event: SettledEvent = { status };
    this.broadcast(token, sseFrame(ARTIFACT_EVENTS.settled, event), "close");
    return true;
  }

  // --- reads, over the token ------------------------------------------------

  /**
   * The event stream for one token.
   *
   * Only `/a/<token>/events` is served here. The page itself never reaches this
   * object — see {@link file://./route.ts handleArtifactRoute}.
   */
  override async fetch(request: Request): Promise<Response> {
    const matched = parseArtifactPath(new URL(request.url).pathname);
    if (matched?.route !== "events") {
      return new Response("not found", { status: 404 });
    }
    return this.openStream(matched.token, request.headers.get("last-event-id"));
  }

  /**
   * Serve one reader: the artifact, everything it has recorded since
   * `Last-Event-ID`, and then either the end or a seat.
   *
   * **Nothing here awaits**, and that is the ordering guarantee. A Durable
   * Object's input gate holds only up to the first await, so a `settle` landing
   * between the snapshot read and the registration would end a stream that had
   * not been registered yet — and the reader would wait forever on a run that
   * finished. Registering first and enqueuing the opening frames onto the same
   * serialized chain every later frame uses means a concurrent write can only
   * queue *behind* the replay, never inside it.
   */
  private openStream(token: string, lastEventId: string | null): Response {
    const artifact = this.store.get(token);
    if (artifact === null) {
      return new Response("no such artifact", {
        status: 404,
        headers: { "cache-control": "no-store" }
      });
    }

    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const watcher = makeWatcher(writable.getWriter(), () =>
      this.drop(token, watcher)
    );
    this.seat(token, watcher);

    const ready: ReadyEvent = { kind: artifact.kind, status: artifact.status };
    const opening = [sseFrame(ARTIFACT_EVENTS.ready, ready)];
    for (const entry of this.store.entries(token, resumeFrom(lastEventId))) {
      opening.push(sseFrame(ARTIFACT_EVENTS.entry, entry, entry.sequence));
    }
    if (artifact.status !== null) {
      const settled: SettledEvent = { status: artifact.status };
      opening.push(sseFrame(ARTIFACT_EVENTS.settled, settled));
    }
    watcher.replay(opening);
    if (artifact.status !== null) watcher.end();

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        // Nothing between here and the reader may buffer a stream whose whole
        // point is that a line arrives when it is written.
        "x-accel-buffering": "no"
      }
    });
  }

  // --- the seating plan -----------------------------------------------------

  private seat(token: string, watcher: Watcher): void {
    const seated = this.watchers.get(token);
    if (seated) seated.add(watcher);
    else this.watchers.set(token, new Set([watcher]));
  }

  private drop(token: string, watcher: Watcher): void {
    const seated = this.watchers.get(token);
    if (!seated) return;
    seated.delete(watcher);
    if (seated.size === 0) this.watchers.delete(token);
  }

  /**
   * Push one frame to everyone watching a token, and optionally end them.
   *
   * A write that fails has lost its reader, which is an ordinary end to a
   * stream and never something a write should hear about: the watcher tears
   * itself down and this loop is none the wiser. See {@link makeWatcher}.
   */
  private broadcast(token: string, frame: string, then?: "close"): void {
    for (const watcher of this.watchers.get(token) ?? []) {
      watcher.send(frame);
      if (then === "close") watcher.end();
    }
  }
}

/** One open stream, from the writing side. */
interface Watcher {
  /**
   * Queue everything this reader connected for, written one frame at a time as
   * it takes them.
   *
   * Exempt from the bound {@link send} enforces, and takes the whole opening
   * burst as one array to stay that way: nothing has been sent when this is
   * called — the `Response` has not been returned yet — so a reader cannot have
   * fallen behind, and the bound would fire on a log longer than itself and drop
   * every reader of it, on every reconnect, for good. What replaces the bound
   * here is that the burst is finite and already in storage: one snapshot of a
   * log retention ages out, released the moment the reader is dropped or done.
   */
  replay(frames: string[]): void;
  /** Queue one live frame. Returns immediately; failures unseat the watcher. */
  send(frame: string): void;
  /** Queue the close. Every frame already queued still goes out first. */
  end(): void;
}

/**
 * How much unsent *live* stream one reader may hold before it is dropped.
 *
 * Backpressure is what makes the bound necessary: a frame is handed to the
 * writer only once the reader has taken the one before it, so a reader that
 * stopped consuming — a slept laptop, a `curl` left open and unread — leaves
 * every later frame queued in this isolate, each closure retaining its payload.
 * Unbounded, one such reader costs the object the whole rest of a run it is not
 * reading, and the object is every artifact of the deployment.
 *
 * Bounded on both frames and bytes, because a note is usually short and need not
 * be. **Dropping costs the reader nothing**: its body errors, `EventSource`
 * reconnects on its own, and the replay from `Last-Event-ID` returns exactly
 * what the drop discarded — see {@link file://./events.ts resumeFrom}.
 */
export const MAX_QUEUED_FRAMES = 64;
export const MAX_QUEUED_BYTES = 256 * 1024;

/**
 * Wrap a writer so the object can write to it without ever awaiting it.
 *
 * Two things make that necessary. A `TransformStream` applies backpressure, so
 * `write` does not resolve until the reader has taken the chunk — awaiting one
 * inside an RPC would hold the ingest path open for as long as a slow reader
 * takes, and awaiting one before returning the `Response` would deadlock, since
 * nobody is reading yet. And frames have to keep their order, which a chain
 * gives and parallel writes do not.
 *
 * What that costs is a queue nobody is draining, which is why it is bounded —
 * see {@link MAX_QUEUED_FRAMES}.
 */
function makeWatcher(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  unseat: () => void
): Watcher {
  const encoder = new TextEncoder();
  let queue: Promise<unknown> = Promise.resolve();
  let live = true;
  let queuedFrames = 0;
  let queuedBytes = 0;

  const teardown = (): void => {
    if (!live) return;
    live = false;
    unseat();
  };
  // A reader that navigates away cancels the response body, which errors this
  // writer; `closed` is how that becomes a seat freed rather than a leak.
  void writer.closed.then(teardown, teardown);

  // `abort`, never `close`: closing waits for what is already queued, which is
  // precisely what this reader will not take. Aborting discards it and errors
  // the body the reader holds, which is the event its `EventSource` reconnects
  // on — so the reason is written for whoever reads it in a log.
  const overflow = (): void => {
    // The queue's size and nothing identifying the reader: a token is the
    // artifact's bearer credential, and a log sink is not a place to keep one.
    console.warn("[artifacts] watcher dropped, unread frames past the bound", {
      queuedFrames,
      queuedBytes
    });
    teardown();
    void writer
      .abort(new Error("artifact stream dropped: reader fell behind"))
      .catch(() => {});
  };

  return {
    replay(frames) {
      if (!live) return;
      queue = queue
        .then(async () => {
          for (const frame of frames) await writer.write(encoder.encode(frame));
        })
        .catch(teardown);
    },

    send(frame) {
      if (!live) return;
      const chunk = encoder.encode(frame);
      // An empty queue accepts whatever it is handed. The bound is there to
      // catch a reader that has stopped taking frames, and a single note past
      // the byte cap is not that — dropping on it would drop every reader of
      // that note, on every reconnect, for good.
      if (
        queuedFrames > 0 &&
        (queuedFrames >= MAX_QUEUED_FRAMES ||
          queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES)
      ) {
        overflow();
        return;
      }
      queuedFrames += 1;
      queuedBytes += chunk.byteLength;
      queue = queue
        .then(() => writer.write(chunk))
        .then(() => {
          queuedFrames -= 1;
          queuedBytes -= chunk.byteLength;
        })
        .catch(teardown);
    },
    end() {
      if (!live) return;
      queue = queue.then(() => writer.close()).catch(() => {});
      teardown();
    }
  };
}
