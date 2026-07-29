import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const deploy = readFileSync(join(import.meta.dir, "deploy.sh"), "utf8");
const runtime = readFileSync(
  join(import.meta.dir, "deploy-runtime.sh"),
  "utf8"
);

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
    const sourceHelpers = deploy.indexOf("source scripts/deploy-runtime.sh");
    const candidateUp = deploy.indexOf("if ! docker compose up -d; then");
    const healthFailure = deploy.indexOf(
      'if ! wait_for_runtime_health "${HEALTH_TIMEOUT_SECONDS}"; then'
    );

    expect(sourceHelpers).toBeGreaterThan(tagLive);
    expect(candidateUp).toBeGreaterThan(sourceHelpers);
    expect(healthFailure).toBeGreaterThan(candidateUp);
    expect(deploy).toContain("arm_cutover_rollback");
    expect(deploy).toContain("disarm_cutover_rollback");
    expect(deploy).not.toContain("rollback_live_image || true");
    expect(runtime).toContain("--force-recreate --no-build cinehome");
    expect(runtime).toContain(
      '[[ "${restored_image_id}" != "${live_image_id}" ]]'
    );
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
    expect(deploy).toContain(
      '[[ "${EXPECTED_REVISION}" != "${current_revision}" ]]'
    );
    expect(deploy).toContain("PREDEPLOY_SNAPSHOT_DIR");
    expect(deploy).toContain("sha256sum -c SHA256SUMS");
    expect(deploy).toContain("automatic db push is forbidden");
  });

  test("succeeds only after Compose, app, and scraper are healthy", () => {
    const up = deploy.indexOf("if ! docker compose up -d; then");
    const inspectHealth = runtime.indexOf("container_health=");
    const appHealth = runtime.indexOf(
      'curl -sf --max-time "${HEALTH_REQUEST_MAX_SECONDS}"'
    );
    const scraperHealth = runtime.indexOf(
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
    expect(runtime).toContain('container_health}" == "healthy"');
    expect(runtime).toContain('restart_count}" == "0"');
    expect(runtime).toContain('oom_killed}" == "false"');
    expect(runtime).toContain("local health_deadline=$((SECONDS + timeout_seconds))");
    expect(runtime).toContain("while (( SECONDS < health_deadline ))");
    expect(deploy).not.toContain('echo "health OK (HTTP)"');
  });

  test("stamps and verifies the exact Git revision in the running image", () => {
    const exportRevision = deploy.indexOf(
      'export CINEHOME_REVISION="${current_revision}"'
    );
    const build = deploy.indexOf("docker compose build");
    const inspectRevision = deploy.indexOf(
      "org.opencontainers.image.revision"
    );
    const revisionSuccess = deploy.indexOf("revision OK:");

    expect(exportRevision).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(exportRevision);
    expect(inspectRevision).toBeGreaterThan(build);
    expect(revisionSuccess).toBeGreaterThan(inspectRevision);
    expect(deploy).toContain(
      'if [[ "${deployed_revision}" != "${current_revision}" ]]; then'
    );
    expect(deploy).toContain("arm_cutover_rollback");
  });
});
