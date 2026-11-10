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
    expect(properties.items).toEqual({
      type: "nested",
      include_in_parent: true,
      properties: { b: { type: "long" } },
    });
  });

  it("sets include_in_parent on every nested level unless disabled", () => {
    const schema = Type.Object({
      blocks: Type.Array(
        Type.Object({
          blockId: Type.String(),
          response: Type.Array(Type.Object({ c: Type.String() })),
        }),
      ),
    });
    const nested = ["blocks", "blocks.response"];

    const enabled = deriveMappings(schema, { policy: { nested } }).properties;
    expect(enabled.blocks).toMatchObject({ type: "nested", include_in_parent: true });
    expect(enabled.blocks!.properties.response).toMatchObject({
      type: "nested",
      include_in_parent: true,
    });

    const disabled = deriveMappings(schema, {
      policy: { nested, includeInParent: false },
    }).properties;
    expect(disabled.blocks).not.toHaveProperty("include_in_parent");
    expect(disabled.blocks!.properties.response).not.toHaveProperty("include_in_parent");
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

  it("flattens nested unions before merging", () => {
    const schema = Type.Union([
      Type.Union([
        Type.Object({ kind: Type.Literal("photo"), width: Type.Integer() }),
        Type.Object({ kind: Type.Literal("video"), durationSec: Type.Integer() }),
      ]),
      Type.Object({ kind: Type.Literal("doc"), pages: Type.Integer() }),
    ]);
    const { properties } = deriveMappings(schema);
    expect(Object.keys(properties).sort()).toEqual(["durationSec", "kind", "pages", "width"]);
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
