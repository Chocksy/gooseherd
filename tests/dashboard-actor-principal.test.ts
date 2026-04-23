import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { IncomingMessage } from "node:http";

import {
  resolveDashboardActorPrincipal,
  requireDashboardUserActor,
} from "../src/dashboard/actor-principal.js";
import { checkAuth } from "../src/dashboard/auth.js";

function makeMockReq(cookie?: string): IncomingMessage {
  return {
    headers: cookie ? { cookie } : {},
  } as unknown as IncomingMessage;
}

function makeMockRes() {
  return {
    statusCode: 200,
    setHeader() {},
    end() {},
  } as const;
}

test("user session resolves to a user dashboard principal", async () => {
  const req = makeMockReq("gooseherd-session=session-token");
  const sessionStore = {
    getSessionByToken: mock.fn(async (token: string) => token === "session-token"
      ? {
        id: "sess-1",
        principalType: "user",
        authMethod: "slack",
        userId: "user-123",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
      }
      : undefined),
  } as const;

  const principal = await resolveDashboardActorPrincipal(req, sessionStore);

  assert.deepEqual(principal, {
    principalType: "user",
    sessionId: "sess-1",
    authMethod: "slack",
    userId: "user-123",
  });
});

test("resolveDashboardActorPrincipal returns undefined without a cookie", async () => {
  const req = makeMockReq();
  const sessionStore = {
    getSessionByToken: mock.fn(async () => {
      throw new Error("should not be called");
    }),
  } as const;

  const principal = await resolveDashboardActorPrincipal(req, sessionStore);

  assert.equal(principal, undefined);
});

test("resolveDashboardActorPrincipal returns undefined without a session store", async () => {
  const req = makeMockReq("gooseherd-session=session-token");

  const principal = await resolveDashboardActorPrincipal(req);

  assert.equal(principal, undefined);
});

test("dashboard auth reuses a single request-scoped session lookup", async () => {
  const req = makeMockReq("gooseherd-session=session-token");
  const res = makeMockRes();
  let lookupCount = 0;
  const sessionStore = {
    getSessionByToken: async (token: string) => {
      lookupCount += 1;
      return token === "session-token"
        ? {
          id: "sess-1",
          principalType: "user",
          authMethod: "slack",
          userId: "user-123",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          lastSeenAt: new Date().toISOString(),
        }
        : undefined;
    },
  } as const;

  assert.equal(await checkAuth(req, res, { setupComplete: true, dashboardToken: "secret", sessionStore }, "/"), true);
  const principal = await resolveDashboardActorPrincipal(req, sessionStore);

  assert.deepEqual(principal, {
    principalType: "user",
    sessionId: "sess-1",
    authMethod: "slack",
    userId: "user-123",
  });
  assert.equal(lookupCount, 1);
});

test("admin password session resolves to an admin_session principal", async () => {
  const req = makeMockReq("gooseherd-session=session-token");
  const sessionStore = {
    getSessionByToken: mock.fn(async (token: string) => token === "session-token"
      ? {
        id: "sess-admin",
        principalType: "admin",
        authMethod: "admin_password",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
      }
      : undefined),
  } as const;

  const principal = await resolveDashboardActorPrincipal(req, sessionStore);

  assert.deepEqual(principal, {
    principalType: "admin_session",
    sessionId: "sess-admin",
    authMethod: "admin_password",
  });
});

test("user session without a userId resolves to undefined", async () => {
  const req = makeMockReq("gooseherd-session=session-token");
  const sessionStore = {
    getSessionByToken: mock.fn(async () => ({
      id: "sess-user",
      principalType: "user",
      authMethod: "slack",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      lastSeenAt: new Date().toISOString(),
    })),
  } as const;

  const principal = await resolveDashboardActorPrincipal(req, sessionStore);

  assert.equal(principal, undefined);
});

test("requireDashboardUserActor rejects admin_session principals", () => {
  assert.throws(
    () => requireDashboardUserActor({
      principalType: "admin_session",
      sessionId: "sess-admin",
      authMethod: "admin_password",
    }),
    /admin/i,
  );
});
