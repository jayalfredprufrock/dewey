import type { Static, TSchema } from "typebox";
import type { Flatten, MongoesQuery } from "./query";

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

/** The declared discriminator field of an index, or `never` when none is set. */
export type IndexDiscriminator<I> = Extract<
  ExtractIndexDef<I> extends { discriminator?: infer D } ? D : never,
  PropertyKey
>;

// ── Typed query surface (powered by the vendored mongoes engine) ──────────────

/** Typed mongo-style query over a document type. Union-aware via `Flatten` distribution. */
export type QueryFor<TDoc> = MongoesQuery<Flatten<TDoc>>;

/** Typed mongo-style query over a typebox schema. */
export type Query<S extends TSchema> = QueryFor<SchemaStatic<S>>;

// ── Discriminated-union narrowing (ported from dinah) ─────────────────────────

/** Pull a literal discriminator value out of a query object, if present as a shorthand `$eq`. */
export type ExtractDiscriminatorValue<Q, D extends keyof any> = D extends keyof Q
  ? Q[D] extends string | number | boolean
    ? Q[D]
    : never
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
