export interface MockCall {
  url: string;
  init?: RequestInit;
}
export type MockHandler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function mockFetch(handler: MockHandler) {
  const calls: MockCall[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(new URL(url), init);
  };
  return { fetch: fetcher, calls };
}
