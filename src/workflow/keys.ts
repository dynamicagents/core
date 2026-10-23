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
 * The one event type a job's events travel under: its agent's reports and the
 * host's inputs alike. Workflows keeps every event sent under a type and hands
 * them to successive waits in the order they arrived, and only that: two sends
 * in flight at once arrive in either order. So each writer numbers its own
 * events, and the reader puts them back in order (see `JobEvent`).
 */
export async function jobEventType(stepJobId: string): Promise<string> {
  return `job-${await digest(stepJobId)}`;
}
