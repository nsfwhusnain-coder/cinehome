-- Durable per-title source memory.
--
-- ADDITIVE ONLY. Prisma originally emitted a RedefineTables block for
-- CachedStream alongside this, because CachedStream has pre-existing drift:
-- `provider`, `codec` and `container` were added to schema.prisma and applied
-- to the live database with `db push`, so they are absent from the migration
-- history. Replaying that block would DROP and recreate the live CachedStream
-- and silently reset those three columns to defaults. That drift is unrelated
-- to this feature and is left exactly as-is; only the new table is created.

-- CreateTable
CREATE TABLE "SourceMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tmdbId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "season" INTEGER NOT NULL DEFAULT 0,
    "episode" INTEGER NOT NULL DEFAULT 0,
    "sourceKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "decodedHeight" INTEGER,
    "codec" TEXT,
    "container" TEXT,
    "bitrateBps" INTEGER,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "shortPlayCount" INTEGER NOT NULL DEFAULT 0,
    "stallCount" INTEGER NOT NULL DEFAULT 0,
    "failStreak" INTEGER NOT NULL DEFAULT 0,
    "watchedMs" INTEGER NOT NULL DEFAULT 0,
    "ttffMsAvg" INTEGER,
    "lastGoodAt" DATETIME,
    "lastFailAt" DATETIME,
    "lastReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SourceMemory_tmdbId_mediaType_season_episode_idx" ON "SourceMemory"("tmdbId", "mediaType", "season", "episode");

-- CreateIndex
CREATE UNIQUE INDEX "SourceMemory_tmdbId_mediaType_season_episode_sourceKey_key" ON "SourceMemory"("tmdbId", "mediaType", "season", "episode", "sourceKey");
