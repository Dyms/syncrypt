// Live WebDAV backends for the conformance/e2e suites.
//
// Default (runs EVERYWHERE, no env needed): an in-process `webdav-server`
// instance — an independent, real WebDAV implementation speaking real HTTP on
// 127.0.0.1. Optionally, SYNCRYPT_WEBDAV_TEST_ENDPOINT(+_USER/_PASSWORD)
// points the same suites at an external server (CI adds an Apache mod_dav
// container as a second opinion).

import { v2 as webdav } from "webdav-server";

import type { WebDavConfig } from "../src/index.js";

export interface LiveDav {
  config: Omit<WebDavConfig, "transport">;
  stop(): Promise<void>;
}

const USER = "davuser";
const PASSWORD = "davpass";

export async function startLocalDav(): Promise<LiveDav> {
  const userManager = new webdav.SimpleUserManager();
  const user = userManager.addUser(USER, PASSWORD, false);
  const privileges = new webdav.SimplePathPrivilegeManager();
  privileges.setRights(user, "/", ["all"]);
  const server = new webdav.WebDAVServer({
    port: 0,
    httpAuthentication: new webdav.HTTPBasicAuthentication(userManager, "syncrypt-test"),
    privilegeManager: privileges,
    requireAuthentification: true,
  });
  const httpServer = await new Promise<{ address(): unknown }>((resolve) => {
    server.start((s) => {
      resolve(s as unknown as { address(): unknown });
    });
  });
  const address = httpServer.address() as { port: number };
  return {
    config: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      username: USER,
      password: PASSWORD,
      retry: { maxRetries: 2, baseDelayMs: 20, maxDelayMs: 200 },
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.stop(() => {
          resolve();
        });
      }),
  };
}

/** External server from env (optional; used by CI's Apache container). */
export function externalDavFromEnv(): Omit<WebDavConfig, "transport"> | null {
  const endpoint = process.env.SYNCRYPT_WEBDAV_TEST_ENDPOINT;
  if (endpoint === undefined || endpoint === "") return null;
  return {
    baseUrl: endpoint,
    username: process.env.SYNCRYPT_WEBDAV_TEST_USER ?? "davuser",
    password: process.env.SYNCRYPT_WEBDAV_TEST_PASSWORD ?? "davpass",
    retry: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 500 },
  };
}

export function randomPrefixKeyed(base: Omit<WebDavConfig, "transport">): Omit<WebDavConfig, "transport"> {
  const raw = crypto.getRandomValues(new Uint8Array(6));
  const dir = `syncrypt-test-${[...raw].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return { ...base, baseUrl: `${base.baseUrl.replace(/\/+$/, "")}/${dir}` };
}
