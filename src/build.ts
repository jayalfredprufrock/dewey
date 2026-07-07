import { convertQuery } from "./query";
import type { IdStrategy, VersionStrategy } from "./search-index";
import type { SearchOptions } from "./search.types";
import type { Obj } from "./types";

/** Separator joining the parts of a composite (multi-field) `_id`. */
export const ID_SEPARATOR = "#";

const isEmpty = (query: unknown): boolean =>
  query == null || (typeof query === "object" && Object.keys(query as Obj).length === 0);

/** Resolve a document's `_id` from an id strategy. Returns `undefined` when a required part is missing. */
export const resolveId = <T extends Obj>(
  strategy: IdStrategy<T> | undefined,
  doc: T,
): string | undefined => {
  if (strategy === undefined) return undefined;
  if (typeof strategy === "function") return strategy(doc);
  if (Array.isArray(strategy)) {
    const parts = strategy.map((field) => doc[field as keyof T]);
    if (parts.some((p) => p == null)) return undefined;
    return parts.join(ID_SEPARATOR);
  }
  const value = doc[strategy as keyof T];
  return value == null ? undefined : String(value);
};

/** Resolve an external version number from a version strategy. */
export const resolveVersion = <T extends Obj>(
  strategy: VersionStrategy<T> | undefined,
  doc: T,
): number | undefined => {
  if (strategy === undefined) return undefined;
  if (typeof strategy === "function") return strategy(doc);
  const value = doc[strategy as keyof T];
  return value == null ? undefined : Number(value);
};

/**
 * Convert a mongo-style query to an ES/OS query DSL fragment. An empty/absent
 * query becomes `match_all`; otherwise the converted query is wrapped in filter
 * context (no scoring) unless `filterContext` is `false`.
 */
export const buildQuery = (query?: Obj, filterContext = true): Obj => {
  if (isEmpty(query)) return { match_all: {} };
  const dsl = convertQuery(query);
  return filterContext ? { bool: { filter: dsl } } : dsl;
};

/** Build the `search` request body from a mongo-style query and read options. */
export const buildSearchBody = (query?: Obj, options?: SearchOptions): Obj => {
  const body: Obj = { query: buildQuery(query, options?.filterContext) };
  if (options?.size !== undefined) body.size = options.size;
  if (options?.from !== undefined) body.from = options.from;
  if (options?.sort !== undefined) body.sort = options.sort;
  if (options?.aggs !== undefined) body.aggs = options.aggs;
  if (options?.highlight !== undefined) body.highlight = options.highlight;
  if (options?.source !== undefined) body._source = options.source;
  if (options?.searchAfter !== undefined) body.search_after = options.searchAfter;
  if (options?.trackTotalHits !== undefined) body.track_total_hits = options.trackTotalHits;
  if (options?.minScore !== undefined) body.min_score = options.minScore;
  return body;
};
