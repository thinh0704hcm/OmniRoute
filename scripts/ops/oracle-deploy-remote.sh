#!/usr/bin/env bash
set -euo pipefail

# Fixed-path helper executed on oracle-vps by oracle-deploy.mjs. Runtime values
# arrive as argv, never interpolated into this script by the caller.
REPO_DIR="${OMNIROUTE_REPO_DIR:-/home/ubuntu/OmniRoute-src}"
DEPLOY_DIR="$REPO_DIR/contrib/vps"
BASE_COMPOSE="$DEPLOY_DIR/compose.yaml"
ORACLE_COMPOSE="$DEPLOY_DIR/compose.oracle.yaml"
CANARY_COMPOSE="$DEPLOY_DIR/compose.canary.yaml"
ENV_FILE="$DEPLOY_DIR/.env"
DATA_DIR="${OMNIROUTE_DATA_DIR:-/home/ubuntu/.omniroute}"
STATE_DIR="$DATA_DIR/deployments"
BACKUP_DIR="$STATE_DIR/backups"
LOCK_DIR="$STATE_DIR/deploy.lock"
CANARY_LOCK_DIR="$STATE_DIR/canary.lock"
CANARY_ROOT="${OMNIROUTE_CANARY_ROOT:-/home/ubuntu/.omniroute-canary}"
PROD_CONTAINER="omniroute-parallel"
CANARY_CONTAINER="omniroute-canary"
ROLLBACK_TAG="omniroute:rollback-canary"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_file() {
  test -f "$1" || fail "required file is missing: $1"
}

validate_image_ref() {
  case "$1" in
    *[!A-Za-z0-9_./:@-]*) fail "invalid image reference" ;;
  esac
}

validate_immutable_image_ref() {
  local image_ref="$1"
  local tag
  validate_image_ref "$image_ref"
  if [[ "$image_ref" =~ @sha256:[a-f0-9]{64}$ ]]; then
    return
  fi
  tag="${image_ref##*:}"
  case "${tag,,}" in
    latest|next|main|stable) fail "floating image references are forbidden" ;;
  esac
  [[ "$tag" =~ (^|[-_.])[a-f0-9]{7,40}([-_.]|$) ]] \
    || fail "image reference must contain an immutable Git SHA"
}

validate_sha() {
  case "$1" in
    ""|*[!a-f0-9]*) fail "invalid build SHA" ;;
  esac
  test "${#1}" -ge 7 || fail "build SHA is too short"
  test "${#1}" -le 40 || fail "build SHA is too long"
}

ensure_layout() {
  require_file "$BASE_COMPOSE"
  require_file "$ORACLE_COMPOSE"
  require_file "$CANARY_COMPOSE"
  require_file "$ENV_FILE"
  mkdir -p "$STATE_DIR" "$BACKUP_DIR" "$CANARY_ROOT"
}

require_compose_version() {
  local compose_version
  local minimum_version
  local first_version
  compose_version="$(docker compose version --short | sed 's/^v//')"
  minimum_version="2.24.4"
  first_version="$(printf '%s\n%s\n' "$minimum_version" "$compose_version" | sort -V | head -n 1)"
  test "$first_version" = "$minimum_version" \
    || fail "Docker Compose $minimum_version or newer is required (found $compose_version)"
}

canonical_canary_child() {
  local requested="$1"
  local root_path
  local child_path
  root_path="$(realpath -m -- "$CANARY_ROOT")"
  child_path="$(realpath -m -- "$requested")"
  case "$child_path" in
    "$root_path"/*) ;;
    *) fail "canary data directory is outside $root_path" ;;
  esac
  test "$child_path" != "$root_path" || fail "refusing broad canary directory"
  printf '%s\n' "$child_path"
}

compose_prod() {
  docker compose \
    --project-name omniroute \
    --project-directory "$DEPLOY_DIR" \
    --env-file "$ENV_FILE" \
    --file "$BASE_COMPOSE" \
    --file "$ORACLE_COMPOSE" \
    "$@"
}

compose_canary() {
  docker compose \
    --project-name omniroute-canary \
    --project-directory "$DEPLOY_DIR" \
    --env-file "$ENV_FILE" \
    --file "$BASE_COMPOSE" \
    --file "$CANARY_COMPOSE" \
    "$@"
}

backup_sqlite() {
  local source_path="$1"
  local destination_path="$2"
  python3 - "$source_path" "$destination_path" <<'PY'
import os
import sqlite3
import sys
import tempfile
from contextlib import closing

source_path, destination_path = sys.argv[1:3]
os.makedirs(os.path.dirname(destination_path), exist_ok=True)
if os.path.exists(destination_path):
    raise FileExistsError(f"refusing to overwrite backup: {destination_path}")
fd, temporary_path = tempfile.mkstemp(
    prefix=f".{os.path.basename(destination_path)}.",
    suffix=".partial",
    dir=os.path.dirname(destination_path),
)
os.close(fd)
try:
    with closing(sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)) as source, closing(
        sqlite3.connect(temporary_path)
    ) as destination:
        source.backup(destination)
        result = destination.execute("PRAGMA integrity_check").fetchone()
        if not result or result[0] != "ok":
            raise RuntimeError(f"backup integrity check failed: {result}")
    with open(temporary_path, "rb") as handle:
        os.fsync(handle.fileno())
    os.link(temporary_path, destination_path)
    os.unlink(temporary_path)
    directory_fd = os.open(os.path.dirname(destination_path), os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
except Exception:
    if os.path.exists(temporary_path):
        os.unlink(temporary_path)
    raise
PY
}

write_env_identity() {
  local image_ref="$1"
  local build_sha="$2"
  python3 - "$ENV_FILE" "$image_ref" "$build_sha" <<'PY'
import os
import sys
import tempfile

env_path, image_ref, build_sha = sys.argv[1:4]
with open(env_path, "r", encoding="utf-8") as handle:
    lines = handle.readlines()

replacements = {
    "OMNIROUTE_IMAGE": f"OMNIROUTE_IMAGE={image_ref}\n",
    "OMNIROUTE_BUILD_SHA": f"OMNIROUTE_BUILD_SHA={build_sha}\n",
}
found = set()
output = []
for line in lines:
    matched = next((key for key in replacements if line.startswith(f"{key}=")), None)
    if matched:
        if matched not in found:
            output.append(replacements[matched])
            found.add(matched)
        continue
    output.append(line)
if output and not output[-1].endswith("\n"):
    output[-1] += "\n"
for key, replacement in replacements.items():
    if key not in found:
        output.append(replacement)

fd, temp_path = tempfile.mkstemp(prefix=".env.", dir=os.path.dirname(env_path))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.writelines(output)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temp_path, 0o600)
    os.replace(temp_path, env_path)
finally:
    if os.path.exists(temp_path):
        os.unlink(temp_path)
PY
}

inspect_container_json() {
  local container="$1"
  docker inspect "$container" --format \
    '{"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"restartCount":{{json .RestartCount}},"status":{{json .State.Status}},"health":{{json .State.Health.Status}}}'
}

command="${1:-}"
shift || true

case "$command" in
  dispatch-json)
    python3 -c '
import json
import re
import subprocess
import sys

helper = sys.argv[1]
request = json.load(sys.stdin)
action = request.get("action")
values = request.get("values", [])
payload = request.get("payload")
if not isinstance(action, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", action):
    raise SystemExit("invalid dispatch action")
if not isinstance(values, list) or len(values) > 32 or not all(
    isinstance(value, str) and len(value) <= 8192 for value in values
):
    raise SystemExit("invalid dispatch values")
if payload is not None and (not isinstance(payload, str) or len(payload) > 1048576):
    raise SystemExit("invalid dispatch payload")
result = subprocess.run(
    ["bash", helper, action, *values],
    input=payload,
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=False,
)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
raise SystemExit(result.returncode)
' "$0"
    ;;

  preflight)
    ensure_layout
    require_compose_version
    compose_prod config --quiet
    printf '%s\n' "ok"
    ;;

  lock)
    ensure_layout
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
      fail "another deployment holds $LOCK_DIR"
    fi
    printf '%s\n' "$LOCK_DIR"
    ;;

  lock-canary)
    ensure_layout
    if ! mkdir "$CANARY_LOCK_DIR" 2>/dev/null; then
      fail "another qualification holds $CANARY_LOCK_DIR"
    fi
    printf '%s\n' "$CANARY_LOCK_DIR"
    ;;

  unlock)
    test -d "$LOCK_DIR" || exit 0
    rmdir "$LOCK_DIR"
    ;;

  unlock-canary)
    test -d "$CANARY_LOCK_DIR" || exit 0
    rmdir "$CANARY_LOCK_DIR"
    ;;

  inspect-image)
    image_ref="${1:-}"
    validate_image_ref "$image_ref"
    docker image inspect "$image_ref" --format \
      '{"imageId":{{json .Id}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"tags":{{json .RepoTags}}}'
    ;;

  inspect-prod)
    inspect_container_json "$PROD_CONTAINER"
    ;;

  inspect-canary)
    inspect_container_json "$CANARY_CONTAINER"
    ;;

  compose-hash)
    ensure_layout
    compose_prod config --format json | python3 -c '
import hashlib
import json
import sys

config = json.load(sys.stdin)
service = config.get("services", {}).get("omniroute", {})
service.pop("image", None)
environment = service.get("environment", {})
if isinstance(environment, dict):
    environment.pop("OMNIROUTE_BUILD_SHA", None)
    # Identity values are also imported through env_file. Excluding only
    # BUILD_SHA made the compose hash change after every image promotion,
    # blocking an otherwise valid immediate rollback.
    environment.pop("OMNIROUTE_IMAGE", None)
serialized = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
print(hashlib.sha256(serialized).hexdigest())
'
    ;;

  backup)
    ensure_layout
    stamp="$(date -u +%Y%m%dT%H%M%S%NZ)"
    destination="$BACKUP_DIR/storage_${stamp}_${BASHPID}_pre-promote.sqlite"
    backup_sqlite "$DATA_DIR/storage.sqlite" "$destination"
    printf '%s\n' "$destination"
    ;;

  prepare-canary)
    ensure_layout
    build_sha="${1:-}"
    validate_sha "$build_sha"
    canary_dir="$(mktemp -d "$CANARY_ROOT/${build_sha}.XXXXXX")"
    if ! backup_sqlite "$DATA_DIR/storage.sqlite" "$canary_dir/storage.sqlite"; then
      find "$canary_dir" -depth -delete
      fail "failed to prepare the canary database copy"
    fi
    if test -f "$DATA_DIR/server.env"; then
      install -m 600 "$DATA_DIR/server.env" "$canary_dir/server.env"
    fi
    printf '%s\n' "$canary_dir"
    ;;

  start-canary)
    ensure_layout
    image_ref="${1:-}"
    build_sha="${2:-}"
    canary_dir="${3:-}"
    validate_image_ref "$image_ref"
    validate_sha "$build_sha"
    canary_dir="$(canonical_canary_child "$canary_dir")"
    test -d "$canary_dir" || fail "canary data directory does not exist"
    OMNIROUTE_IMAGE="$image_ref" \
      OMNIROUTE_BUILD_SHA="$build_sha" \
      OMNIROUTE_CANARY_DATA_DIR="$canary_dir" \
      OMNIROUTE_RUNTIME_UID="$(id -u)" \
      OMNIROUTE_RUNTIME_GID="$(id -g)" \
      compose_canary up -d --wait --wait-timeout 180 --pull never
    ;;

  stop-canary)
    ensure_layout
    compose_canary down --volumes --remove-orphans || true
    ;;

  delete-canary-data)
    canary_dir="${1:-}"
    canary_dir="$(canonical_canary_child "$canary_dir")"
    if test -d "$canary_dir"; then
      find "$canary_dir" -depth -delete
    fi
    ;;

  call-log-max)
    database_path="${1:-$DATA_DIR/storage.sqlite}"
    python3 - "$database_path" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    row = connection.execute("SELECT COALESCE(MAX(timestamp), '') FROM call_logs").fetchone()
    print(row[0] if row else "")
finally:
    connection.close()
PY
    ;;

  combo-log-evidence)
    database_path="${1:-$DATA_DIR/storage.sqlite}"
    since_timestamp="${2:-}"
    python3 - "$database_path" "$since_timestamp" <<'PY'
import json
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    combo_rows, forbidden_preview_rows = connection.execute(
        """
        SELECT
          SUM(CASE WHEN combo_name IS NOT NULL AND combo_name != '' THEN 1 ELSE 0 END),
          SUM(CASE WHEN lower(COALESCE(model, '') || ' ' || COALESCE(requested_model, ''))
                        LIKE '%x-preview%'
                       AND lower(COALESCE(model, '')) != 'x-preview-f-free'
                   THEN 1 ELSE 0 END)
        FROM call_logs
        WHERE timestamp > ?
        """,
        (sys.argv[2],),
    ).fetchone()
    print(json.dumps({
        "comboRows": combo_rows or 0,
        "forbiddenPreviewRows": forbidden_preview_rows or 0,
    }))
finally:
    connection.close()
PY
    ;;

  reconcile-combos)
    ensure_layout
    ops_image_ref="${1:-}"
    requested_data_dir="${2:-}"
    validate_immutable_image_ref "$ops_image_ref"
    if test "$requested_data_dir" = "production"; then
      target_data_dir="$(realpath -m -- "$DATA_DIR")"
      runtime_user="1000:1000"
    else
      target_data_dir="$(canonical_canary_child "$requested_data_dir")"
      runtime_user="$(id -u):$(id -g)"
    fi
    test -f "$target_data_dir/storage.sqlite" || fail "target database does not exist"
    docker run --rm \
      --user "$runtime_user" \
      --network none \
      --read-only \
      --tmpfs /tmp:size=64m,mode=1777 \
      --volume "$target_data_dir:/app/data" \
      --workdir /app \
      "$ops_image_ref" \
      node scripts/ops/reconcile-canonical-combos.mjs \
        --db /app/data/storage.sqlite --apply --adopt --json
    docker run --rm \
      --user "$runtime_user" \
      --network none \
      --read-only \
      --tmpfs /tmp:size=64m,mode=1777 \
      --volume "$target_data_dir:/app/data" \
      --workdir /app \
      "$ops_image_ref" \
      node scripts/ops/reconcile-canonical-combos.mjs \
        --db /app/data/storage.sqlite --check --json
    ;;

  tag-rollback)
    expected_id="${1:-}"
    current_id="$(docker inspect "$PROD_CONTAINER" --format '{{.Image}}')"
    test "$current_id" = "$expected_id" || fail "production image changed before rollback tag"
    docker image tag "$expected_id" "$ROLLBACK_TAG"
    test "$(docker image inspect "$ROLLBACK_TAG" --format '{{.Id}}')" = "$expected_id" \
      || fail "rollback tag did not resolve to the expected image"
    ;;

  verify-rollback-tag)
    expected_id="${1:-}"
    test -n "$expected_id" || fail "expected rollback image ID is required"
    actual_id="$(docker image inspect "$ROLLBACK_TAG" --format '{{.Id}}')"
    test "$actual_id" = "$expected_id" \
      || fail "rollback tag no longer resolves to the recorded image ID"
    ;;

  set-image)
    ensure_layout
    image_ref="${1:-}"
    build_sha="${2:-}"
    if test "$image_ref" = "$ROLLBACK_TAG"; then
      validate_image_ref "$image_ref"
    else
      validate_immutable_image_ref "$image_ref"
    fi
    validate_sha "$build_sha"
    write_env_identity "$image_ref" "$build_sha"
    ;;

  recreate-prod)
    ensure_layout
    if docker container inspect "$PROD_CONTAINER" >/dev/null 2>&1; then
      compose_project="$(docker inspect "$PROD_CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}')"
      if test "$compose_project" != "omniroute"; then
        docker container rm --force "$PROD_CONTAINER" >/dev/null
      fi
    fi
    compose_prod up -d --wait --wait-timeout 180 --no-deps --pull never omniroute
    ;;

  verify-image)
    expected_id="${1:-}"
    actual_id="$(docker inspect "$PROD_CONTAINER" --format '{{.Image}}')"
    test "$actual_id" = "$expected_id"
    test "$(docker inspect "$PROD_CONTAINER" --format '{{.State.Status}}')" = "running"
    test "$(docker inspect "$PROD_CONTAINER" --format '{{.State.Health.Status}}')" = "healthy"
    test "$(docker inspect "$PROD_CONTAINER" --format '{{.RestartCount}}')" = "0"
    ;;

  write-manifest)
    ensure_layout
    manifest_path="$STATE_DIR/current.json"
    temp_path="$STATE_DIR/.current.json.tmp"
    python3 -c 'import json,sys; data=json.load(sys.stdin); assert data.get("schemaVersion") == 1; assert data.get("state") in {"pending", "active", "rolled_back"}; assert data.get("current", {}).get("imageId"); assert data.get("rollback", {}).get("imageId"); json.dump(data,sys.stdout,indent=2); print()' > "$temp_path"
    chmod 600 "$temp_path"
    mv "$temp_path" "$manifest_path"
    printf '%s\n' "$manifest_path"
    ;;

  read-manifest)
    require_file "$STATE_DIR/current.json"
    cat "$STATE_DIR/current.json"
    ;;

  status)
    ensure_layout
    inspect_container_json "$PROD_CONTAINER"
    timeout 15s docker system df || printf '%s\n' "docker system df timed out" >&2
    ;;

  *)
    fail "usage: $0 {dispatch-json|preflight|lock|unlock|lock-canary|unlock-canary|inspect-image|inspect-prod|inspect-canary|compose-hash|backup|prepare-canary|start-canary|stop-canary|delete-canary-data|call-log-max|combo-log-evidence|reconcile-combos|tag-rollback|verify-rollback-tag|set-image|recreate-prod|verify-image|write-manifest|read-manifest|status}"
    ;;
esac
