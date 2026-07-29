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

describe("authoritative production deploy", () => {
  test("refuses rsync and requires clean server Git main", () => {
    expect(deploy).toContain(
      "production deploys must run from server Git main with SKIP_RSYNC=1."
    );
    expect(deploy).not.toContain("rsync -az --delete");
    expect(deploy).toContain('DEPLOY_PATH}" != "/home/hussy/cinehome"');
    expect(deploy).toContain('git branch --show-current)" != "main"');
    expect(deploy).toContain("git status --porcelain --untracked-files=all");
  });

  test("succeeds only after Compose, app, and scraper are healthy", () => {
    const up = deploy.indexOf("docker compose up -d");
    const inspectHealth = deploy.indexOf("container_health=");
    const appHealth = deploy.indexOf(
      'curl -sf --max-time "${HEALTH_REQUEST_MAX_SECONDS}" "$DEPLOY_HEALTH_URL"'
    );
    const scraperHealth = deploy.indexOf(
      'docker exec cinehome curl -sf --max-time "${HEALTH_REQUEST_MAX_SECONDS}"'
    );
    const success = deploy.indexOf(
      "health OK (Compose app+scraper, HTTP, zero restarts/OOM)"
    );

    expect(inspectHealth).toBeGreaterThan(up);
    expect(appHealth).toBeGreaterThan(inspectHealth);
    expect(scraperHealth).toBeGreaterThan(appHealth);
    expect(success).toBeGreaterThan(scraperHealth);
    expect(deploy).toContain('container_health}" == "healthy"');
    expect(deploy).toContain('restart_count}" == "0"');
    expect(deploy).toContain('oom_killed}" == "false"');
    expect(deploy).toContain("health_deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))");
    expect(deploy).toContain("while (( SECONDS < health_deadline ))");
    expect(deploy).not.toContain('echo "health OK (HTTP)"');
  });
});
