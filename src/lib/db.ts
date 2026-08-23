import { PrismaClient, Prisma } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pragmasInitialized: boolean | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query'] : [],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

/**
 * Enforce WAL mode, busy timeout (5000ms), and NORMAL synchronous mode for SQLite.
 */
export async function ensureSqlitePragmas(): Promise<void> {
  if (globalForPrisma.pragmasInitialized) return;
  try {
    const rawExec = (db as any)[''];
    if (typeof rawExec === 'function') {
      await rawExec.call(db, 'PRAGMA journal_mode = WAL;');
      await rawExec.call(db, 'PRAGMA busy_timeout = 5000;');
      await rawExec.call(db, 'PRAGMA synchronous = NORMAL;');
    }
    globalForPrisma.pragmasInitialized = true;
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[db] PRAGMA initialization warning:', err);
    }
  }
}

if (typeof window === 'undefined') {
  void ensureSqlitePragmas();
}

/**
 * Checks if an error is a genuine transient SQLite lock contention error.
 * Does NOT treat P2002 / P2003 (constraint failures) as lock errors.
 */
export function isSqliteLockError(error: unknown): boolean {
  if (!error) return false;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code);
    if (code === 'P2034') return true;
    if (code === 'P2002' || code === 'P2003') return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('SQLITE_BUSY') ||
    message.includes('database is locked') ||
    message.includes('database table is locked') ||
    message.includes('timed out waiting for database')
  );
}

/**
 * Bounded exponential backoff retry helper specifically for transient SQLite lock contention.
 */
export async function withSqliteRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 4
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !isSqliteLockError(error)) {
        throw error;
      }
      const baseDelay = attempt === 1 ? 25 : attempt === 2 ? 75 : 200;
      const jitter = Math.floor(Math.random() * (baseDelay * 0.5));
      const delayMs = baseDelay + jitter;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
