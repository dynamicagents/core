/**
 * `@dynamicagents/core/mcp` — calling an MCP server from a Worker.
 *
 * A protocol a consumer builds with, the way `/a2a` is. The protocol itself is
 * `@modelcontextprotocol/client`'s; what this subpath adds is the shape a tool
 * needs — a failure as a value, a connection kept per caller instance, and the
 * content-block reader. `./client.ts` says why each of those is here.
 *
 * Nothing from the SDK is re-exported. A caller gets {@link McpAnswer} and
 * {@link McpCall} and never names the SDK itself, which is what lets a plugin
 * build on this without declaring a dependency on it. A caller that needs
 * `tools/list`, elicitation or subscriptions is the reason to open that up, and
 * until one exists the narrow surface is the better one.
 *
 * `client.ts` rather than `mcp.ts`, so a server half can sit beside it.
 */

export {
  mcpClient,
  type McpAnswer,
  type McpCall,
  type McpClientConfig
} from "./client.js";
