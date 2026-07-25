/// <reference types="bun-types" />
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Unit coverage for the Settings "Real-Debrid Premium" credential helpers.
 *
 * `ENV_TOKEN_AT_BOOT` is captured at module load, so every test that needs a
 * different boot-time env loads a FRESH copy of the module via a cache-busted
 * dynamic import (specifier built at runtime so tsc doesn't try to resolve
 * the query-string form). `@/lib/db` is mocked module-wide with an in-memory
 * AppSetting store; global fetch is stubbed per test.
 *
 * SECURITY invariant tested here: the raw token must never appear anywhere in
 * a `getRealDebridStatus()` result — that object is what the admin API
 * serializes to clients.
 *
 * (The GET /api/settings SECRET_KEYS exclusion is NOT wired here: the route
 * pulls in next-auth + playback providers, too heavy to mock meaningfully in
 * a unit test. Covered by review + the route's own SECRET_KEYS guard.)
 */

type CredentialsModule = typeof import("./debrid-credentials");

// ---------------------------------------------------------------------------
// @/lib/db mock — in-memory AppSetting table, failure-injectable.
// ---------------------------------------------------------------------------
const dbStore = new Map<string, string>();
let dbShouldFail = false;

mock.module("@/lib/db", () => ({
  db: {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (dbShouldFail) throw new Error("db unavailable");
        const value = dbStore.get(where.key);
        return value === undefined ? null : { id: "row", key: where.key, value };
      },
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { key: string };
        update: { value: string };
        create: { key: string; value: string };
      }) => {
        if (dbShouldFail) throw new Error("db unavailable");
        const next = dbStore.has(where.key) ? update.value : create.value;
        dbStore.set(where.key, next);
        return { id: "row", key: where.key, value: next };
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        if (dbShouldFail) throw new Error("db unavailable");
        const count = dbStore.delete(where.key) ? 1 : 0;
        return { count };
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const KEY = "realdebrid_token";
const originalFetch = globalThis.fetch;
const originalCanonical = process.env.REAL_DEBRID_API_TOKEN;
const originalAlias = process.env.REALDEBRID_TOKEN;

let importCounter = 0;

/** Load a FRESH module copy with the given boot-time env (both vars controlled). */
async function loadModule(env: {
  canonical?: string;
  alias?: string;
}): Promise<CredentialsModule> {
  if (env.canonical !== undefined) process.env.REAL_DEBRID_API_TOKEN = env.canonical;
  else delete process.env.REAL_DEBRID_API_TOKEN;
  if (env.alias !== undefined) process.env.REALDEBRID_TOKEN = env.alias;
  else delete process.env.REALDEBRID_TOKEN;
  const specifier = "./debrid-credentials.ts" + `?fresh=${++importCounter}`;
  return (await import(specifier)) as CredentialsModule;
}

let fetchCalls: number;

function stubFetchJson(status: number, body: unknown): void {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
}

function stubFetchNetworkFailure(): void {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("network down");
  }) as typeof fetch;
}

const FUTURE_ISO = new Date(Date.now() + 30 * 86_400_000).toISOString();
const PAST_ISO = new Date(Date.now() - 3 * 86_400_000).toISOString();

const PREMIUM_USER = {
  username: "hussy04",
  type: "premium",
  premium: 1_293_685,
  points: 150,
  expiration: FUTURE_ISO,
};

beforeEach(() => {
  dbStore.clear();
  dbShouldFail = false;
  fetchCalls = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalCanonical === undefined) delete process.env.REAL_DEBRID_API_TOKEN;
  else process.env.REAL_DEBRID_API_TOKEN = originalCanonical;
  if (originalAlias === undefined) delete process.env.REALDEBRID_TOKEN;
  else process.env.REALDEBRID_TOKEN = originalAlias;
});

// ---------------------------------------------------------------------------
// getEffectiveRealDebridToken — precedence
// ---------------------------------------------------------------------------
describe("getEffectiveRealDebridToken — precedence", () => {
  it("DB token wins over the boot-time env token", async () => {
    dbStore.set(KEY, "DBTOKEN111111111111111111");
    const m = await loadModule({ canonical: "ENVTOKEN22222222222222222" });
    expect(await m.getEffectiveRealDebridToken()).toEqual({
      token: "DBTOKEN111111111111111111",
      source: "database",
    });
  });

  it("falls back to the boot-time env token when the DB has none", async () => {
    const m = await loadModule({ canonical: "ENVTOKEN22222222222222222" });
    expect(await m.getEffectiveRealDebridToken()).toEqual({
      token: "ENVTOKEN22222222222222222",
      source: "env",
    });
  });

  it("honors the REALDEBRID_TOKEN alias when the canonical var is unset", async () => {
    const m = await loadModule({ alias: "ALIASTOKEN333333333333333" });
    expect(await m.getEffectiveRealDebridToken()).toEqual({
      token: "ALIASTOKEN333333333333333",
      source: "env",
    });
  });

  it("returns none when neither DB nor env has a token", async () => {
    const m = await loadModule({});
    expect(await m.getEffectiveRealDebridToken()).toEqual({ token: null, source: "none" });
  });

  it("a whitespace-only DB value is treated as missing (env fallback)", async () => {
    dbStore.set(KEY, "   ");
    const m = await loadModule({ canonical: "ENVTOKEN22222222222222222" });
    expect((await m.getEffectiveRealDebridToken()).source).toBe("env");
  });

  it("DB failure falls back to env instead of throwing", async () => {
    const m = await loadModule({ canonical: "ENVTOKEN22222222222222222" });
    dbShouldFail = true;
    expect(await m.getEffectiveRealDebridToken()).toEqual({
      token: "ENVTOKEN22222222222222222",
      source: "env",
    });
  });
});

// ---------------------------------------------------------------------------
// syncRealDebridTokenToEnv
// ---------------------------------------------------------------------------
describe("syncRealDebridTokenToEnv", () => {
  it("mirrors the DB token into process.env and reports the source", async () => {
    dbStore.set(KEY, "DBTOKEN111111111111111111");
    const m = await loadModule({ canonical: "ENVTOKEN22222222222222222" });
    expect(await m.syncRealDebridTokenToEnv()).toBe("database");
    expect(process.env.REAL_DEBRID_API_TOKEN).toBe("DBTOKEN111111111111111111");
  });

  it("with no token anywhere, clears the env var and reports none", async () => {
    const m = await loadModule({});
    expect(await m.syncRealDebridTokenToEnv()).toBe("none");
    expect(process.env.REAL_DEBRID_API_TOKEN).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getRealDebridStatus — status mapping
// ---------------------------------------------------------------------------
describe("getRealDebridStatus — status mapping", () => {
  it("(a) valid premium account maps to active premium status", async () => {
    dbStore.set(KEY, "DBTOKEN111111111111111111");
    const m = await loadModule({});
    stubFetchJson(200, PREMIUM_USER);
    const s = await m.getRealDebridStatus();
    expect(s).toEqual({
      configured: true,
      source: "database",
      valid: true,
      premium: true,
      username: "hussy04",
      expiresAt: FUTURE_ISO,
      points: 150,
      accountType: "premium",
      error: null,
    });
  });

  it("(b) past expiration → valid but NOT premium", async () => {
    dbStore.set(KEY, "DBTOKEN111111111111111111");
    const m = await loadModule({});
    stubFetchJson(200, { ...PREMIUM_USER, expiration: PAST_ISO });
    const s = await m.getRealDebridStatus();
    expect(s.valid).toBe(true);
    expect(s.premium).toBe(false);
    expect(s.expiresAt).toBe(PAST_ISO);
  });

  it("(b2) zero premium seconds → NOT premium", async () => {
    dbStore.set(KEY, "DBTOKEN111111111111111111");
    const m = await loadModule({});
    stubFetchJson(200, { ...PREMIUM_USER, premium: 0 });
    expect((await m.getRealDebridStatus()).premium).toBe(false);
  });

  it("(b3) free account type → NOT premium", async () => {
    dbStore.set(KEY, "DBTOKEN111111111111111111");
    const m = await loadModule({});
    stubFetchJson(200, { ...PREMIUM_USER, type: "free" });
    const s = await m.getRealDebridStatus();
    expect(s.valid).toBe(true);
    expect(s.premium).toBe(false);
    expect(s.accountType).toBe("free");
  });

  it("(c) HTTP 401 → configured but invalid, with an invalid/expired message", async () => {
    dbStore.set(KEY, "DBTOKEN111111111111111111");
    const m = await loadModule({});
    stubFetchJson(401, { error: "bad_token" });
    const s = await m.getRealDebridStatus();
    expect(s.configured).toBe(true);
    expect(s.valid).toBe(false);
    expect(s.premium).toBe(false);
    expect(s.error).toMatch(/invalid or expired/i);
  });

  it("(d) network failure → invalid with a reachability message", async () => {
    dbStore.set(KEY, "DBTOKEN111111111111111111");
    const m = await loadModule({});
    stubFetchNetworkFailure();
    const s = await m.getRealDebridStatus();
    expect(s.configured).toBe(true);
    expect(s.valid).toBe(false);
    expect(s.error).toMatch(/could not reach/i);
  });

  it("(e) no token anywhere → not configured, and NO network call is made", async () => {
    const m = await loadModule({});
    stubFetchJson(200, PREMIUM_USER);
    const s = await m.getRealDebridStatus();
    expect(s).toEqual({
      configured: false,
      source: "none",
      valid: false,
      premium: false,
      username: null,
      expiresAt: null,
      points: null,
      accountType: null,
      error: null,
    });
    expect(fetchCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// save / clear
// ---------------------------------------------------------------------------
describe("saveRealDebridToken / clearRealDebridToken", () => {
  it("save upserts the DB row AND activates the token in process.env", async () => {
    const m = await loadModule({ canonical: "ENVTOKEN22222222222222222" });
    await m.saveRealDebridToken("NEWTOKEN4444444444444444444");
    expect(dbStore.get(KEY)).toBe("NEWTOKEN4444444444444444444");
    expect(process.env.REAL_DEBRID_API_TOKEN).toBe("NEWTOKEN4444444444444444444");
  });

  it("save overwrites an existing DB row", async () => {
    dbStore.set(KEY, "OLDTOKEN5555555555555555555");
    const m = await loadModule({});
    await m.saveRealDebridToken("NEWTOKEN4444444444444444444");
    expect(dbStore.get(KEY)).toBe("NEWTOKEN4444444444444444444");
  });

  it("clear deletes the DB row and reverts process.env to the boot-time value", async () => {
    dbStore.set(KEY, "DBTOKEN111111111111111111");
    const m = await loadModule({ canonical: "ENVTOKEN22222222222222222" });
    await m.syncRealDebridTokenToEnv(); // env now holds the DB token
    expect(process.env.REAL_DEBRID_API_TOKEN).toBe("DBTOKEN111111111111111111");

    await m.clearRealDebridToken();
    expect(dbStore.has(KEY)).toBe(false);
    expect(process.env.REAL_DEBRID_API_TOKEN).toBe("ENVTOKEN22222222222222222");
  });

  it("clear with no boot-time env token leaves the env var empty", async () => {
    dbStore.set(KEY, "DBTOKEN111111111111111111");
    const m = await loadModule({});
    await m.syncRealDebridTokenToEnv();
    await m.clearRealDebridToken();
    expect(process.env.REAL_DEBRID_API_TOKEN).toBe("");
  });
});

// ---------------------------------------------------------------------------
// SECURITY — the raw token never appears in a status object
// ---------------------------------------------------------------------------
describe("SECURITY — token never leaks through getRealDebridStatus", () => {
  const SECRET = "SUPERSECRETTOKEN66666666666666666666";

  it("valid-account status contains the token in no property value", async () => {
    dbStore.set(KEY, SECRET);
    const m = await loadModule({});
    stubFetchJson(200, PREMIUM_USER);
    const serialized = JSON.stringify(await m.getRealDebridStatus());
    expect(serialized.includes(SECRET)).toBe(false);
  });

  it("invalid-token (401) status contains the token in no property value", async () => {
    dbStore.set(KEY, SECRET);
    const m = await loadModule({});
    stubFetchJson(401, { error: "bad_token" });
    const serialized = JSON.stringify(await m.getRealDebridStatus());
    expect(serialized.includes(SECRET)).toBe(false);
  });

  it("network-failure status contains the token in no property value", async () => {
    dbStore.set(KEY, SECRET);
    const m = await loadModule({});
    stubFetchNetworkFailure();
    const serialized = JSON.stringify(await m.getRealDebridStatus());
    expect(serialized.includes(SECRET)).toBe(false);
  });

  it("env-sourced token also never appears in the status object", async () => {
    const m = await loadModule({ canonical: SECRET });
    stubFetchJson(200, PREMIUM_USER);
    const serialized = JSON.stringify(await m.getRealDebridStatus());
    expect(serialized.includes(SECRET)).toBe(false);
  });
});
