import type {
  BulkResult,
  ByQueryResult,
  GetResult,
  Refresh,
  SearchClient,
  SearchResult,
  VersionParams,
  WriteResult,
} from "./search-client";
import type { Obj } from "./types";
import { normalizeDriverError, type OpKind } from "./error";

export interface SearchConfig {
  /** Default `refresh` applied to writes when not specified per-call. Default `false`. */
  refresh?: Refresh;
  /** Validate documents against their schema before writing (repos read this too). Default `false`. */
  validate?: boolean;
}

/**
 * Thin, normalized wrapper over a `SearchClient`. Analogous to dinah's `Db`:
 * document-agnostic, applies config defaults, and (TODO) maps driver errors to
 * `DeweyError`. `SearchRepository` layers strong typing on top.
 */
export class Search {
  readonly client: SearchClient;
  readonly config: SearchConfig;

  constructor(client: SearchClient, config: SearchConfig = {}) {
    this.client = client;
    this.config = config;
  }

  private refresh(refresh?: Refresh): Refresh | undefined {
    return refresh ?? this.config.refresh;
  }

  /** Run a driver call, normalizing recognized driver errors (404/409) into `DeweyError`. */
  private async run<T>(
    ctx: { op: OpKind; id?: string; index?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw normalizeDriverError(err, ctx);
    }
  }

  get<T = Obj>(index: string, id: string): Promise<GetResult<T>> {
    return this.run({ op: "get", index, id }, () => this.client.get<T>(index, id));
  }

  index<T = Obj>(
    index: string,
    doc: T,
    opts?: { id?: string; refresh?: Refresh } & VersionParams,
  ): Promise<WriteResult> {
    return this.run({ op: "index", index, id: opts?.id }, () =>
      this.client.index<T>(index, doc, { ...opts, refresh: this.refresh(opts?.refresh) }),
    );
  }

  create<T = Obj>(
    index: string,
    id: string,
    doc: T,
    opts?: { refresh?: Refresh },
  ): Promise<WriteResult> {
    return this.run({ op: "create", index, id }, () =>
      this.client.create<T>(index, id, doc, { refresh: this.refresh(opts?.refresh) }),
    );
  }

  update(
    index: string,
    id: string,
    body: Obj,
    opts?: { refresh?: Refresh; retryOnConflict?: number },
  ): Promise<WriteResult> {
    return this.run({ op: "update", index, id }, () =>
      this.client.update(index, id, body, { ...opts, refresh: this.refresh(opts?.refresh) }),
    );
  }

  delete(
    index: string,
    id: string,
    opts?: { refresh?: Refresh } & VersionParams,
  ): Promise<WriteResult> {
    return this.run({ op: "delete", index, id }, () =>
      this.client.delete(index, id, { ...opts, refresh: this.refresh(opts?.refresh) }),
    );
  }

  search<T = Obj>(index: string, body: Obj, opts?: Obj): Promise<SearchResult<T>> {
    return this.client.search<T>(index, body, opts);
  }

  count(index: string, body?: Obj): Promise<number> {
    return this.client.count(index, body);
  }

  bulk(operations: Obj[], opts?: { refresh?: Refresh }): Promise<BulkResult> {
    return this.client.bulk(operations, { refresh: this.refresh(opts?.refresh) });
  }

  updateByQuery(index: string, body: Obj, opts?: Obj): Promise<ByQueryResult> {
    return this.client.updateByQuery(index, body, opts);
  }

  deleteByQuery(index: string, body: Obj, opts?: Obj): Promise<ByQueryResult> {
    return this.client.deleteByQuery(index, body, opts);
  }

  openPointInTime(index: string, keepAlive: string): Promise<string> {
    return this.client.openPointInTime(index, keepAlive);
  }

  closePointInTime(pitId: string): Promise<void> {
    return this.client.closePointInTime(pitId);
  }

  // index administration -------------------------------------------------------

  indexExists(index: string): Promise<boolean> {
    return this.client.indexExists(index);
  }

  createIndex(index: string, body?: Obj): Promise<void> {
    return this.client.createIndex(index, body);
  }

  deleteIndex(index: string): Promise<void> {
    return this.client.deleteIndex(index);
  }

  putMapping(index: string, body: Obj): Promise<void> {
    return this.client.putMapping(index, body);
  }
}
