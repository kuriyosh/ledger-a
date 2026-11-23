import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ServiceError extends Error {
  readonly code: string;
  readonly status: ContentfulStatusCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: ContentfulStatusCode,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
