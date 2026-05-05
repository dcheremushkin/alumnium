import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserType,
  type Page,
} from "playwright-core";
import { FileStore } from "../FileStore/FileStore.ts";
import { GlobalFileStorePaths } from "../FileStore/GlobalFileStorePaths.ts";
import { getLogger, setLogPath } from "../utils/logger.ts";
import { sleep } from "../utils/timers.ts";

export const defaultCliDaemonSession = "default";

const logger = getLogger(import.meta.url);
const SOCKET_CONNECT_TIMEOUT_MS = 5000;
const WAIT_POLL_INTERVAL_MS = 200;

interface RunCliDaemonOptions {
  session: string;
  browser: string;
  headless: boolean;
}

interface WireMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

interface WireResponse {
  id?: number;
  result?: string;
  error?: string;
}

export interface CliDaemonConnection {
  send(method: string, params?: Record<string, unknown>): Promise<WireResponse>;
  close(): void;
}

export async function runCliDaemon(
  options: RunCliDaemonOptions,
): Promise<void> {
  setLogPath({ filename: `cli-${new Date().toISOString().slice(0, 19)}.log` });

  const browserType = browserTypeForName(options.browser);
  const browser = await browserType.launch({ headless: options.headless });
  const artifactsStore = new FileStore(
    GlobalFileStorePaths.globalSubDir(`artifacts/${options.session}`),
  );
  const context = await browser.newContext({
    recordVideo: { dir: await artifactsStore.ensureDir("videos") },
  });
  const page = await context.newPage();
  const socketPath = socketPathForCliDaemonSession(options.session);

  await prepareSocketPath(socketPath);
  const server = net.createServer((socket) => {
    socket.setEncoding("utf-8");
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        void handleMessage(socket, page, line);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  logger.info(`Browser daemon listening on ${socketPath}`);

  const cleanup = async () => {
    server.close();
    await fs.rm(socketPath, { force: true }).catch(() => null);
    await browser.close().catch(() => null);
  };

  process.once("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.once("exit", () => {
    server.close();
  });

  await new Promise(() => {});
}

export async function waitForCliDaemon(
  session: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const connection = await connectToCliDaemon(session);
      const response = await connection.send("ping");
      connection.close();
      if (!response.error) return true;
    } catch {}
    await sleep(WAIT_POLL_INTERVAL_MS);
  }
  return false;
}

export async function connectToCliDaemon(
  session: string,
): Promise<CliDaemonConnection> {
  const socketPath = socketPathForCliDaemonSession(session);
  const socket = await connect(socketPath);
  let nextId = 0;
  let buffer = "";
  const pending: Record<
    number,
    {
      resolve: (response: WireResponse) => void;
      reject: (error: Error) => void;
    }
  > = {};

  socket.setEncoding("utf-8");
  socket.on("data", (data) => {
    buffer += data;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const response = JSON.parse(line) as WireResponse;
      if (response.id == null) continue;
      const entry = pending[response.id];
      if (!entry) continue;
      delete pending[response.id];
      entry.resolve(response);
    }
  });
  socket.on("error", (error) => {
    for (const id of Object.keys(pending)) {
      pending[Number(id)]?.reject(error);
      delete pending[Number(id)];
    }
  });

  return {
    send(method, params = {}) {
      const id = ++nextId;
      const message: WireMessage = { id, method, params };
      return new Promise((resolve, reject) => {
        pending[id] = { resolve, reject };
        socket.write(`${JSON.stringify(message)}\n`);
      });
    },

    close() {
      socket.end();
    },
  };
}

export function socketPathForCliDaemonSession(session: string): string {
  if (process.platform === "win32") {
    const cwdHash = Buffer.from(process.cwd()).toString("base64url");
    return `\\\\.\\pipe\\alumnium-cli-${cwdHash}-${session}`.replace(
      /[^a-zA-Z0-9_.\\-]/g,
      "_",
    );
  }

  return path.resolve(
    GlobalFileStorePaths.globalSubDir(`sessions/${session}.sock`),
  );
}

async function handleMessage(
  socket: net.Socket,
  page: Page,
  line: string,
): Promise<void> {
  const message = JSON.parse(line) as WireMessage;

  try {
    if (message.method === "ping") {
      send(socket, responseFor(message.id, { result: "ok" }));
      return;
    }

    if (message.method === "do") {
      const goal = String(message.params?.goal ?? "");
      const result = await runGoal(page, goal);
      send(socket, responseFor(message.id, { result }));
      return;
    }

    throw new Error(`Unknown method: ${message.method}`);
  } catch (error) {
    send(
      socket,
      responseFor(message.id, {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function runGoal(page: Page, goal: string): Promise<string> {
  const navigationUrl = navigationUrlForGoal(goal);
  if (!navigationUrl) throw new Error(`Unknown goal: ${goal}`);

  logger.info(`Navigating to ${navigationUrl}`);
  await page.goto(navigationUrl);
  return `Navigated to ${navigationUrl}`;
}

export function navigationUrlForGoal(goal: string): string | null {
  const url = goal.replace(/^(navigate to|go to)\s+/i, "").trim();
  if (url === goal.trim()) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  return `https://${url}`;
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await fs.rm(socketPath, { force: true });
}

async function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setTimeout(SOCKET_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${socketPath}`));
    });
  });
}

function send(socket: net.Socket, response: WireResponse): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

function responseFor(
  id: number | undefined,
  response: Omit<WireResponse, "id">,
): WireResponse {
  if (id == null) return response;
  return { id, ...response };
}

function browserTypeForName(name: string): BrowserType<Browser> {
  if (name === "chromium") return chromium;
  if (name === "firefox") return firefox;
  if (name === "webkit") return webkit;
  throw new Error(`Unsupported browser: ${name}`);
}
