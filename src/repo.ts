import { Check, Errors } from "typebox/value";
import { buildQuery, buildSearchBody, resolveId, resolveVersion } from "./build";
import { DeweyError } from "./error";
import { deriveMappings } from "./mappings";
import type { DerivedMappings } from "./mappings";
import type { StrictQuery } from "./query";
import type { Search } from "./search";
import type { Index } from "./search-index";
import type {
  BulkResult,
  BulkResultItem,
  ByQueryResult,
  Refresh,
  VersionParams,
  WriteResult,
} from "./search-client";
import type { QueryOptions, SearchHits, SearchOptions, WriteOptions } from "./search.types";
import type { ExtractIndexSchema, IndexDiscriminator, IndexNested, Obj, QueryFor } from "./types";
import type {
  RepoBase,
  RepoConfig,
  RepoFieldPath,
  RepoOutput,
  RepoQueryResult,
  RepoUpdateData,
} from "./repo.types";

export type UpdateOptions = WriteOptions & { retryOnConflict?: number };
export type WriteVersionOptions = WriteOptions & VersionParams;
export type BulkOptions = { batchSize?: number; refresh?: Refresh };
export type ByQueryOptions = {
  script?: string;
  scriptParams?: Obj;
  refresh?: Refresh;
  conflicts?: "abort" | "proceed";
};

// Concrete reconstruction of this repo's `RepoBase` shape from its type params
// (not from `this`), so helper types written against `Self` reduce inside
// subclass method bodies. See dinah's repo.ts for the full rationale.
type RepoSelf<Idx extends Index, TOutput> = {
  readonly $schema: ExtractIndexSchema<Idx>;
  readonly $discriminator: IndexDiscriminator<Idx>;
  readonly $nested: IndexNested<Idx>;
  readonly index: Idx;
  transformOutput(hit: ExtractIndexSchema<Idx>): TOutput;
};

// Only carry over defined keys — spreading `undefined` values would clobber a
// version/versionType derived from the index's version strategy.
const pickVersionParams = (o?: VersionParams): VersionParams => {
  const p: VersionParams = {};
  if (o?.ifSeqNo !== undefined) p.ifSeqNo = o.ifSeqNo;
  if (o?.ifPrimaryTerm !== undefined) p.ifPrimaryTerm = o.ifPrimaryTerm;
  if (o?.version !== undefined) p.version = o.version;
  if (o?.versionType !== undefined) p.versionType = o.versionType;
  return p;
};

const snakeVersion = (v: VersionParams): Obj => {
  const p: Obj = {};
  if (v.ifSeqNo !== undefined) p.if_seq_no = v.ifSeqNo;
  if (v.ifPrimaryTerm !== undefined) p.if_primary_term = v.ifPrimaryTerm;
  if (v.version !== undefined) p.version = v.version;
  if (v.versionType !== undefined) p.version_type = v.versionType;
  return p;
};

/**
 * Strongly-typed repository over a single `Index`. Analogous to dinah's `Repo`.
 * Typed queries come from the vendored mongoes engine; discriminated-union
 * results narrow automatically when a query pins the discriminator.
 */
export class SearchRepository<
  Idx extends Index,
  TOutput = ExtractIndexSchema<Idx>,
  Self extends RepoBase = RepoSelf<Idx, TOutput>,
> {
  // phantom self-type; name it to author an override of a generic base method.
  declare readonly $self: Self;
  declare readonly $schema: ExtractIndexSchema<Idx>;
  declare readonly $discriminator: IndexDiscriminator<Idx>;
  declare readonly $nested: IndexNested<Idx>;

  readonly index: Idx;
  /** The backing `Search` (the "generic Db"). Mirrors dinah's `repo.db`. */
  readonly db: Search;
  protected readonly config: RepoConfig<ExtractIndexSchema<Idx>, TOutput>;

  constructor(search: Search, index: Idx, config?: RepoConfig<ExtractIndexSchema<Idx>, TOutput>) {
    this.db = search;
    this.index = index;
    this.config = config ?? {};
  }

  get name(): string {
    return this.index.def.name;
  }

  get resourceName(): string {
    return this.config.resourceName ?? this.name;
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  private get def() {
    return this.index.def as { id?: unknown; version?: unknown };
  }

  private derivedMappings?: DerivedMappings;

  /** The schema-derived mappings, used to validate queries before they are sent. */
  private get mappings(): DerivedMappings {
    this.derivedMappings ??= deriveMappings(this.index.schema, this.index.def.mapping);
    return this.derivedMappings;
  }

  /** Resolve a document's `_id` from the index's id strategy. */
  extractId(doc: Self["$schema"]): string | undefined {
    return resolveId(this.def.id as never, doc as Obj);
  }

  private idOrThrow(doc: Obj): string {
    const id = resolveId(this.def.id as never, doc);
    if (id === undefined) {
      throw new DeweyError({
        type: "VALIDATION",
        message: `Could not derive an id for ${this.resourceName}. Configure IndexDef.id or provide the id field(s).`,
      });
    }
    return id;
  }

  private versionFor(doc: Obj): VersionParams {
    const version = resolveVersion(this.def.version as never, doc);
    return version === undefined ? {} : { version, versionType: "external" };
  }

  /** Apply `transformInput` then optionally validate against the schema. */
  private prepare(doc: Obj): Obj {
    const prepared = this.config.transformInput
      ? (this.config.transformInput(doc as never) as Obj)
      : doc;
    const validate = this.config.validate ?? this.db.config.validate;
    if (validate && !Check(this.index.schema, prepared)) {
      const first = Errors(this.index.schema, prepared)[0];
      throw new DeweyError({
        type: "VALIDATION",
        message: first
          ? `${first.message} at ${first.instancePath || "/"}`
          : "Document failed schema validation.",
      });
    }
    return prepared;
  }

  private hydrate(source: Obj): RepoOutput<Self> {
    return (
      this.config.transformOutput ? this.config.transformOutput(source as never) : source
    ) as RepoOutput<Self>;
  }

  // ── reads ───────────────────────────────────────────────────────────────

  async get(id: string): Promise<RepoOutput<Self> | undefined> {
    const res = await this.db.get<Obj>(this.name, id);
    return res.found && res.source ? this.hydrate(res.source) : undefined;
  }

  async getOrThrow(id: string): Promise<RepoOutput<Self>> {
    const item = await this.get(id);
    if (item === undefined) {
      throw new DeweyError({
        type: "NOT_FOUND",
        id,
        index: this.name,
        resource: this.resourceName,
      });
    }
    return item;
  }

  async query<const Q extends QueryFor<Self["$schema"], Self["$nested"]>>(
    query: Q & StrictQuery<Q, Self["$schema"], Self["$nested"]>,
    options?: QueryOptions,
  ): Promise<RepoQueryResult<Self, Q>[]> {
    // (the strict check already ran against this query)
    const result = await this.search<Q>(query as never, options);
    return result.hits.map((h) => h.source);
  }

  async search<const Q extends QueryFor<Self["$schema"], Self["$nested"]>>(
    query: Q & StrictQuery<Q, Self["$schema"], Self["$nested"]>,
    options?: SearchOptions,
  ): Promise<SearchHits<RepoQueryResult<Self, Q>>> {
    const body = buildSearchBody(query as Obj, options, this.mappings);
    const res = await this.db.search<Obj>(
      this.name,
      body,
      options?.routing ? { routing: options.routing } : undefined,
    );
    return {
      total: res.total,
      aggregations: res.aggregations,
      hits: res.hits.map((h) => ({
        id: h.id,
        score: h.score,
        source: this.hydrate(h.source) as RepoQueryResult<Self, Q>,
        sort: h.sort,
        highlight: h.highlight,
        seqNo: h.seqNo,
        primaryTerm: h.primaryTerm,
        version: h.version,
      })),
    };
  }

  async count(query?: QueryFor<Self["$schema"], Self["$nested"]>): Promise<number> {
    return this.db.count(this.name, {
      query: buildQuery(query as Obj, true, this.mappings),
    });
  }

  async exists(query?: QueryFor<Self["$schema"], Self["$nested"]>): Promise<boolean> {
    return (await this.count(query)) > 0;
  }

  /** Paginate every matching document via PIT + `search_after`. */
  async *scroll<const Q extends QueryFor<Self["$schema"], Self["$nested"]>>(
    query?: Q & StrictQuery<Q, Self["$schema"], Self["$nested"]>,
    options?: SearchOptions,
  ): AsyncGenerator<RepoQueryResult<Self, Q>, void, unknown> {
    const keepAlive = "1m";
    const size = options?.size ?? 500;
    // Append `_id` as a total-order tiebreaker so search_after paginates
    // deterministically. (`_shard_doc` is Elasticsearch-only.)
    const sort = [...(options?.sort ? [options.sort].flat() : []), { _id: "asc" as const }];
    const pit = await this.db.openPointInTime(this.name, keepAlive);
    try {
      let searchAfter = options?.searchAfter;
      for (;;) {
        const body = buildSearchBody(
          query as Obj,
          { ...options, size, sort, searchAfter },
          this.mappings,
        );
        body.pit = { id: pit, keep_alive: keepAlive };
        const res = await this.db.search<Obj>("", body);
        if (!res.hits.length) break;
        for (const hit of res.hits) {
          yield this.hydrate(hit.source) as RepoQueryResult<Self, Q>;
        }
        if (res.hits.length < size) break;
        searchAfter = res.hits[res.hits.length - 1]!.sort;
        if (!searchAfter) break;
      }
    } finally {
      await this.db.closePointInTime(pit).catch(() => {});
    }
  }

  // ── aggregations ──────────────────────────────────────────────────────────

  async countBy<F extends RepoFieldPath<Self>>(
    field: F,
    query?: QueryFor<Self["$schema"], Self["$nested"]>,
    options?: { uniqueField?: RepoFieldPath<Self>; size?: number },
  ): Promise<Record<string, number>> {
    const terms: Obj = { field, size: options?.size ?? 10 };
    const aggs: Obj = {
      countBy: {
        terms,
        ...(options?.uniqueField
          ? { aggs: { unique: { cardinality: { field: options.uniqueField } } } }
          : {}),
      },
    };
    const body = buildSearchBody(query as Obj, { size: 0, aggs }, this.mappings);
    const res = await this.db.search<Obj>(this.name, body);
    const buckets: Obj[] = res.aggregations?.countBy?.buckets ?? [];
    return Object.fromEntries(
      buckets.map((b) => [String(b.key), options?.uniqueField ? b.unique.value : b.doc_count]),
    );
  }

  async average<F extends RepoFieldPath<Self>>(
    field: F,
    query?: QueryFor<Self["$schema"], Self["$nested"]>,
  ): Promise<number> {
    const body = buildSearchBody(
      query as Obj,
      { size: 0, aggs: { avg: { avg: { field } } } },
      this.mappings,
    );
    const res = await this.db.search<Obj>(this.name, body);
    return res.aggregations?.avg?.value ?? 0;
  }

  // ── writes ──────────────────────────────────────────────────────────────

  /** Create-or-replace by id (the ES "index" op). Applies external versioning when the index declares a version strategy. */
  async put(doc: Self["$schema"], options?: WriteVersionOptions): Promise<WriteResult> {
    const prepared = this.prepare(doc as Obj);
    const id = this.extractId(prepared as never);
    const version = { ...this.versionFor(prepared), ...pickVersionParams(options) };
    return this.db.index(this.name, prepared, { id, refresh: options?.refresh, ...version });
  }

  /** Create — fails if a document with the derived id already exists. */
  async create(doc: Self["$schema"], options?: WriteOptions): Promise<WriteResult> {
    const prepared = this.prepare(doc as Obj);
    const id = this.idOrThrow(prepared);
    return this.db.create(this.name, id, prepared, { refresh: options?.refresh });
  }

  /** Partial update by id; merges `data` into the stored doc. */
  async update(
    id: string,
    data: RepoUpdateData<Self>,
    options?: UpdateOptions,
  ): Promise<WriteResult> {
    return this.db.update(this.name, id, { doc: data }, options);
  }

  /** Update if present, otherwise index `doc`. */
  async upsert(
    id: string,
    data: RepoUpdateData<Self>,
    doc: Self["$schema"],
    options?: UpdateOptions,
  ): Promise<WriteResult> {
    return this.db.update(this.name, id, { doc: data, upsert: this.prepare(doc as Obj) }, options);
  }

  async delete(id: string, options?: WriteVersionOptions): Promise<WriteResult> {
    return this.db.delete(this.name, id, {
      refresh: options?.refresh,
      ...pickVersionParams(options),
    });
  }

  // ── bulk & by-query ───────────────────────────────────────────────────────

  private async bulkGroups(groups: Obj[][], options?: BulkOptions): Promise<BulkResult> {
    const batchSize = options?.batchSize ?? 1000;
    const items: BulkResultItem[] = [];
    let errors = false;
    for (let i = 0; i < groups.length; i += batchSize) {
      const chunk = groups.slice(i, i + batchSize).flat();
      if (!chunk.length) continue;
      const res = await this.db.bulk(chunk, { refresh: options?.refresh });
      errors = errors || res.errors;
      items.push(...res.items);
    }
    return { errors, items };
  }

  async bulkPut(docs: Self["$schema"][], options?: BulkOptions): Promise<BulkResult> {
    const groups = docs.map((doc) => {
      const prepared = this.prepare(doc as Obj);
      const meta = {
        index: {
          _index: this.name,
          _id: this.extractId(prepared as never),
          ...snakeVersion(this.versionFor(prepared)),
        },
      };
      return [meta, prepared];
    });
    return this.bulkGroups(groups, options);
  }

  async bulkCreate(docs: Self["$schema"][], options?: BulkOptions): Promise<BulkResult> {
    const groups = docs.map((doc) => {
      const prepared = this.prepare(doc as Obj);
      return [{ create: { _index: this.name, _id: this.idOrThrow(prepared) } }, prepared];
    });
    return this.bulkGroups(groups, options);
  }

  async bulkUpdate(
    updates: { id: string; data: RepoUpdateData<Self> }[],
    options?: BulkOptions,
  ): Promise<BulkResult> {
    const groups = updates.map((u) => [
      { update: { _index: this.name, _id: u.id } },
      { doc: u.data },
    ]);
    return this.bulkGroups(groups, options);
  }

  async bulkDelete(ids: string[], options?: BulkOptions): Promise<BulkResult> {
    const groups = ids.map((id) => [{ delete: { _index: this.name, _id: id } }]);
    return this.bulkGroups(groups, options);
  }

  async updateByQuery(
    query: QueryFor<Self["$schema"], Self["$nested"]>,
    options?: ByQueryOptions,
  ): Promise<ByQueryResult> {
    const body: Obj = { query: buildQuery(query as Obj, true, this.mappings) };
    if (options?.script) body.script = { source: options.script, params: options.scriptParams };
    return this.db.updateByQuery(this.name, body, {
      refresh: options?.refresh,
      conflicts: options?.conflicts,
    });
  }

  async deleteByQuery(
    query: QueryFor<Self["$schema"], Self["$nested"]>,
    options?: Omit<ByQueryOptions, "script" | "scriptParams">,
  ): Promise<ByQueryResult> {
    return this.db.deleteByQuery(
      this.name,
      { query: buildQuery(query as Obj, true, this.mappings) },
      { refresh: options?.refresh, conflicts: options?.conflicts },
    );
  }

  // ── index administration ──────────────────────────────────────────────────

  /** Create the index with mappings derived from the schema if it does not exist. */
  async ensureIndex(): Promise<void> {
    if (await this.db.indexExists(this.name)) return;
    const mappings = deriveMappings(this.index.schema, this.index.def.mapping);
    const body: Obj = { mappings };
    if (this.index.def.mapping?.settings) body.settings = this.index.def.mapping.settings;
    await this.db.createIndex(this.name, body);
  }

  /** Push the schema-derived mapping to the live index. */
  async putMapping(): Promise<void> {
    await this.db.putMapping(this.name, deriveMappings(this.index.schema, this.index.def.mapping));
  }
}

export type MakeRepositoryResult<Idx extends Index, TOutput> = {
  new (search: Search): SearchRepository<Idx, TOutput>;
  readonly index: Idx;
};

/**
 * Factory returning a base class bound to an `Index` and config. Extend it to
 * define a repository:
 *
 * ```ts
 * class UserRepo extends makeRepository(UserIndex, {
 *   transformOutput: (doc) => new User(doc),
 * }) {}
 * const users = new UserRepo(search);
 * ```
 */
export const makeRepository = <Idx extends Index, TOutput = ExtractIndexSchema<Idx>>(
  index: Idx,
  config?: RepoConfig<ExtractIndexSchema<Idx>, TOutput>,
): MakeRepositoryResult<Idx, TOutput> => {
  return class extends SearchRepository<Idx, TOutput> {
    static readonly index = index;
    constructor(search: Search) {
      super(search, index, config);
    }
  };
};
