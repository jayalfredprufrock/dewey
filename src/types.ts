import type { Static, TSchema } from "typebox";
import type { TypedQuery } from "./query";

export type Obj<T = any> = Record<string, T>;

/**
 * Force TypeScript to eagerly evaluate a computed type into a plain object for
 * display. Distributes over unions so discriminated results stay a readable
 * union, and is a structural identity so it never changes assignability.
 */
export type Simplify<T> = T extends any ? { [K in keyof T]: T[K] } : never;

/** Union of all string keys across every member of a (possibly union) type. */
export type AllKeys<T> = Extract<T extends any ? keyof T : never, string>;

/** `Static<Schema>`, falling back to `any` when the schema erases to `unknown`. */
export type SchemaStatic<S extends TSchema> = unknown extends Static<S> ? any : Static<S>;

// ── Index extraction ─────────────────────────────────────────────────────────

// (Index is generic; these avoid a circular import by structurally matching it.)
export type ExtractIndexSchema<I> = I extends { schema: infer S extends TSchema }
  ? SchemaStatic<S>
  : never;

export type ExtractIndexDef<I> = I extends { def: infer D } ? D : never;

/**
 * The discriminator an index's schema is annotated with (`discriminator.propertyName`, as built by
 * `DiscriminatedUnion`), or `never` for a plain union or object schema.
 */
export type IndexDiscriminator<I> = I extends {
  schema: { discriminator: { propertyName: infer D extends string } };
}
  ? D
  : never;

/** The index's nested-mapped field paths (`mapping.policy.nested`), or `never` when none are set. */
export type IndexNested<I> =
  ExtractIndexDef<I> extends {
    mapping?: { policy?: { nested?: infer N extends readonly string[] } };
  }
    ? N[number]
    : never;

// ── Typed query surface (powered by the vendored mongoes engine) ──────────────

/**
 * Typed mongo-style query over a document type. Union-aware via `Flatten` distribution.
 * `Nested` restricts `$elemMatch` to nested-mapped paths (any object path by default).
 */
export type QueryFor<TDoc, Nested extends string = string> = TypedQuery<TDoc, Nested>;

/** Typed mongo-style query over a typebox schema. */
export type Query<S extends TSchema> = QueryFor<SchemaStatic<S>>;

// ── Discriminated-union narrowing (ported from dinah) ─────────────────────────

type DiscriminatorLiteral = string | number | boolean;

// literal(s) from a shorthand `$eq`, `{ $eq: literal }` or `{ $in: [literals] }` condition
type DiscriminatorOperand<C> = C extends DiscriminatorLiteral
  ? C
  : C extends { $eq: infer L extends DiscriminatorLiteral }
    ? L
    : C extends { $in: readonly (infer L extends DiscriminatorLiteral)[] }
      ? L
      : never;

/**
 * Pull the literal discriminator value(s) out of a query object, if present as a shorthand
 * `$eq`, `{ $eq: literal }` or `{ $in: [literals] }`.
 */
export type ExtractDiscriminatorValue<Q, D extends keyof any> = D extends keyof Q
  ? DiscriminatorOperand<Q[D]>
  : never;

/**
 * Narrow a (possibly union) type `T` to the variant selected by a discriminator
 * literal carried in query `Q`. No discriminator, or no literal in the query,
 * leaves `T` untouched.
 */
export type NarrowByDiscriminator<T, D extends keyof any, Q> = [D] extends [never]
  ? T
  : [ExtractDiscriminatorValue<Q, D>] extends [never]
    ? T
    : Extract<T, { [K in D & keyof T]: ExtractDiscriminatorValue<Q, D> }>;
