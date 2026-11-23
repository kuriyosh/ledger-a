export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function api<T>(
  service: string,
  route: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api/${service}${route}`, init);
  const data = await response.json().catch(() => undefined);
  if (data === undefined)
    throw new ApiError(
      "INVALID_RESPONSE",
      response.status,
      "サービスの応答を読み取れません",
    );
  if (!response.ok)
    throw new ApiError(
      data.error?.code ?? "REQUEST_FAILED",
      response.status,
      data.error?.message ?? "通信に失敗しました",
    );
  return data as T;
}
