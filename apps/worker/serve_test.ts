import assert from "node:assert/strict";
import { Agent, get as httpGet } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import {
  configureSync,
  type LogRecord,
  resetSync,
} from "@logtape/logtape";
import { type Handler, type Server, serve } from "./serve.ts";

/**
 * The worker's HTTP transport, over loopback with the real `fetch`.
 *
 * Every server a test starts goes through `withServer`, which shuts it down in
 * a `finally`, so the runner can exit on its own.
 */

const HOST = "127.0.0.1";

async function withServer(
  handler: Handler,
  fn: (server: Server, base: string) => Promise<void>,
): Promise<void> {
  const server = await serve({ port: 0, hostname: HOST }, handler);
  try {
    await fn(server, `http://${HOST}:${server.port}`);
  } finally {
    await server.shutdown();
  }
}

/** Send raw bytes and collect everything the server answers until it closes. */
function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: HOST });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => received += chunk);
    socket.on("error", reject);
    socket.on("close", () => resolve(received));
    socket.write(payload);
  });
}

/** Whatever the worker logs while a test runs, so the output stays quiet. */
function captureLogs(): { records: LogRecord[]; stop(): void } {
  const records: LogRecord[] = [];
  configureSync({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      { category: ["7r"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: null },
    ],
  });
  return { records, stop: () => resetSync() };
}

test("serve resolves once listening, on the port actually bound", async () => {
  await withServer(() => new Response("hello"), async (server, base) => {
    assert.equal(typeof server.port, "number");
    assert.ok(server.port > 0, `expected a bound port, got ${server.port}`);
    const response = await fetch(`${base}/x`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "hello");
  });
});

test("a port that is taken rejects with EADDRINUSE", async () => {
  await withServer(() => new Response("first"), async (first) => {
    const outcome = await serve({ port: first.port, hostname: HOST }, () =>
      new Response("second")).then(
        (server) => ({ server }),
        (error: unknown) => ({ error }),
      );
    if ("server" in outcome) await outcome.server.shutdown();
    assert.ok("error" in outcome, "serve must not resolve on a taken port");
    assert.equal((outcome.error as NodeJS.ErrnoException).code, "EADDRINUSE");
  });
});

test("the handler sees an absolute URL with path and query", async () => {
  const requests: Request[] = [];
  await withServer((request) => {
    requests.push(request);
    return new Response("ok");
  }, async (server, base) => {
    await fetch(`${base}/internal/thing?a=1&b=two`);
    assert.equal(requests.length, 1, "the handler was not called once");
    const url = new URL(requests[0].url);
    assert.equal(url.pathname, "/internal/thing");
    assert.equal(url.searchParams.get("a"), "1");
    assert.equal(url.searchParams.get("b"), "two");
    assert.equal(url.protocol, "http:");
    assert.equal(url.host, `${HOST}:${server.port}`);
  });
});

test("the handler sees the incoming method", async () => {
  const methods: string[] = [];
  await withServer((request) => {
    methods.push(request.method);
    return new Response(null, { status: 204 });
  }, async (_server, base) => {
    await fetch(`${base}/m`);
    await fetch(`${base}/m`, { method: "POST", body: "x" });
    await fetch(`${base}/m`, { method: "DELETE" });
    assert.deepStrictEqual(methods, ["GET", "POST", "DELETE"]);
  });
});

test("request headers are readable on the handler's Request", async () => {
  let token: string | null | undefined;
  await withServer((request) => {
    token = request.headers.get("x-internal-token");
    return new Response("ok");
  }, async (_server, base) => {
    await fetch(`${base}/h`, { headers: { "x-internal-token": "abc" } });
    assert.equal(token, "abc");
  });
});

test("without a Host header the origin is the listen hostname and port", async () => {
  const requests: Request[] = [];
  await withServer((request) => {
    requests.push(request);
    return new Response("ok");
  }, async (server) => {
    const answer = await rawExchange(
      server.port,
      "GET /nohost?q=1 HTTP/1.0\r\n\r\n",
    );
    assert.ok(answer.startsWith("HTTP/1.1 200"), `unexpected answer: ${answer}`);
    assert.equal(requests.length, 1, "the handler was not called once");
    const url = new URL(requests[0].url);
    assert.equal(url.origin, `http://${HOST}:${server.port}`);
    assert.equal(url.pathname, "/nohost");
    assert.equal(url.searchParams.get("q"), "1");
  });
});

test("a POST body is readable as JSON", async () => {
  let body: unknown;
  await withServer(async (request) => {
    body = await request.json();
    return new Response("ok");
  }, async (_server, base) => {
    await fetch(`${base}/b`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ discordId: "123" }),
    });
    assert.deepStrictEqual(body, { discordId: "123" });
  });
});

test("GET and HEAD requests carry no body", async () => {
  const bodies: [string, unknown][] = [];
  await withServer((request) => {
    bodies.push([request.method, request.body]);
    return new Response(null, { status: 204 });
  }, async (_server, base) => {
    await fetch(`${base}/g`);
    await fetch(`${base}/g`, { method: "HEAD" });
    assert.deepStrictEqual(bodies, [["GET", null], ["HEAD", null]]);
  });
});

test("status, headers and body of the Response reach the client unchanged", async () => {
  await withServer(
    () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "content-type": "application/json", "x-a": "1" },
      }),
    async (_server, base) => {
      const response = await fetch(`${base}/r`);
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("x-a"), "1");
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.equal(await response.text(), '{"ok":true}');
    },
  );
});

test("binary body bytes reach the client unchanged", async () => {
  const bytes = new Uint8Array([0, 255, 1, 128, 10, 13]);
  await withServer(() => new Response(bytes), async (_server, base) => {
    const response = await fetch(`${base}/bin`);
    assert.deepStrictEqual(
      new Uint8Array(await response.arrayBuffer()),
      bytes,
    );
  });
});

test("a 204 Response arrives as 204 with an empty body", async () => {
  await withServer(() => new Response(null, { status: 204 }), async (_s, base) => {
    const response = await fetch(`${base}/empty`);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  });
});

test("a handler that throws yields 500, is logged, and the server keeps serving", async () => {
  const logs = captureLogs();
  try {
    await withServer((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/boom") throw new Error("handler exploded");
      return new Response("fine");
    }, async (_server, base) => {
      const failed = await fetch(`${base}/boom`);
      assert.equal(failed.status, 500);
      await failed.text();
      assert.ok(
        logs.records.some((r) => r.category[0] === "7r"),
        "expected the error to be logged under the 7r root category",
      );
      const after = await fetch(`${base}/fine`);
      assert.equal(after.status, 200);
      assert.equal(await after.text(), "fine");
    });
  } finally {
    logs.stop();
  }
});

test("a handler that rejects yields 500, is logged, and the server keeps serving", async () => {
  const logs = captureLogs();
  try {
    await withServer((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/boom") return Promise.reject(new Error("rejected later"));
      return Promise.resolve(new Response("fine"));
    }, async (_server, base) => {
      const failed = await fetch(`${base}/boom`);
      assert.equal(failed.status, 500);
      await failed.text();
      assert.ok(
        logs.records.some((r) => r.category[0] === "7r"),
        "expected the error to be logged under the 7r root category",
      );
      const after = await fetch(`${base}/fine`);
      assert.equal(after.status, 200);
      assert.equal(await after.text(), "fine");
    });
  } finally {
    logs.stop();
  }
});

test("shutdown resolves finished, refuses new connections, and is idempotent", async () => {
  const server = await serve(
    { port: 0, hostname: HOST },
    () => new Response("up"),
  );
  const base = `http://${HOST}:${server.port}`;
  try {
    assert.equal((await fetch(`${base}/x`)).status, 200);
  } catch (error) {
    await server.shutdown();
    throw error;
  }

  await server.shutdown();
  await server.finished;
  await assert.rejects(fetch(`${base}/x`), "a new fetch should be refused");
  await server.shutdown();
});

test("shutdown completes while a client holds an idle keep-alive connection", async () => {
  const server = await serve(
    { port: 0, hostname: HOST },
    () => new Response("up"),
  );
  const agent = new Agent({ keepAlive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      httpGet({ host: HOST, port: server.port, path: "/x", agent }, (res) => {
        res.on("error", reject);
        res.on("end", resolve);
        res.resume();
      }).on("error", reject);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("shutdown hung on an idle keep-alive socket")),
        5000,
      );
    });
    try {
      await Promise.race([server.shutdown(), timeout]);
      await Promise.race([server.finished, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    agent.destroy();
    await server.shutdown();
  }
});
