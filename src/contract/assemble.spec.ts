import { describe, it, expect, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import type { Action } from "@cloudflare/think";
import { PluginSetupError, assemblePlugins } from "./assemble.js";
import {
  PLUGIN_CONTRACT_VERSION,
  definePlugin,
  restrictTools,
  type PluginContext
} from "./plugin.js";

const noop = tool({
  description: "does nothing",
  inputSchema: z.object({}),
  execute: async () => "ok"
});

const ctx = {} as PluginContext<Record<string, unknown>>;

describe("assembling an agent's plugins", () => {
  it("refuses two plugins under one name", () => {
    expect(() =>
      assemblePlugins(
        [definePlugin({ name: "a" }), definePlugin({ name: "a" })],
        {}
      )
    ).toThrow(PluginSetupError);
  });

  it("names the plugin and both versions on a contract skew", () => {
    expect(() =>
      assemblePlugins([{ name: "old", contractVersion: 2 }], {})
    ).toThrow(
      new RegExp(
        `"old" was built against plugin contract v2.*speaks v${PLUGIN_CONTRACT_VERSION}`
      )
    );
  });

  it("names every missing binding and who needs it", () => {
    expect(() =>
      assemblePlugins(
        [
          definePlugin({
            name: "b",
            requires: { bindings: ["BROWSER"], secrets: ["TOKEN"] }
          })
        ],
        { TOKEN: "" }
      )
    ).toThrow(/TOKEN \(required by "b"\), BROWSER \(required by "b"\)/);
  });

  it("refuses two plugins offering one tool, at the start check", () => {
    const plugins = assemblePlugins(
      [
        definePlugin({ name: "a", tools: () => ({ read: noop }) }),
        definePlugin({ name: "b", tools: () => ({ read: noop }) })
      ],
      {}
    );
    expect(() => plugins.check(ctx)).toThrow(
      /"a" and "b" both offer the tool "read"/
    );
  });

  it("refuses two plugins offering one action, at the start check", () => {
    const plugins = assemblePlugins(
      [
        definePlugin({ name: "a", actions: () => ({ post: {} as Action }) }),
        definePlugin({ name: "b", actions: () => ({ post: {} as Action }) })
      ],
      {}
    );
    expect(() => plugins.check(ctx)).toThrow(
      /"a" and "b" both offer the action "post"/
    );
  });

  it("namespaces each block under its plugin's name", () => {
    const plugins = assemblePlugins(
      [
        definePlugin({
          name: "repo",
          context: [
            { provider: { get: async () => "about repos" } },
            { label: "rules", provider: { get: async () => "rules" } }
          ]
        })
      ],
      {}
    );
    expect(plugins.context().map((b) => b.label)).toEqual([
      "repo",
      "repo.rules"
    ]);
  });
});

describe("restricting a plugin's tools", () => {
  it("keeps the named tools and actions, and still requires the binding", () => {
    const restricted = restrictTools(
      definePlugin({
        name: "sb",
        tools: () => ({ read: noop, write: noop }),
        requires: { bindings: ["SANDBOX"] }
      }),
      { allow: ["read"] }
    );
    expect(Object.keys(restricted.tools!(ctx))).toEqual(["read"]);
    expect(restricted.requires).toEqual({ bindings: ["SANDBOX"] });
  });

  it("reports a name the plugin does not offer", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    restrictTools(definePlugin({ name: "sb", tools: () => ({ read: noop }) }), {
      allow: ["raed"]
    }).tools!(ctx);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"raed"'));
    error.mockRestore();
  });

  it("says what the model is told instead, or nothing", () => {
    const plugin = definePlugin({
      name: "sb",
      context: [{ provider: { get: async () => "all of it" } }]
    });
    expect(restrictTools(plugin, { allow: [] }).context).toBeUndefined();
    const narrowed = restrictTools(plugin, {
      allow: [],
      context: [{ provider: { get: async () => "read only" } }]
    });
    expect(narrowed.context).toHaveLength(1);
  });
});
