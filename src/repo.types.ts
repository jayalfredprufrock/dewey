import type { Index } from "./search-index";
import type { DotPath } from "./query";
import type { NarrowByDiscriminator, QueryFor } from "./types";

/**
 * Minimal structural interface used as the constraint for repo helper types
 * (`R extends RepoBase`). The full `SearchRepository` class keeps richer generic
 * params for inference quality and reconstructs this shape as `$self`.
 */
export interface RepoBase {
  readonly $schema: object;
  readonly $discriminator: PropertyKey;
  readonly index: Index;
  transformOutput(hit: never): unknown;
}

export interface RepoConfig<TDoc extends object, TOutput = TDoc> {
  /** Human-readable name used in `DeweyError` messages (defaults to the index name). */
  resourceName?: string;
  /** Enrich/mutate a document immediately before it is written. Replaces dinah's defaults/computed hooks. */
  transformInput?: (doc: TDoc) => TDoc;
  /** Hydrate a raw hit `_source` into a domain object on read. */
  transformOutput?: (doc: TDoc) => TOutput;
  /** Validate documents against the schema before writing (overrides `Search` config). */
  validate?: boolean;
}

/** The read/output type of a repo (the raw doc unless `transformOutput` changes it). */
export type RepoOutput<R extends RepoBase> = ReturnType<R["transformOutput"]>;

/** The stored document type (a union when the schema is a `Type.Union`). */
export type RepoDoc<R extends RepoBase> = R["$schema"];

/** Typed mongo-style query for a repo's schema. */
export type RepoQuery<R extends RepoBase> = QueryFor<R["$schema"]>;

/** A dotted field path into the schema (for aggregations, sort, source filters). */
export type RepoFieldPath<R extends RepoBase> = DotPath<R["$schema"]>;

/** Partial document accepted by `update`/`upsert`. */
export type RepoUpdateData<R extends RepoBase> = Partial<R["$schema"]>;

/**
 * Result of a query, narrowed to a single variant when the query pins the
 * discriminator to a literal; otherwise the full (possibly union) output type.
 */
export type RepoQueryResult<R extends RepoBase, Q> = NarrowByDiscriminator<
  RepoOutput<R>,
  R["$discriminator"],
  Q
>;
