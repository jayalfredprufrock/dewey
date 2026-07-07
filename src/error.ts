export type DeweyErrorDetails =
  | { type: "NOT_FOUND"; id?: string; index?: string; resource?: string }
  | { type: "ALREADY_EXISTS"; id?: string; index?: string; resource?: string }
  | { type: "VERSION_CONFLICT"; id?: string; index?: string; resource?: string }
  | { type: "VALIDATION"; message: string }
  | { type: "DATA_INTEGRITY"; message: string }
  | { type: "BULK"; failures: Array<{ id?: string; type: string; reason?: string }> };

function deweyErrorMessage(details: DeweyErrorDetails): string {
  switch (details.type) {
    case "NOT_FOUND":
      return `${details.resource ?? "Document"} not found.`;
    case "ALREADY_EXISTS":
      return `${details.resource ?? "Document"} already exists.`;
    case "VERSION_CONFLICT":
      return `${details.resource ?? "Document"} version conflict.`;
    case "VALIDATION":
      return `Validation error: ${details.message}`;
    case "DATA_INTEGRITY":
      return `Data integrity error: ${details.message}`;
    case "BULK":
      return `Bulk operation had ${details.failures.length} failure(s): ${details.failures
        .map((f) => f.type)
        .join(", ")}`;
  }
}

export class DeweyError extends Error {
  readonly details: DeweyErrorDetails;

  constructor(details: DeweyErrorDetails, options?: ErrorOptions) {
    super(deweyErrorMessage(details), options);
    this.name = "DeweyError";
    this.details = details;
  }
}

export const isDeweyError = (err: unknown): err is DeweyError => err instanceof DeweyError;

/** The kind of operation being performed, used to map ambiguous status codes (e.g. 409). */
export type OpKind = "get" | "create" | "index" | "update" | "delete" | "search" | "bulk";

interface DriverErrorContext {
  op: OpKind;
  id?: string;
  index?: string;
  resource?: string;
}

// Duck-typed shape of the opensearch-js / elasticsearch-js `ResponseError`.
const isResponseError = (
  err: unknown,
): err is {
  name: string;
  statusCode?: number | null;
  meta?: { body?: { error?: { type?: string } } };
} =>
  typeof err === "object" && err !== null && (err as { name?: unknown }).name === "ResponseError";

/**
 * Map a driver `ResponseError` to a `DeweyError` when the status code has a
 * clear meaning; otherwise return the original error untouched. A 409 is
 * `ALREADY_EXISTS` for a `create` and `VERSION_CONFLICT` for everything else.
 */
export const normalizeDriverError = (err: unknown, ctx: DriverErrorContext): unknown => {
  if (!isResponseError(err)) return err;
  const { id, index, resource } = ctx;
  const status = err.statusCode ?? undefined;

  if (status === 404) {
    return new DeweyError({ type: "NOT_FOUND", id, index, resource }, { cause: err });
  }
  if (status === 409) {
    const type = ctx.op === "create" ? "ALREADY_EXISTS" : "VERSION_CONFLICT";
    return new DeweyError({ type, id, index, resource }, { cause: err });
  }
  return err;
};
