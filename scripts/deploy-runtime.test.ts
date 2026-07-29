import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const helper = join(import.meta.dir, "deploy-runtime.sh");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runScenario(
  scenario: string,
  mode: "rollback" | "cutover" = "rollback"
) {
  const directory = mkdtempSync(join(tmpdir(), "cinehome-deploy-runtime-"));
  temporaryDirectories.push(directory);
  const fakeBin = join(directory, "bin");
  const log = join(directory, "docker.log");
  const state = join(directory, "image.state");
  mkdirSync(fakeBin);
  writeFileSync(state, "sha256:new\n");

  const fakeDocker = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$FAKE_LOG"
state="$(tr -d '\\r\\n' < "$FAKE_STATE")"

if [[ "$1" == "image" && "$2" == "tag" ]]; then
  [[ "$FAKE_SCENARIO" == "tag_fail" ]] && exit 41
  exit 0
fi

if [[ "$1" == "compose" && "$2" == "up" ]]; then
  if [[ " $* " == *" --no-build "* ]]; then
    [[ "$FAKE_SCENARIO" == "rollback_compose_fail" ]] && exit 42
    printf '%s\\n' 'sha256:old' > "$FAKE_STATE"
    exit 0
  fi
  [[ "$FAKE_SCENARIO" == "candidate_up_fail" ]] && exit 43
  printf '%s\\n' 'sha256:new' > "$FAKE_STATE"
  exit 0
fi

if [[ "$1" == "inspect" && "$*" == *"{{.Image}}"* ]]; then
  if [[ "$FAKE_SCENARIO" == "identity_mismatch" ]]; then
    printf '%s\\n' 'sha256:not-old'
  else
    cat "$FAKE_STATE"
  fi
  exit 0
fi

if [[ "$1" == "inspect" && "$*" == *"State.Health"* ]]; then
  if [[ "$FAKE_SCENARIO" == "rollback_health_fail" ]]; then
    printf '%s\\n' 'unhealthy'
  elif [[ "$FAKE_SCENARIO" == "candidate_health_fail" && "$state" == "sha256:new" ]]; then
    printf '%s\\n' 'unhealthy'
  else
    printf '%s\\n' 'healthy'
  fi
  exit 0
fi

if [[ "$1" == "inspect" && "$*" == *"RestartCount"* ]]; then
  printf '%s\\n' '0'
  exit 0
fi
if [[ "$1" == "inspect" && "$*" == *"OOMKilled"* ]]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && ( "$2" == "ps" || "$2" == "logs" ) ]]; then
  exit 0
fi
exit 44
`;
  const fakeCurl = "#!/usr/bin/env bash\nexit 0\n";
  writeFileSync(join(fakeBin, "docker"), fakeDocker);
  writeFileSync(join(fakeBin, "curl"), fakeCurl);
  chmodSync(join(fakeBin, "docker"), 0o755);
  chmodSync(join(fakeBin, "curl"), 0o755);

  const body =
    mode === "cutover"
      ? `
arm_cutover_rollback
if ! docker compose up -d; then
  exit 1
fi
if ! wait_for_runtime_health 1; then
  exit 1
fi
disarm_cutover_rollback
`
      : "rollback_live_image\n";
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
source "$DEPLOY_HELPER"
predeploy_tag="cinehome-cinehome:predeploy-test"
live_image_id="sha256:old"
DEPLOY_HEALTH_URL="http://cinehome.test"
HEALTH_REQUEST_MAX_SECONDS=1
HEALTH_POLL_INTERVAL_SECONDS=0.02
ROLLBACK_HEALTH_TIMEOUT_SECONDS=1
${body}`,
    ],
    {
      env: {
        ...process.env,
        DEPLOY_HELPER: helper,
        FAKE_LOG: log,
        FAKE_SCENARIO: scenario,
        FAKE_STATE: state,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    }
  );

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    log: readFileSync(log, "utf8"),
    state: readFileSync(state, "utf8").trim(),
  };
}

describe("behavioral deploy rollback", () => {
  test("restores and proves the exact old image without rebuilding", () => {
    const result = runScenario("success");

    expect(result.status).toBe(0);
    expect(result.state).toBe("sha256:old");
    expect(result.log).toContain(
      "compose up -d --no-deps --force-recreate --no-build cinehome"
    );
    expect(result.output).toContain("ROLLBACK OK:");
  });

  for (const [scenario, evidence] of [
    ["tag_fail", "could not retag"],
    ["rollback_compose_fail", "could not recreate"],
    ["identity_mismatch", "rollback image mismatch"],
    ["rollback_health_fail", "did not return to a healthy runtime"],
  ] as const) {
    test(`fails closed when ${scenario}`, () => {
      const result = runScenario(scenario);

      expect(result.status).not.toBe(0);
      expect(result.output).toContain(evidence);
      expect(result.output).not.toContain("ROLLBACK OK:");
    });
  }

  for (const scenario of ["candidate_up_fail", "candidate_health_fail"]) {
    test(`an armed ${scenario} exit restores the exact old image`, () => {
      const result = runScenario(scenario, "cutover");

      expect(result.status).not.toBe(0);
      expect(result.state).toBe("sha256:old");
      expect(result.output).toContain("ROLLBACK OK:");
      expect(result.output).not.toContain("CRITICAL:");
    });
  }
});
