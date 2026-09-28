/**
 * The names a step job and its events go by. Both sides derive them, the
 * workflow to wait and the step agent to report, so they live in one place.
 *
 * An event type and an instance id must match `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`
 * and fit in 100 characters, so anything built from a step's name or a request
 * id is hashed. A step job id is never an event type and keeps its readable
 * form.
 */

/** SHA-256, base64url, cut to the length Think's own workflow keys use. */
export async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
    .slice(0, 22);
}

/**
 * The same instance, step and key always name the same job, so a re-run start
 * step finds it rather than starting another.
 */
export async function stepJobIdFor(
  instanceId: string,
  name: string,
  key?: string
): Promise<string> {
  return key === undefined
    ? `${instanceId}:${name}`
    : `${instanceId}:${name}:${await digest(key)}`;
}

/**
 * The event of a job's `n`th report. One type per report, because Workflows
 * buffers an event sent before its wait begins, and two reports under one type
 * would be taken by whichever wait came first.
 */
export async function reportEventType(
  stepJobId: string,
  n: number
): Promise<string> {
  return `sj-${await digest(stepJobId)}-${n}`;
}

/** The event carrying a person's answer to one question. */
export async function answerEventType(requestId: string): Promise<string> {
  return `ans-${await digest(requestId)}`;
}
