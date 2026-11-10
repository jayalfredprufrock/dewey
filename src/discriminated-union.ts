import type { TLiteral, TObject, TSchema, TSchemaOptions, TUnion } from "typebox";
import { IsUnion, Union } from "typebox";

/**
 * What a union may hold: an object, or another union of the same, so variant groups compose
 * (`Type.Union([Electronic, Manual])`). `Static` reads a nested union as one flat union.
 */
export type UnionMember = TObject | TUnion<UnionMember[]>;

/**
 * A union annotated with the property that tells its variants apart, in OpenAPI's
 * `discriminator.propertyName` shape. Structural on purpose: a schema with this shape from any
 * builder (handshake's, dinah's or mobx-toolbox's `DiscriminatedUnion`) is accepted as-is.
 */
export type DiscriminatedUnionSchema<
  D extends string = string,
  V extends TSchema[] = TSchema[],
> = TUnion<V> & { discriminator: { propertyName: D } };

/** Every object variant of a union schema type, with nested unions flattened away. */
export type UnionVariants<T> =
  T extends TUnion<infer V> ? UnionVariants<V[number]> : T extends TObject ? T : never;

/**
 * A variant list with nested unions spliced in place, as a tuple: the type-level counterpart of
 * `variants.flatMap(flattenVariants)`. A tuple (not `UnionVariants<...>[]`) because TypeBox's
 * `Static` only resolves a union's members from a tuple.
 */
export type FlattenVariants<V extends TSchema[]> = [Extract<V[number], TUnion>] extends [never]
  ? V
  : FlattenInto<V, []>;

/** Tail-recursive (accumulator) so long variant lists don't hit TypeScript's depth limit. */
type FlattenInto<V extends TSchema[], Acc extends TSchema[]> = V extends [
  infer F extends TSchema,
  ...infer R extends TSchema[],
]
  ? FlattenInto<R, F extends TUnion<infer N> ? [...Acc, ...FlattenVariants<N>] : [...Acc, F]>
  : Acc;

/** Keys of an object schema whose property schema is a literal. */
type LiteralKeys<S> =
  S extends TObject<infer P>
    ? { [K in keyof P]: P[K] extends TLiteral ? K : never }[keyof P] & string
    : never;

/** Intersection of a union's members' literal keys: keys that are a literal in EVERY variant. */
type CommonLiteralKeys<S> = (S extends any ? (k: LiteralKeys<S>) => void : never) extends (
  k: infer K,
) => void
  ? K & string
  : never;

/**
 * Build a union whose variants are told apart by a literal-valued property: it's a compile error
 * unless `propertyName` is a `Type.Literal` in every (leaf) variant. Variant groups
 * (`Type.Union([...])`) are flattened, so the built schema's `anyOf` is always a flat list of
 * objects, the shape OpenAPI's `oneOf` + `discriminator` expects.
 *
 * ```ts
 * const Media = DiscriminatedUnion("kind", [Photo, Video]);
 * ```
 */
export function DiscriminatedUnion<
  const V extends UnionMember[],
  D extends CommonLiteralKeys<UnionVariants<V[number]>>,
>(
  propertyName: D,
  variants: [...V],
  options?: TSchemaOptions,
): DiscriminatedUnionSchema<D, FlattenVariants<V>> {
  return Union(variants.flatMap(flattenVariants), {
    ...options,
    discriminator: { propertyName },
  }) as unknown as DiscriminatedUnionSchema<D, FlattenVariants<V>>;
}

/** The discriminator a schema is annotated with, or `undefined` for a plain union or an object. */
export function discriminatorOf(schema: unknown): string | undefined {
  if (!IsUnion(schema)) return undefined;
  const name = (schema as { discriminator?: { propertyName?: unknown } }).discriminator
    ?.propertyName;
  return typeof name === "string" ? name : undefined;
}

/** Every object variant of a union schema, with nested unions flattened away. */
export function flattenVariants(schema: TSchema): TObject[] {
  const variants: TObject[] = [];
  const visit = (member: TSchema): void => {
    if (IsUnion(member)) for (const nested of member.anyOf) visit(nested);
    else variants.push(member as TObject);
  };
  visit(schema);
  return variants;
}
