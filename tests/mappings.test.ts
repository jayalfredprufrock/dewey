import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { deriveMappings } from "../src/mappings";
import { isDeweyError } from "../src/error";

describe("deriveMappings", () => {
  it("derives scalar types per default policy", () => {
    const schema = Type.Object({
      id: Type.String(),
      count: Type.Integer(),
      score: Type.Number(),
      active: Type.Boolean(),
    });
    const { dynamic, properties } = deriveMappings(schema);
    expect(dynamic).toBe(false);
    expect(properties).toEqual({
      id: { type: "keyword" },
      count: { type: "long" },
      score: { type: "double" },
      active: { type: "boolean" },
    });
  });

  it("maps date-time strings to date", () => {
    const schema = Type.Object({ createdAt: Type.String({ format: "date-time" }) });
    expect(deriveMappings(schema).properties.createdAt).toEqual({ type: "date" });
  });

  it("honors a text policy with keyword subfield", () => {
    const schema = Type.Object({ bio: Type.String() });
    const { properties } = deriveMappings(schema, { policy: { string: "text" } });
    expect(properties.bio).toEqual({
      type: "text",
      fields: { keyword: { type: "keyword", ignore_above: 256 } },
    });
  });

  it("maps nested objects, honoring the nested policy", () => {
    const schema = Type.Object({
      meta: Type.Object({ a: Type.String() }),
      items: Type.Array(Type.Object({ b: Type.Integer() })),
    });
    const { properties } = deriveMappings(schema, { policy: { nested: ["items"] } });
    expect(properties.meta).toEqual({ type: "object", properties: { a: { type: "keyword" } } });
    expect(properties.items).toEqual({ type: "nested", properties: { b: { type: "long" } } });
  });

  it("lets explicit properties override derived ones", () => {
    const schema = Type.Object({ bio: Type.String() });
    const { properties } = deriveMappings(schema, { properties: { bio: { type: "text" } } });
    expect(properties.bio).toEqual({ type: "text" });
  });

  it("merges union variants into one superset mapping", () => {
    const schema = Type.Union([
      Type.Object({ id: Type.String(), kind: Type.Literal("photo"), width: Type.Integer() }),
      Type.Object({ id: Type.String(), kind: Type.Literal("video"), durationSec: Type.Integer() }),
    ]);
    const { properties } = deriveMappings(schema);
    expect(Object.keys(properties).sort()).toEqual(["durationSec", "id", "kind", "width"]);
    expect(properties.width).toEqual({ type: "long" });
    expect(properties.durationSec).toEqual({ type: "long" });
  });

  it("throws on conflicting union field types", () => {
    const schema = Type.Union([
      Type.Object({ shared: Type.Integer() }),
      Type.Object({ shared: Type.Boolean() }),
    ]);
    try {
      deriveMappings(schema);
      throw new Error("expected a DeweyError");
    } catch (err) {
      expect(isDeweyError(err)).toBe(true);
      if (isDeweyError(err)) expect(err.details.type).toBe("DATA_INTEGRITY");
    }
  });
});
