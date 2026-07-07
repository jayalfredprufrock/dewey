import type { Obj } from "./types";
import type { Refresh } from "./search-client";

export type SortDirection = "asc" | "desc";
export type Sort =
  | string
  | Record<string, SortDirection | Obj>
  | Array<string | Record<string, SortDirection | Obj>>;

export type SourceFilter = boolean | string[] | { includes?: string[]; excludes?: string[] };

/** Options common to `search`/`query` reads. */
export interface SearchOptions {
  size?: number;
  from?: number;
  sort?: Sort;
  aggs?: Obj;
  highlight?: Obj;
  source?: SourceFilter;
  searchAfter?: unknown[];
  trackTotalHits?: boolean | number;
  minScore?: number;
  routing?: string;
  /** Wrap the converted query in filter context (no scoring). Default `true`. */
  filterContext?: boolean;
}

export interface QueryOptions extends SearchOptions {}

export interface WriteOptions {
  refresh?: Refresh;
}

/** Rich result of `search()` — the raw doc plus hit metadata and aggregations. */
export interface SearchHits<T> {
  total: number;
  hits: Array<{
    id: string;
    score: number | null;
    source: T;
    sort?: unknown[];
    highlight?: Record<string, string[]>;
    seqNo?: number;
    primaryTerm?: number;
    version?: number;
  }>;
  aggregations?: Obj;
}
