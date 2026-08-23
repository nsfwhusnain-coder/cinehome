/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { isSqliteLockError, withSqliteRetry } from "./db";
import { Prisma } from "@prisma/client";

describe("SQLite Lock Detection & Retry Logic", () => {
  it("correctly identifies transient SQLite lock errors", () => {
    expect(isSqliteLockError(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
    expect(isSqliteLockError(new Error("Error: database is locked"))).toBe(true);
    expect(isSqliteLockError(new Error("timed out waiting for database lock"))).toBe(true);
  });

  it("does NOT treat constraint violations (P2002, P2003) as lock errors", () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.0.0",
    });
    const p2003 = new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
      code: "P2003",
      clientVersion: "5.0.0",
    });
    expect(isSqliteLockError(p2002)).toBe(false);
    expect(isSqliteLockError(p2003)).toBe(false);
    expect(isSqliteLockError(new Error("Invalid JSON body"))).toBe(false);
  });

  it("retries transient lock errors and succeeds on subsequent attempt", async () => {
    let attempts = 0;
    const result = await withSqliteRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return "SUCCESS";
    }, 4);

    expect(result).toBe("SUCCESS");
    expect(attempts).toBe(3);
  });

  it("fails immediately without retrying for non-lock errors", async () => {
    let attempts = 0;
    try {
      await withSqliteRetry(async () => {
        attempts++;
        throw new Error("NON_LOCK_ERROR");
      }, 4);
    } catch (e: any) {
      expect(e.message).toBe("NON_LOCK_ERROR");
    }
    expect(attempts).toBe(1);
  });
});
