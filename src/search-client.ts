import type { Client as OpenSearchClientType } from "@opensearch-project/opensearch";
import type { Obj } from "./types";

export type Refresh = boolean | "wait_for";

/** Optimistic-concurrency parameters applied to a write. */
export interface VersionParams {
  ifSeqNo?: number;
  ifPrimaryTerm?: number;
  version?: number;
  versionType?: "external" | "external_gte";
}

export interface GetResult<T> {
  found: boolean;
  id: string;
  index: string;
  version?: number;
  seqNo?: number;
  primaryTerm?: number;
  source?: T;
}

export interface Hit<T> {
  id: string;
  index: string;
  score: number | null;
  source: T;
  sort?: unknown[];
  version?: number;
  seqNo?: number;
  primaryTerm?: number;
  highlight?: Record<string, string[]>;
}

export interface SearchResult<T> {
  total: number;
  hits: Hit<T>[];
  aggregations?: Obj;
  pitId?: string;
}

export interface WriteResult {
  id: string;
  index: string;
  result: "created" | "updated" | "deleted" | "noop" | "not_found";
  version?: number;
  seqNo?: number;
  primaryTerm?: number;
}

export interface BulkResultItem {
  id?: string;
  operation: "index" | "create" | "update" | "delete";
  status: number;
  result?: string;
  error?: { type: string; reason?: string };
}

export interface BulkResult {
  errors: boolean;
  items: BulkResultItem[];
}

export interface ByQueryResult {
  total: number;
  updated?: number;
  deleted?: number;
  versionConflicts: number;
  failures: Obj[];
}

/**
 * Client-agnostic seam over the underlying ES/OS driver. Every dewey operation
 * goes through this so an Elasticsearch implementation can be added later
 * without touching `Search` or `SearchRepository`. Results are already
 * normalized (snake_case ES fields → camelCase, `body`-wrapping hidden).
 */
export interface SearchClient {
  readonly kind: "opensearch" | "elasticsearch";

  get<T = Obj>(index: string, id: string): Promise<GetResult<T>>;
  index<T = Obj>(
    index: string,
    doc: T,
    opts?: { id?: string; refresh?: Refresh } & VersionParams,
  ): Promise<WriteResult>;
  create<T = Obj>(
    index: string,
    id: string,
    doc: T,
    opts?: { refresh?: Refresh },
  ): Promise<WriteResult>;
  update(
    index: string,
    id: string,
    body: Obj,
    opts?: { refresh?: Refresh; retryOnConflict?: number },
  ): Promise<WriteResult>;
  delete(
    index: string,
    id: string,
    opts?: { refresh?: Refresh } & VersionParams,
  ): Promise<WriteResult>;

  search<T = Obj>(index: string, body: Obj, opts?: Obj): Promise<SearchResult<T>>;
  count(index: string, body?: Obj): Promise<number>;
  bulk(operations: Obj[], opts?: { refresh?: Refresh }): Promise<BulkResult>;
  updateByQuery(index: string, body: Obj, opts?: Obj): Promise<ByQueryResult>;
  deleteByQuery(index: string, body: Obj, opts?: Obj): Promise<ByQueryResult>;

  openPointInTime(index: string, keepAlive: string): Promise<string>;
  closePointInTime(pitId: string): Promise<void>;

  // index administration
  indexExists(index: string): Promise<boolean>;
  createIndex(index: string, body?: Obj): Promise<void>;
  deleteIndex(index: string): Promise<void>;
  putMapping(index: string, body: Obj): Promise<void>;
}

const versionParams = (v?: VersionParams): Obj => {
  const p: Obj = {};
  if (v?.ifSeqNo !== undefined) p.if_seq_no = v.ifSeqNo;
  if (v?.ifPrimaryTerm !== undefined) p.if_primary_term = v.ifPrimaryTerm;
  if (v?.version !== undefined) p.version = v.version;
  if (v?.versionType !== undefined) p.version_type = v.versionType;
  return p;
};

const toWriteResult = (body: Obj): WriteResult => ({
  id: body._id,
  index: body._index,
  result: body.result,
  version: body._version,
  seqNo: body._seq_no,
  primaryTerm: body._primary_term,
});

const toHit = <T>(h: Obj): Hit<T> => ({
  id: h._id,
  index: h._index,
  score: h._score ?? null,
  source: h._source as T,
  sort: h.sort,
  version: h._version,
  seqNo: h._seq_no,
  primaryTerm: h._primary_term,
  highlight: h.highlight,
});

/** OpenSearch driver implementation of the `SearchClient` seam. */
export class OpenSearchClient implements SearchClient {
  readonly kind = "opensearch" as const;

  constructor(private readonly client: OpenSearchClientType) {}

  /** Escape hatch to the underlying OpenSearch client for operations dewey doesn't wrap. */
  get raw(): OpenSearchClientType {
    return this.client;
  }

  async get<T = Obj>(index: string, id: string): Promise<GetResult<T>> {
    const res = await this.client.get({ index, id }, { ignore: [404] });
    const body = res.body as Obj;
    if (res.statusCode === 404 || !body.found) return { found: false, id, index };
    return {
      found: true,
      id: body._id,
      index: body._index,
      version: body._version,
      seqNo: body._seq_no,
      primaryTerm: body._primary_term,
      source: body._source as T,
    };
  }

  async index<T = Obj>(
    index: string,
    doc: T,
    opts?: { id?: string; refresh?: Refresh } & VersionParams,
  ): Promise<WriteResult> {
    const res = await this.client.index({
      index,
      id: opts?.id,
      body: doc as Obj,
      refresh: opts?.refresh,
      ...versionParams(opts),
    });
    return toWriteResult(res.body as Obj);
  }

  async create<T = Obj>(
    index: string,
    id: string,
    doc: T,
    opts?: { refresh?: Refresh },
  ): Promise<WriteResult> {
    const res = await this.client.create({ index, id, body: doc as Obj, refresh: opts?.refresh });
    return toWriteResult(res.body as Obj);
  }

  async update(
    index: string,
    id: string,
    body: Obj,
    opts?: { refresh?: Refresh; retryOnConflict?: number },
  ): Promise<WriteResult> {
    const res = await this.client.update({
      index,
      id,
      body,
      refresh: opts?.refresh,
      retry_on_conflict: opts?.retryOnConflict,
    });
    return toWriteResult(res.body as Obj);
  }

  async delete(
    index: string,
    id: string,
    opts?: { refresh?: Refresh } & VersionParams,
  ): Promise<WriteResult> {
    const res = await this.client.delete({
      index,
      id,
      refresh: opts?.refresh,
      ...versionParams(opts),
    });
    return toWriteResult(res.body as Obj);
  }

  async search<T = Obj>(index: string, body: Obj, opts?: Obj): Promise<SearchResult<T>> {
    const res = await this.client.search({ index: index || undefined, body, ...opts });
    const b = res.body as Obj;
    const total = typeof b.hits.total === "number" ? b.hits.total : (b.hits.total?.value ?? 0);
    return {
      total,
      hits: (b.hits.hits ?? []).map((h: Obj) => toHit<T>(h)),
      aggregations: b.aggregations,
      pitId: b.pit_id,
    };
  }

  async count(index: string, body?: Obj): Promise<number> {
    const res = await this.client.count({ index, body });
    return (res.body as Obj).count;
  }

  async bulk(operations: Obj[], opts?: { refresh?: Refresh }): Promise<BulkResult> {
    const res = await this.client.bulk({ body: operations, refresh: opts?.refresh });
    const b = res.body as Obj;
    return {
      errors: b.errors,
      items: (b.items ?? []).map((item: Obj): BulkResultItem => {
        const [operation, r] = Object.entries(item)[0] as [string, Obj];
        return {
          id: r._id,
          operation: operation as BulkResultItem["operation"],
          status: r.status,
          result: r.result,
          error: r.error ? { type: r.error.type, reason: r.error.reason } : undefined,
        };
      }),
    };
  }

  async updateByQuery(index: string, body: Obj, opts?: Obj): Promise<ByQueryResult> {
    const res = await this.client.updateByQuery({ index, body, ...opts });
    return toByQueryResult(res.body as Obj);
  }

  async deleteByQuery(index: string, body: Obj, opts?: Obj): Promise<ByQueryResult> {
    const res = await this.client.deleteByQuery({ index, body, ...opts });
    return toByQueryResult(res.body as Obj);
  }

  async openPointInTime(index: string, keepAlive: string): Promise<string> {
    const res = await this.client.createPit({ index: [index], keep_alive: keepAlive });
    return (res.body as Obj).pit_id;
  }

  async closePointInTime(pitId: string): Promise<void> {
    await this.client.deletePit({ body: { pit_id: [pitId] } });
  }

  async indexExists(index: string): Promise<boolean> {
    const res = await this.client.indices.exists({ index });
    return res.body === true;
  }

  async createIndex(index: string, body?: Obj): Promise<void> {
    await this.client.indices.create({ index, body });
  }

  async deleteIndex(index: string): Promise<void> {
    await this.client.indices.delete({ index });
  }

  async putMapping(index: string, body: Obj): Promise<void> {
    await this.client.indices.putMapping({ index, body });
  }
}

const toByQueryResult = (b: Obj): ByQueryResult => ({
  total: b.total ?? 0,
  updated: b.updated,
  deleted: b.deleted,
  versionConflicts: b.version_conflicts ?? 0,
  failures: b.failures ?? [],
});

/** Wrap an OpenSearch `Client` instance in the dewey `SearchClient` seam. */
export const openSearch = (client: OpenSearchClientType): SearchClient =>
  new OpenSearchClient(client);
