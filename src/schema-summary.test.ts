import { describe, expect, it } from "vitest";
import { formatSchema } from "./schema-summary.js";

describe("formatSchema", () => {
  it("summarizes nested objects, arrays, enums, and required fields", () => {
    const summary = formatSchema({
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["fast", "safe"],
          description: "Execution mode",
        },
        request: {
          type: "object",
          properties: {
            tags: {
              type: "array",
              items: { type: "string" },
            },
            target: { type: "string" },
          },
          required: ["target"],
        },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
            },
            required: ["id"],
          },
        },
      },
      required: ["request"],
    });

    expect(summary).toContain(
      'mode (enum "fast" | "safe", optional): Execution mode',
    );
    expect(summary).toContain("request (object, required)");
    expect(summary).toContain("target (string, required)");
    expect(summary).toContain("tags (array<string>, optional)");
    expect(summary).toContain("entries (array<object>, optional)");
    expect(summary).toContain("id (integer, required)");
  });

  it("reports an object with no properties as having no parameters", () => {
    expect(
      formatSchema({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
    ).toBe("  (no parameters)");
  });
});
