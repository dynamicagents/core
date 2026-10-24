import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  HITL_RESPONSE_TYPE,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import { createAgentHarness, type AgentHarness } from "../testing/harness.js";
import { makeGatekeeperToken, TEST_TENANT } from "../testing/auth.js";
import {
  GATEKEEPER_ORIGIN,
  SECOND_GATEKEEPER_ORIGIN,
  TEST_SECOND_GATEKEEPER
} from "../testing/fixtures.js";
import worker, { type TestEnv } from "../../test/worker.js";

/**
 * A deployment with two gatekeepers on its allowlist, and what one of them can
 * reach of the other's.
 *
 * Everything here is driven through core's real edge into real Durable Objects,
 * because that is the only place the answer is visible: both tokens verify, both
 * name a tenant this deployment mounts, and the whole question is which object
 * each is served. The second gatekeeper's token is **honest** about itself (its
 * own origin in `iss`, its own `jku`, its own signature) and names the first
 * gatekeeper's caller key, which is a routing name rather than a secret and is
 * enumerable by design.
 *
 * What a caller must not reach of another's: its task list, a task by id, a
 * cancel on one, a message joined onto one, the question it has parked on a
 * person's answer, and the push channel its callbacks go to. Each is asserted
 * negatively below, and each is paired with the same call made by the caller
 * that owns the task, so that a green run means "refused" rather than "broken
 * for everybody". The join's pair is the only one that lives elsewhere, for the
 * reason given where it is asserted.
 */

const testEnv = env as unknown as TestEnv;

/** What the other gatekeeper would install as its own push channel. */
const SECOND_PUSH_TOKEN = "gatekeeper-two-push-token";

/**
 * The deployment under test lists both gatekeepers. Spread rather than
 * configured globally: every other spec runs against one listed origin, which
 * is the ordinary deployment, and this file is about the other one.
 */
const bothListed: TestEnv = {
  ...testEnv,
  GATEKEEPER_ORIGINS: JSON.stringify([
    GATEKEEPER_ORIGIN,
    SECOND_GATEKEEPER_ORIGIN
  ])
};

/**
 * One caller of the first gatekeeper, and the key the second one will claim.
 * A fresh key per spec: the host and its step agents are the caller's, and two
 * specs sharing them would serialize.
 */
function setup(label: string) {
  const key = `${label}:${crypto.randomUUID()}`;
  const harness = createAgentHarness({
    worker,
    env: bothListed,
    identity: { key, name: "Spec Caller", kind: "custom", workspaceId: 1 }
  });
  /** A token the *other* listed gatekeeper signs, for this same caller key. */
  const otherToken = () =>
    makeGatekeeperToken({
      gatekeeper: TEST_SECOND_GATEKEEPER,
      audience: harness.endpoint,
      tenant: TEST_TENANT,
      identity: { key, name: "Spec Caller", kind: "custom", workspaceId: 1 }
    });
  return { key, harness, otherToken };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The question a parked task asked, off the callback that carried it.
 *
 * A question rides a `working` status update, and the `input-required` that
 * follows carries no parts: it says only that the agent is now idle with
 * nothing but open questions left to wait on. So the park is waited for, since
 * that is the state the probes below are about, and the question is then read
 * off the callbacks already captured, the earlier `working` one among them.
 */
async function parkedQuestion(
  harness: AgentHarness,
  taskId: string
): Promise<HitlRequestData> {
  await harness.waitForState(taskId, "TASK_STATE_INPUT_REQUIRED");
  for (const callback of harness.callbacks) {
    if (callback.taskId !== taskId) continue;
    const body = callback.body as {
      task?: { status?: { message?: { parts?: { data?: unknown }[] } } };
    };
    for (const part of body.task?.status?.message?.parts ?? []) {
      const data = part.data as HitlRequestData | undefined;
      if (data?.requestId) return data;
    }
  }
  throw new Error("no callback on this task carried a question");
}

type RpcEnvelope = {
  error?: { code: number; message: string };
  result?: Record<string, unknown>;
};

const envelopeOf = (res: Response): Promise<RpcEnvelope> =>
  res.json<RpcEnvelope>();

const listTasks = (harness: AgentHarness, token?: string) =>
  harness.rpc(
    {
      jsonrpc: "2.0",
      id: 31,
      method: "ListTasks",
      params: { tenant: TEST_TENANT }
    },
    token ? { token } : {}
  );

const getTask = (harness: AgentHarness, taskId: string, token?: string) =>
  harness.rpc(
    {
      jsonrpc: "2.0",
      id: 32,
      method: "GetTask",
      params: { tenant: TEST_TENANT, id: taskId }
    },
    token ? { token } : {}
  );

const cancelTask = (harness: AgentHarness, taskId: string, token?: string) =>
  harness.rpc(
    {
      jsonrpc: "2.0",
      id: 33,
      method: "CancelTask",
      params: { tenant: TEST_TENANT, id: taskId }
    },
    token ? { token } : {}
  );

/**
 * A `SendMessage` from the other gatekeeper, carrying a push channel of its own.
 *
 * The webhook is this harness's, so that a callback the agent was talked into
 * redirecting is captured rather than lost to a 404 nobody reads. The *token* is
 * the other gatekeeper's, which is what tells the two channels apart on a
 * captured callback.
 */
const sendAsOther = (
  harness: AgentHarness,
  token: string,
  message: Record<string, unknown>
) =>
  harness.rpc(
    {
      jsonrpc: "2.0",
      id: 34,
      method: "SendMessage",
      params: {
        tenant: TEST_TENANT,
        message,
        configuration: {
          taskPushNotificationConfig: {
            url: harness.pushUrl,
            token: SECOND_PUSH_TOKEN
          }
        }
      }
    },
    { token }
  );

describe("a second listed gatekeeper claiming another's caller key", () => {
  it("reaches none of that caller's tasks, questions or callbacks", async () => {
    const { harness, otherToken } = setup("cross-read");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:which one?");
    const question = await parkedQuestion(harness, task.id);
    const theirs = await otherToken();

    // Its own request succeeds, which is what makes the rest of this spec about
    // scoping rather than about a token nobody accepts: the other gatekeeper is
    // a legitimate caller of this deployment and this tenant.
    const listed = await listTasks(harness, theirs);
    expect(listed.status).toBe(200);
    const theirList = (await envelopeOf(listed)).result?.tasks as
      unknown[] | undefined;
    expect(theirList ?? []).toEqual([]);

    // …while the caller that owns the task sees it, so an empty list above is a
    // boundary and not a `ListTasks` that answers nothing to anybody.
    const mine = await envelopeOf(await listTasks(harness));
    expect((mine.result?.tasks as { id: string }[]).map((t) => t.id)).toEqual([
      task.id
    ]);

    // A task by id: no guessing is needed for the id here, the spec has it.
    const read = await envelopeOf(await getTask(harness, task.id, theirs));
    expect(read.error).toBeDefined();
    expect(read.result).toBeUndefined();

    // A cancel on it, which would break a durable task mid-flight.
    const canceled = await envelopeOf(
      await cancelTask(harness, task.id, theirs)
    );
    expect(canceled.error).toBeDefined();

    // A plain message joined onto it, which carries no answer and so reaches
    // the run as words rather than as a verdict. The same `resolveAgent` the
    // answer below goes through, so it is refused for the same reason: the
    // scope this token composes holds no such task. The paired positive is the
    // join suite in `src/workflow/workflow.spec.ts`, which drives this path for
    // the caller that owns the task.
    const joined = await envelopeOf(
      await sendAsOther(harness, theirs, {
        messageId: crypto.randomUUID(),
        role: "ROLE_USER",
        taskId: task.id,
        parts: [{ text: "and make it blue" }]
      })
    );
    expect(joined.error).toBeDefined();

    // The parked question, which is a person's answer to give. An answer taken
    // here would be taken as that person's, including an approval's verdict.
    const answered = await envelopeOf(
      await sendAsOther(harness, theirs, {
        messageId: `${SECOND_PUSH_TOKEN}:r:${question.requestId}`,
        role: "ROLE_USER",
        taskId: task.id,
        parts: [
          { text: "Yes" },
          {
            data: {
              type: HITL_RESPONSE_TYPE,
              requestId: question.requestId,
              answers: { q1: { optionIds: ["q1.o1"] } },
              answeredBy: "somebody else"
            },
            mediaType: "application/json"
          }
        ]
      })
    );
    expect(answered.error).toBeDefined();

    // Nothing above settled the task or moved it off its question.
    await pause(300);
    const still = await envelopeOf(await getTask(harness, task.id));
    expect((still.result?.status as { state: string }).state).toBe(
      "TASK_STATE_INPUT_REQUIRED"
    );

    // The person's answer is still theirs to give, and it still lands: a refused
    // reply must not have consumed the question it named.
    await harness.answer(task.id, question.requestId, {
      q1: { optionIds: ["q1.o1"] }
    });
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("Yes");

    // The callback went out on the channel this task was accepted with. The
    // other gatekeeper sent a push config of its own above; had that landed on
    // this task's scope, this is the assertion that would have caught it.
    expect(done.token).not.toBe(SECOND_PUSH_TOKEN);
    expect(harness.callbacks.some((c) => c.token === SECOND_PUSH_TOKEN)).toBe(
      false
    );
  });

  it("runs its own turn for that key in an instance of its own", async () => {
    // The write path. The two callers are distinguishable only by who signed
    // for them, so a shared instance would show up here as one task list
    // holding both turns.
    const { harness, otherToken } = setup("cross-write");
    using _ = harness.interceptGatekeeper();
    const mine = await harness.send("echo:mine");
    await harness.waitForTerminal(mine.id);

    const accepted = await envelopeOf(
      await sendAsOther(harness, await otherToken(), {
        messageId: crypto.randomUUID(),
        role: "ROLE_USER",
        parts: [{ text: "echo:theirs" }]
      })
    );
    const theirTask = accepted.result?.task as { id: string } | undefined;
    expect(accepted.error).toBeUndefined();
    expect(theirTask?.id).toBeDefined();

    // Each list holds one task: its own.
    const mineListed = await envelopeOf(await listTasks(harness));
    expect(
      (mineListed.result?.tasks as { id: string }[]).map((t) => t.id)
    ).toEqual([mine.id]);

    const theirsListed = await envelopeOf(
      await listTasks(harness, await otherToken())
    );
    expect(
      (theirsListed.result?.tasks as { id: string }[]).map((t) => t.id)
    ).toEqual([theirTask?.id]);
  });
});
