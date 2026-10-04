import { describe, it, expect } from "bun:test"; describe("contracts", () => { it("load", async () => { const m = await import("@yrm/core"); expect(typeof m.defineConfig).toBe("function"); }); });
