import type { Static, TSchema } from "typebox";
import type { MappingConfig } from "./mappings";
import type { AllKeys, SchemaStatic } from "./types";

/** How a document's `_id` is derived. Omit to let ES/OS auto-generate ids. */
export type IdStrategy<T> =
  | (AllKeys<T> & keyof T)
  | readonly (AllKeys<T> & keyof T)[]
  | ((doc: T) => string);

/**
 * Source of an external version number for optimistic concurrency on
 * `index`/bulk-index writes. Point it at a monotonically increasing field
 * (e.g. a DynamoDB version or `updatedAt`) to make syncs order-independent.
 */
export type VersionStrategy<T> = (AllKeys<T> & keyof T) | ((doc: T) => number);

export interface IndexDef<T = any> {
  /** Index name or alias used for reads and writes. */
  readonly name: string;
  /** How to derive a document `_id`. */
  readonly id?: IdStrategy<T>;
  /** External-version source for optimistic concurrency. */
  readonly version?: VersionStrategy<T>;
  /** Discriminator field for union schemas — enables result narrowing and mapping-merge checks. */
  readonly discriminator?: AllKeys<T>;
  /** Mapping derivation policy, explicit overrides, and index settings. */
  readonly mapping?: MappingConfig<T>;
}

type IndexDefStatic<Schema extends TSchema> = IndexDef<SchemaStatic<Schema>>;

/**
 * Captures the typebox schema plus index configuration (name/alias, id & version
 * strategies, discriminator, mappings). Analogous to dinah's `Table`.
 */
export class Index<
  Schema extends TSchema = TSchema,
  const Def extends IndexDefStatic<Schema> = IndexDefStatic<Schema>,
> {
  readonly schema: Schema;
  readonly def: Def;

  constructor(schema: Schema, def: Def) {
    this.schema = schema;
    this.def = def;
  }

  /** The document type this index stores (a union when the schema is a `Type.Union`). */
  declare readonly $doc: unknown extends Static<Schema> ? any : Static<Schema>;
}
