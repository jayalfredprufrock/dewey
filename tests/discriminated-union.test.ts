import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { DiscriminatedUnion, discriminatorOf, flattenVariants } from "../src";

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

  it("discriminatorOf reads the annotation, ignores plain unions and objects", () => {
    expect(discriminatorOf(DiscriminatedUnion("kind", [Cat, Dog]))).toBe("kind");
    expect(discriminatorOf(Type.Union([Cat, Dog]))).toBeUndefined();
    expect(discriminatorOf(Cat)).toBeUndefined();
  });

  it("flattenVariants flattens nested unions", () => {
    const Pet = DiscriminatedUnion("kind", [Type.Union([Cat, Dog]), Fish]);
    expect(flattenVariants(Pet)).toEqual([Cat, Dog, Fish]);
  });
});
