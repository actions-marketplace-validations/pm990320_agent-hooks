import { describe, expect, test } from "bun:test";
import {
  AGENT_HANDLERS,
  getAgentHandler,
  listAgentNames,
} from "../../src/hooks/registry.ts";

describe("registry", () => {
  test("exposes at least one handler per documented agent", () => {
    // 21 agents shipped in v0.1 (claude + 20 from the Vercel skills list).
    expect(AGENT_HANDLERS.length).toBe(21);
  });

  test("handler names are unique", () => {
    const names = AGENT_HANDLERS.map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("getAgentHandler returns the handler for a known name", () => {
    const handler = getAgentHandler("claude");
    expect(handler).not.toBeNull();
    expect(handler?.displayName).toContain("Claude");
  });

  test("getAgentHandler returns null for unknown names", () => {
    expect(getAgentHandler("does-not-exist")).toBeNull();
  });

  test("listAgentNames returns every handler name", () => {
    const names = listAgentNames();
    expect(names).toContain("claude");
    expect(names).toContain("gemini-cli");
    expect(names).toContain("droid");
    expect(names.length).toBe(AGENT_HANDLERS.length);
  });

  test("every handler implements the required surface", () => {
    for (const handler of AGENT_HANDLERS) {
      expect(typeof handler.parseInput).toBe("function");
      expect(typeof handler.detect).toBe("function");
      expect(typeof handler.settingsPath).toBe("function");
      expect(typeof handler.install).toBe("function");
      expect(handler.hookEvents.length).toBeGreaterThan(0);
    }
  });
});
