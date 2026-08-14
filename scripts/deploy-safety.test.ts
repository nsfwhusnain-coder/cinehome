import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const deploy = readFileSync(join(import.meta.dir, "deploy.sh"), "utf8");

describe("deploy rollback ordering", () => {
  test("tags the exact live image before Compose can retag latest", () => {
    const inspectLive = deploy.indexOf("live_image_id=");
    const assertMetadata = deploy.indexOf('docker image inspect "${live_image_id}"');
    const tagLive = deploy.indexOf('docker image tag "${live_image_id}" "${predeploy_tag}"');
    const build = deploy.indexOf("docker compose build");

    expect(inspectLive).toBeGreaterThan(0);
    expect(assertMetadata).toBeGreaterThan(inspectLive);
    expect(tagLive).toBeGreaterThan(assertMetadata);
    expect(build).toBeGreaterThan(tagLive);
  });

  test("fails closed when the live image metadata or rollback tag is unsafe", () => {
    expect(deploy).toContain("Reconstruct and prove a rollback image before building.");
    expect(deploy).toContain("refusing to overwrite existing rollback tag");
    expect(deploy).toContain("exit 1");
  });
});

describe("deploy rsync --delete excludes", () => {
  test("does not wipe remux cache, QA cookies, or runtime cache", () => {
    expect(deploy).toContain("--exclude 'transcode-cache/'");
    expect(deploy).toContain("--exclude '.browser-qa/'");
    expect(deploy).toContain("--exclude '.runtime-cache/'");
    expect(deploy).toContain("--exclude 'db-backups/'");
    expect(deploy).toContain("rsync -az --delete");
  });
});

describe("deploy sqlite backup and image prune", () => {
  test("snapshots SQLite before Compose can replace the container", () => {
    const backup = deploy.indexOf("./scripts/db-backup.sh");
    const build = deploy.indexOf("docker compose build");
    expect(backup).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(backup);
  });

  test("prunes dangling and old cinehome images only after health is OK", () => {
    const health = deploy.indexOf("health OK (HTTP)");
    const prune = deploy.indexOf("disk-prune.sh --dangling --keep-last-2-cinehome");
    expect(health).toBeGreaterThan(0);
    expect(prune).toBeGreaterThan(health);
    expect(deploy).not.toContain("--builder-all");
  });
});
