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
 * Build a union whose variants are told apart by a literal-valued property (handshake's rule):
 * it's a compile error unless `propertyName` is a `Type.Literal` in every (leaf) variant.
 *
 * ```ts
 * const Media = DiscriminatedUnion("kind", [Photo, Video]);
 * ```
 */
export function DiscriminatedUnion<
  const V extends UnionMember[],
  D extends CommonLiteralKeys<UnionVariants<V[number]>>,
>(propertyName: D, variants: [...V], options?: TSchemaOptions): DiscriminatedUnionSchema<D, V> {
  return Union(variants, {
    ...options,
    discriminator: { propertyName },
  }) as unknown as DiscriminatedUnionSchema<D, V>;
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
