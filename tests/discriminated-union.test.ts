import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { DiscriminatedUnion, IsDiscriminatedUnion, flattenVariants } from "../src";

const Cat = Type.Object({ kind: Type.Literal("cat"), meow: Type.String() });
const Dog = Type.Object({ kind: Type.Literal("dog"), bark: Type.Number() });
const Fish = Type.Object({ kind: Type.Literal("fish"), fins: Type.Integer() });

describe("DiscriminatedUnion", () => {
  it("annotates the union in OpenAPI's shape and still validates as a union", () => {
    const Pet = DiscriminatedUnion("kind", [Cat, Dog]);
    expect(Pet.discriminator).toEqual({ propertyName: "kind" });
    expect(Value.Check(Pet, { kind: "dog", bark: 1 })).toBe(true);
    expect(Value.Check(Pet, { kind: "dog", meow: "x" })).toBe(false);
  });

  it("IsDiscriminatedUnion recognises the annotation, ignores plain unions and objects", () => {
    expect(IsDiscriminatedUnion(DiscriminatedUnion("kind", [Cat, Dog]))).toBe(true);
    expect(IsDiscriminatedUnion(Type.Union([Cat, Dog]))).toBe(false);
    expect(IsDiscriminatedUnion(Cat)).toBe(false);
  });

  it("flattenVariants flattens nested unions", () => {
    const Pet = DiscriminatedUnion("kind", [Type.Union([Cat, Dog]), Fish]);
    expect(flattenVariants(Pet)).toEqual([Cat, Dog, Fish]);
  });

  it("flattens variant groups so anyOf is a flat list of objects", () => {
    const Pet = DiscriminatedUnion("kind", [Type.Union([Cat, Dog]), Fish]);
    expect(Pet.anyOf).toEqual([Cat, Dog, Fish]);
    expect(Value.Check(Pet, { kind: "fish", fins: 2 })).toBe(true);
  });
});
