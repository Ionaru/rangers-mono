import { getWorkerClientConfig } from "@7r/config";

/**
 * How `web` talks to the worker. The only coupling between the two services
 * beyond the database (ARCHITECTURE §2).
 *
 * It exists because the TeamSpeak link flow needs the live ServerQuery
 * connection, and that connection is stateful and singular, so it lives in one
 * process. This is the website asking that process a question.
 *
 * Synchronous and loud, on purpose: **if the worker is down, linking fails with
 * an error the member can see.** The tempting alternative, catching the failure
 * and rendering an empty list, would tell them "you are not connected to
 * TeamSpeak" when the truth is "our TeamSpeak connection is broken", and they
 * would spend the evening reconnecting a client that was never the problem
 * (IMPLEMENTATION §4).
 */

/** The worker is unreachable, or answered with something we cannot use. */
export class WorkerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkerUnavailableError";
  }
}

export interface OnlineClient {
  /** The connection id, which the poke is addressed to. Ephemeral. */
  clid: string;
  /** The identity, which gets stored on the member. Durable. */
  uid: string;
  nickname: string;
}

async function callWorker<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { WORKER_INTERNAL_URL, WORKER_INTERNAL_TOKEN } =
    getWorkerClientConfig();

  let response: Response;
  try {
    response = await fetch(`${WORKER_INTERNAL_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${WORKER_INTERNAL_TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      // A member is staring at a spinner. The worker is one hop away on the
      // Compose network, so if it has not answered in five seconds it is not
      // going to.
      signal: AbortSignal.timeout(5_000),
    });
  } catch (cause) {
    throw new WorkerUnavailableError(
      "the worker did not respond, so TeamSpeak is unreachable",
      { cause },
    );
  }

  if (!response.ok) {
    throw new WorkerUnavailableError(
      `the worker answered ${response.status} for ${path}`,
    );
  }

  return await response.json() as T;
}

/** The online TeamSpeak clients a member may claim as themselves. */
export async function fetchOnlineClients(): Promise<OnlineClient[]> {
  const body = await callWorker<{ clients: OnlineClient[] }>(
    "/internal/ts/clients",
  );
  return body.clients;
}

/** Poke the code at the connection the member picked. */
export async function pokeLinkCode(
  clid: string,
  message: string,
): Promise<void> {
  await callWorker("/internal/ts/poke", {
    method: "POST",
    body: JSON.stringify({ clid, message }),
  });
}
