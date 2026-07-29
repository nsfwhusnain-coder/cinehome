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

  test("automatically restores the tagged live image when startup or health fails", () => {
    const tagLive = deploy.indexOf(
      'docker image tag "${live_image_id}" "${predeploy_tag}"'
    );
    const rollbackFunction = deploy.indexOf("rollback_live_image()");
    const restoreLatest = deploy.indexOf(
      'docker image tag "${predeploy_tag}" cinehome-cinehome:latest'
    );
    const forceRecreate = deploy.indexOf(
      "docker compose up -d --no-deps --force-recreate cinehome"
    );
    const candidateUp = deploy.indexOf("if ! docker compose up -d; then");
    const healthFailure = deploy.indexOf(
      'if ! wait_for_runtime_health "${HEALTH_TIMEOUT_SECONDS}"; then'
    );

    expect(rollbackFunction).toBeGreaterThan(tagLive);
    expect(restoreLatest).toBeGreaterThan(rollbackFunction);
    expect(forceRecreate).toBeGreaterThan(restoreLatest);
    expect(candidateUp).toBeGreaterThan(forceRecreate);
    expect(healthFailure).toBeGreaterThan(candidateUp);
    expect(deploy.match(/rollback_live_image \|\| true/g)?.length).toBe(2);
    expect(deploy).toContain("ROLLBACK OK:");
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
    const up = deploy.indexOf("if ! docker compose up -d; then");
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
    const candidateHealth = deploy.indexOf(
      'if ! wait_for_runtime_health "${HEALTH_TIMEOUT_SECONDS}"; then'
    );

    expect(inspectHealth).toBeGreaterThan(0);
    expect(appHealth).toBeGreaterThan(inspectHealth);
    expect(scraperHealth).toBeGreaterThan(appHealth);
    expect(candidateHealth).toBeGreaterThan(up);
    expect(success).toBeGreaterThan(candidateHealth);
    expect(deploy).toContain('container_health}" == "healthy"');
    expect(deploy).toContain('restart_count}" == "0"');
    expect(deploy).toContain('oom_killed}" == "false"');
    expect(deploy).toContain("local health_deadline=$((SECONDS + timeout_seconds))");
    expect(deploy).toContain("while (( SECONDS < health_deadline ))");
    expect(deploy).not.toContain('echo "health OK (HTTP)"');
  });
});
