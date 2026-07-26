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
