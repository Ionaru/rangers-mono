import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { getLogger, ROOT_CATEGORY } from "@7r/logging";

const log = getLogger([ROOT_CATEGORY, "worker", "serve"]);

/**
 * A fetch-style HTTP server on `node:http`, for the worker's internal API.
 *
 * The internal API is written against the web `Request`/`Response` pair
 * (internal-api.ts), so this is only the adapter between that and Node's
 * `IncomingMessage`/`ServerResponse`. It is deliberately small: the API's
 * bodies are tiny JSON or text, so request and response bodies are buffered
 * whole. No streaming, no upgrades, no TLS (the Compose network only).
 */

export interface ServeOptions {
  port: number;
  hostname: string;
}

export interface Server {
  /** The port actually bound (differs from options.port when that was 0). */
  readonly port: number;
  /** Resolves once shutdown() has completed and the listener is closed. */
  readonly finished: Promise<void>;
  /** Stop accepting, close idle keep-alive connections, resolve when the server is closed. Idempotent. */
  shutdown(): Promise<void>;
}

export type Handler = (request: Request) => Response | Promise<Response>;

/**
 * After this long a graceful shutdown stops waiting for in-flight requests and
 * drops the connections that are left, so a stuck client cannot hold a deploy
 * to Compose's kill timeout.
 */
const SHUTDOWN_GRACE_MS = 5_000;

/** Statuses whose responses carry no body, so no Content-Length is added. */
const BODYLESS_STATUSES = new Set([204, 205, 304]);

/**
 * Start listening and resolve once the socket is bound.
 *
 * A listen failure (EADDRINUSE above all) rejects instead of resolving, which
 * is what makes "port already in use" a boot-fatal error in `main()` and not a
 * worker that is up and serving nothing.
 */
export async function serve(
  options: ServeOptions,
  handler: Handler,
): Promise<Server> {
  let port = options.port;
  const server = createServer((req, res) => {
    void handle(req, res, handler, options, () => port);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: options.port, host: options.hostname }, () => {
      server.off("error", reject);
      resolve();
    });
  });

  port = (server.address() as AddressInfo).port;

  // A listener that outlives startup: without one, any later 'error' event on
  // the server is an uncaught exception.
  server.on("error", (error) => {
    log.error("http server error", { error: String(error) });
  });

  const finished = new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });

  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping ??= (() => {
      server.close();
      server.closeIdleConnections();
      const force = setTimeout(
        () => server.closeAllConnections(),
        SHUTDOWN_GRACE_MS,
      );
      force.unref();
      return finished.finally(() => clearTimeout(force));
    })();
    return stopping;
  };

  return { port, finished, shutdown };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
  options: ServeOptions,
  boundPort: () => number,
): Promise<void> {
  try {
    let request: Request;
    try {
      request = await toRequest(req, options, boundPort());
    } catch (error) {
      log.warn("rejected a malformed request", { error: String(error) });
      await send(res, new Response("bad request", { status: 400 }));
      return;
    }

    let response: Response;
    try {
      response = await handler(request);
    } catch (error) {
      log.error("request handler failed", {
        method: req.method,
        url: req.url,
        error: error instanceof Error
          ? (error.stack ?? error.message)
          : String(error),
      });
      response = new Response("internal error", { status: 500 });
    }

    await send(res, response);
  } catch (error) {
    // The client went away mid-request or mid-response; there is nobody left
    // to answer.
    log.warn("could not complete a request", { error: String(error) });
    res.destroy();
  }
}

/**
 * Node gives the request target (`/path?query`) and the headers separately; a
 * web `Request` wants one absolute URL, so the origin is the `Host` header the
 * client sent, or the address we are bound to when it sent none.
 */
async function toRequest(
  req: IncomingMessage,
  options: ServeOptions,
  port: number,
): Promise<Request> {
  const origin = req.headers.host
    ? `http://${req.headers.host}`
    : `http://${options.hostname}:${port}`;
  const url = new URL(req.url ?? "/", origin).href;
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.append(name, value);
    }
  }

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Request(url, {
    method,
    headers,
    body: new Uint8Array(Buffer.concat(chunks)),
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const body = new Uint8Array(await response.arrayBuffer());

  const headers: string[] = [];
  for (const [name, value] of response.headers) headers.push(name, value);
  if (
    !BODYLESS_STATUSES.has(response.status) &&
    !response.headers.has("content-length") &&
    !response.headers.has("transfer-encoding")
  ) {
    headers.push("content-length", String(body.byteLength));
  }

  res.writeHead(response.status, headers);
  res.end(body);
}
