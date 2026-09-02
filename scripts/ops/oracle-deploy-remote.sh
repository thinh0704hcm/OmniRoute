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
TS_GATEWAY_CONTAINER="ts-gateway"
TS_GATEWAY_STATE_DIR="${TS_GATEWAY_STATE_DIR:-/home/ubuntu/ts-gateway/state}"
TS_GATEWAY_ROLLBACK_TAG="ts-gateway:rollback"
TS_GATEWAY_IMAGE="docker.io/tailscale/tailscale@sha256:fdbdb434c50a6d3a5ed73f2b15ef66228dd2d265c1729e55f9a663ae804c5453"

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
    '{"containerName":{{json .Name}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"restartCount":{{json .RestartCount}},"status":{{json .State.Status}},"health":{{json .State.Health.Status}},"oomKilled":{{json .State.OOMKilled}},"memoryBytes":{{json .HostConfig.Memory}},"nanoCpus":{{json .HostConfig.NanoCpus}}}'
}

# Tailscale state belongs to the managed container. Never use a host daemon:
# a host-level tailscale process may be a different tailnet and would make a
# successful-looking promotion route traffic to the wrong machine.
run_ts() {
  docker exec "$TS_GATEWAY_CONTAINER" tailscale "$@"
}

normalize_json_file() {
  python3 - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)

def normalize(value):
    if isinstance(value, dict):
        return {key: normalize(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value

print(json.dumps(normalize(value), sort_keys=True, separators=(",", ":")))
PY
}

gateway_config_is_exact() {
  python3 - "$1" <<'PY'
import json
import sys

try:
    actual = json.loads(sys.argv[1])
except Exception as exc:
    raise SystemExit(f"malformed Tailscale Serve JSON: {exc}")
expected = {
    "TCP": {"443": {"HTTPS": True}},
    "Web": {
        "squrvq.tail0bec0f.ts.net:443": {
            "Handlers": {
                "/": {"Proxy": "http://127.0.0.1:20131"},
                "/healthz": {"Proxy": "http://127.0.0.1:20130"},
                "/live-ws": {"Proxy": "http://127.0.0.1:20130"},
            }
        }
    },
    "AllowFunnel": {"squrvq.tail0bec0f.ts.net:443": True},
}
if actual != expected:
    raise SystemExit("Tailscale Serve/Funnel configuration is not the exact squrvq contract")
PY
}

verify_gateway_runtime() {
  local expected_image="$1"
  local inspect_json
  inspect_json="$(docker inspect "$TS_GATEWAY_CONTAINER" --format \
    '{"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"networkMode":{{json .HostConfig.NetworkMode}},"mounts":{{json .Mounts}}}')"
  python3 - "$inspect_json" "$expected_image" "$TS_GATEWAY_STATE_DIR" <<'PY'
import json
import sys

data = json.loads(sys.argv[1])
expected_image, expected_state = sys.argv[2:]
if data.get("imageRef") != expected_image and data.get("imageId") != expected_image:
    raise SystemExit("ts-gateway image identity does not match the pinned digest")
if data.get("networkMode") != "host":
    raise SystemExit("ts-gateway is not using host networking")
mounts = data.get("mounts") or []
matches = [
    m for m in mounts
    if m.get("Destination") == "/var/lib/tailscale"
    and m.get("Source") == expected_state
    and m.get("RW") is True
]
if len(matches) != 1 or len(mounts) != 1:
    raise SystemExit("ts-gateway state mount is not the exact read-write managed mount")
PY
  local status
  status="$(run_ts status --json)"
  python3 - "$status" <<'PY'
import json
import sys

status = json.loads(sys.argv[1])
self = status.get("Self") or {}
dns = self.get("DNSName", "").rstrip(".")
if dns != "squrvq.tail0bec0f.ts.net":
    raise SystemExit("ts-gateway has unexpected DNS identity")
if self.get("Online") is not True:
    raise SystemExit("ts-gateway is not online")
PY
}

wait_gateway_online() {
  local status
  for _ in $(seq 1 60); do
    status="$(run_ts status --json 2>/dev/null || true)"
    if python3 - "$status" <<'PY'
import json
import sys

try:
    status = json.loads(sys.argv[1])
except Exception:
    raise SystemExit(1)
self = status.get("Self") or {}
raise SystemExit(0 if status.get("BackendState") == "Running" and self.get("Online") is True else 1)
PY
    then
      return 0
    fi
    sleep 1
  done
  fail "ts-gateway did not become online"
}

reconcile_squrvq_env() {
  local env_path="$ENV_FILE"
  test -f "$env_path" || fail "production env file missing: $env_path"
  python3 - "$env_path" <<'PY'
import os, sys, tempfile
env_path = sys.argv[1]
with open(env_path, "r", encoding="utf-8") as h:
    lines = h.readlines()
required = {
    "NEXT_PUBLIC_BASE_URL": "NEXT_PUBLIC_BASE_URL=https://squrvq.tail0bec0f.ts.net\n",
    "OMNIROUTE_PUBLIC_BASE_URL": "OMNIROUTE_PUBLIC_BASE_URL=https://squrvq.tail0bec0f.ts.net\n",
    "LIVE_WS_PUBLIC_URL": "LIVE_WS_PUBLIC_URL=wss://squrvq.tail0bec0f.ts.net/live-ws\n",
    "NEXT_PUBLIC_LIVE_WS_PUBLIC_URL": "NEXT_PUBLIC_LIVE_WS_PUBLIC_URL=wss://squrvq.tail0bec0f.ts.net/live-ws\n",
    "LIVE_WS_ALLOWED_ORIGINS": "LIVE_WS_ALLOWED_ORIGINS=https://squrvq.tail0bec0f.ts.net\n",
}
found = set()
out = []
for line in lines:
    key = line.split("=", 1)[0].strip()
    if key == "OMNIROUTE_WS_BIND_HOST":
        continue
    if key in required:
        if key not in found:
            out.append(required[key])
            found.add(key)
        continue
    out.append(line)
if out and not out[-1].endswith("\n"):
    out[-1] += "\n"
for k, v in required.items():
    if k not in found:
        out.append(v)
fd, tmp = tempfile.mkstemp(prefix=".env.", dir=os.path.dirname(env_path))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as h:
        h.writelines(out)
        h.flush()
        os.fsync(h.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, env_path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY
  env_hash="$(sha256sum "$env_path" | cut -d' ' -f1)"
  printf '%s %s\n' "$env_path" "$env_hash"
}

backup_gateway() {
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local dir="$STATE_DIR/gateway_${stamp}_$$"
  mkdir -p "$dir"
  chmod 700 "$dir"
  test -d "$TS_GATEWAY_STATE_DIR" || fail "ts-gateway state directory is missing"
  local img
  img="$(docker inspect "$TS_GATEWAY_CONTAINER" --format '{{.Image}}')"
  local img_ref
  img_ref="$(docker inspect "$TS_GATEWAY_CONTAINER" --format '{{.Config.Image}}')"
  local repo_digest
  repo_digest="$(docker image inspect "$img" --format '{{index .RepoDigests 0}}' 2>/dev/null || true)"
  if test -z "$repo_digest" || ! printf '%s' "$repo_digest" | grep -q '@sha256:[a-f0-9]\{64\}$'; then
    fail "ts-gateway image is not digest-pinned (RepoDigests)"
  fi
  docker inspect "$TS_GATEWAY_CONTAINER" > "$dir/inspect.json"
  printf '%s\n' "$img" > "$dir/image.id"
  printf '%s\n' "$img_ref" > "$dir/image.ref"
  printf '%s\n' "$repo_digest" > "$dir/image.digest"
  snapshot_gateway_state "$dir/state"
  run_ts status --json > "$dir/tailscale-status.json"
  run_ts serve status --json > "$dir/serve-status.json"
  run_ts funnel status --json > "$dir/funnel-status.json"
  run_ts serve get-config --all > "$dir/serve.json"
  normalize_json_file "$dir/serve.json" > "$dir/serve.normalized.json"
  normalize_json_file "$dir/funnel-status.json" > "$dir/funnel.normalized.json"
  chmod 600 "$dir"/*.json "$dir"/image.*
  printf '{"dir":%s,"tsGatewayImage":%s}\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$dir")" "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$repo_digest")"
}

snapshot_gateway_state() {
  local destination="$1"
  test ! -e "$destination" || fail "gateway state snapshot destination already exists"
  sudo -n cp -a -- "$TS_GATEWAY_STATE_DIR" "$destination"
  sudo -n chown -R "$(id -u):$(id -g)" "$destination"
  chmod -R u=rwX,go= "$destination"
}

reconcile_gateway() {
  # The public root is API-only. LiveWS enters through the dashboard listener,
  # whose standalone wrapper proxies the upgrade to the loopback-only daemon.
  # Configure the full semantic contract atomically so no intermediate reset
  # can leave the hostname pointing at the dashboard listener.
  local config_path
  config_path="$(mktemp "$STATE_DIR/serve-squrvq.XXXXXX.json")"
  chmod 600 "$config_path"
  cat > "$config_path" <<'JSON'
{
  "TCP": {"443": {"HTTPS": true}},
  "Web": {
    "squrvq.tail0bec0f.ts.net:443": {
      "Handlers": {
        "/": {"Proxy": "http://127.0.0.1:20131"},
        "/healthz": {"Proxy": "http://127.0.0.1:20130"},
        "/live-ws": {"Proxy": "http://127.0.0.1:20130"}
      }
    }
  },
  "AllowFunnel": {"squrvq.tail0bec0f.ts.net:443": true}
}
JSON
  docker cp "$config_path" "$TS_GATEWAY_CONTAINER:/tmp/serve-squrvq.json"
  rm -f -- "$config_path"
  run_ts serve reset
  run_ts funnel reset
  run_ts serve set-config --all /tmp/serve-squrvq.json
  sleep 2
  local cfg
  cfg="$(run_ts serve get-config --all)"
  if test -z "$cfg"; then fail "funnel reconciliation produced no config"; fi
  if ! gateway_config_is_exact "$cfg"; then fail "funnel reconciliation produced an unexpected semantic config"; fi
  printf '%s\n' "ok"
}

restore_gateway() {
  local dir="$1"
  test -n "$dir" || fail "restore_gateway requires backup dir"
  test -f "$dir/serve.json" || fail "gateway backup serve.json missing: $dir"
  test -d "$dir/state" || fail "gateway state snapshot missing: $dir/state"
  test -f "$dir/image.digest" || fail "gateway backup image digest missing: $dir/image.digest"
  local restore_image
  restore_image="$(cat "$dir/image.digest")"
  validate_immutable_image_ref "$restore_image"
  docker image inspect "$restore_image" >/dev/null \
    || fail "gateway backup image is unavailable: $restore_image"
  local quarantine="$STATE_DIR/gateway_failed_$(date -u +%Y%m%dT%H%M%S)_$$"
  mkdir -p "$quarantine"
  chmod 700 "$quarantine"
  if docker container inspect "$TS_GATEWAY_CONTAINER" >/dev/null 2>&1; then
    docker stop "$TS_GATEWAY_CONTAINER" >/dev/null
  fi
  if test -d "$TS_GATEWAY_STATE_DIR"; then
    mv "$TS_GATEWAY_STATE_DIR" "$quarantine/state"
  fi
  mkdir -p "$(dirname "$TS_GATEWAY_STATE_DIR")"
  cp -a -- "$dir/state" "$TS_GATEWAY_STATE_DIR"
  chmod -R u=rwX,go= "$TS_GATEWAY_STATE_DIR"
  docker rm -f "$TS_GATEWAY_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$TS_GATEWAY_CONTAINER" --network host --restart unless-stopped \
    --env TS_STATE_DIR=/var/lib/tailscale --env TS_HOSTNAME=squrvq \
    --env TS_USERSPACE=true --env TS_AUTH_ONCE=true \
    --volume "$TS_GATEWAY_STATE_DIR:/var/lib/tailscale" "$restore_image" >/dev/null
  wait_gateway_online
  docker cp "$dir/serve.json" "$TS_GATEWAY_CONTAINER:/tmp/serve-restore.json"
  run_ts serve reset
  run_ts funnel reset
  run_ts serve set-config --all /tmp/serve-restore.json
  local restored_cfg expected_cfg
  restored_cfg="$(run_ts serve get-config --all)"
  expected_cfg="$(cat "$dir/serve.json")"
  test "$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1]), sort_keys=True, separators=(",", ":")))' "$restored_cfg")" = \
    "$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1]), sort_keys=True, separators=(",", ":")))' "$expected_cfg")" \
    || fail "restored Tailscale Serve configuration did not verify"
  run_ts status --json >/dev/null
  verify_gateway_runtime "$restore_image"
  printf '%s\n' "ok"
}

adopt_gateway() {
  ensure_layout
  test -d "$TS_GATEWAY_STATE_DIR" || fail "ts-gateway state directory is missing"
  docker container inspect "$TS_GATEWAY_CONTAINER" >/dev/null 2>&1 || fail "existing ts-gateway container is missing"
  if test "$(docker inspect "$TS_GATEWAY_CONTAINER" --format '{{.Config.Image}}')" = "$TS_GATEWAY_IMAGE"; then
    verify_gateway_runtime "$TS_GATEWAY_IMAGE"
    printf '{"alreadyAdopted":true,"tsGatewayImage":%s}\n' \
      "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$TS_GATEWAY_IMAGE")"
    return 0
  fi
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%S)_$$"
  local dir="$STATE_DIR/gateway-adoption_${stamp}"
  mkdir -p "$dir"
  chmod 700 "$dir"
  docker inspect "$TS_GATEWAY_CONTAINER" > "$dir/old.inspect.json"
  local old_id old_ref
  old_id="$(docker inspect "$TS_GATEWAY_CONTAINER" --format '{{.Image}}')"
  old_ref="$(docker inspect "$TS_GATEWAY_CONTAINER" --format '{{.Config.Image}}')"
  printf '%s\n' "$old_id" > "$dir/old.image.id"
  printf '%s\n' "$old_ref" > "$dir/old.image.ref"
  run_ts status --json > "$dir/old.tailscale-status.json"
  run_ts serve get-config --all > "$dir/old.serve.json"
  run_ts funnel status --json > "$dir/old.funnel.json"
  normalize_json_file "$dir/old.serve.json" > "$dir/old.serve.normalized.json"
  normalize_json_file "$dir/old.funnel.json" > "$dir/old.funnel.normalized.json"
  snapshot_gateway_state "$dir/state"
  docker tag "$old_id" "$TS_GATEWAY_ROLLBACK_TAG"
  test "$(docker image inspect "$TS_GATEWAY_ROLLBACK_TAG" --format '{{.Id}}')" = "$old_id" \
    || fail "gateway rollback tag did not resolve to the existing image"
  docker pull "$TS_GATEWAY_IMAGE" >/dev/null \
    || fail "managed ts-gateway image could not be pulled before adoption"
  docker image inspect "$TS_GATEWAY_IMAGE" >/dev/null \
    || fail "managed ts-gateway image is unavailable after pull"
  docker stop "$TS_GATEWAY_CONTAINER" >/dev/null
  docker container rm "$TS_GATEWAY_CONTAINER" >/dev/null
  local adoption_failure=""
  if ! compose_prod up -d --no-deps --pull never "$TS_GATEWAY_CONTAINER"; then
    adoption_failure="managed ts-gateway failed to start during adoption"
  elif ! verify_gateway_runtime "$TS_GATEWAY_IMAGE"; then
    adoption_failure="managed ts-gateway adoption verification failed"
  fi
  if test -n "$adoption_failure"; then
    # Keep failed state quarantined and restore the complete state snapshot
    # before recreating the previous container image/spec.
    local quarantine="$STATE_DIR/gateway-adoption-failed_${stamp}"
    mkdir -p "$quarantine"
    chmod 700 "$quarantine"
    if test -d "$TS_GATEWAY_STATE_DIR"; then mv "$TS_GATEWAY_STATE_DIR" "$quarantine/state"; fi
    cp -a -- "$dir/state" "$TS_GATEWAY_STATE_DIR"
    chmod -R u=rwX,go= "$TS_GATEWAY_STATE_DIR"
    docker rm -f "$TS_GATEWAY_CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$TS_GATEWAY_CONTAINER" --network host --restart unless-stopped \
      --env TS_STATE_DIR=/var/lib/tailscale --env TS_HOSTNAME=squrvq \
      --env TS_USERSPACE=true --env TS_AUTH_ONCE=true \
      --volume "$TS_GATEWAY_STATE_DIR:/var/lib/tailscale" "$old_ref" >/dev/null
    docker cp "$dir/old.serve.json" "$TS_GATEWAY_CONTAINER:/tmp/serve-adoption-restore.json"
    for _ in $(seq 1 30); do
      if run_ts status --json >/dev/null 2>&1; then break; fi
      sleep 1
    done
    run_ts status --json >/dev/null
    run_ts serve set-config --all /tmp/serve-adoption-restore.json
    fail "$adoption_failure; previous container restored"
  fi
  printf '{"backupDir":%s,"tsGatewayImage":%s}\n' \
    "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$dir")" \
    "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$TS_GATEWAY_IMAGE")"
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

  tag-rollback)
    expected_id="${1:-}"
    current_id="$(docker inspect "$PROD_CONTAINER" --format '{{.Image}}')"
    test "$current_id" = "$expected_id" || fail "production image changed before rollback tag"
    docker image tag "$expected_id" "$ROLLBACK_TAG"
    test "$(docker image inspect "$ROLLBACK_TAG" --format '{{.Id}}')" = "$expected_id" \
      || fail "rollback tag did not resolve to the expected image"
    ;;

  tag-gateway-rollback)
    current_gateway_id="$(docker inspect "$TS_GATEWAY_CONTAINER" --format '{{.Image}}')"
    docker image tag "$current_gateway_id" "$TS_GATEWAY_ROLLBACK_TAG"
    test "$(docker image inspect "$TS_GATEWAY_ROLLBACK_TAG" --format '{{.Id}}')" = "$current_gateway_id" \
      || fail "gateway rollback tag did not resolve to the expected image"
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
    test "$(docker inspect "$PROD_CONTAINER" --format '{{.State.OOMKilled}}')" = "false"
    test "$(docker inspect "$PROD_CONTAINER" --format '{{.HostConfig.Memory}}')" = "6442450944"
    test "$(docker inspect "$PROD_CONTAINER" --format '{{.HostConfig.NanoCpus}}')" = "2000000000"
    ;;

  adopt-gateway)
    adopt_gateway
    ;;

  backup-gateway)
    backup_gateway
    ;;

  reconcile-gateway)
    reconcile_gateway
    ;;

  restore-gateway)
    restore_gateway "$1"
    ;;

  reconcile-squrvq-env)
    reconcile_squrvq_env
    ;;

  backup-config)
    ensure_layout
    # Hash production .env for manifest envHash
    env_path="$ENV_FILE"
    require_file "$env_path"
    sha="$(sha256sum "$env_path" | cut -d' ' -f1)"
    # Also copy to timestamped backup dir
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    dir="$STATE_DIR/config_${stamp}_$$"
    mkdir -p "$dir"
    chmod 700 "$dir"
    cp -p "$env_path" "$dir/.env"
    chmod 600 "$dir/.env"
    printf '{"path":%s,"hash":%s}\n' \
      "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$dir/.env")" \
      "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$sha")"
    ;;

  restore-config)
    backup_path="${1:-}"
    expected_hash="${2:-}"
    test -f "$backup_path" || fail "config backup missing: $backup_path"
    install -m 600 "$backup_path" "$ENV_FILE"
    if test -n "$expected_hash"; then
      actual_hash="$(sha256sum "$ENV_FILE" | cut -d' ' -f1)"
      test "$actual_hash" = "$expected_hash" || fail "restored .env hash did not verify"
    fi
    printf '%s\n' "ok"
    ;;

  write-manifest)
    ensure_layout
    manifest_path="$STATE_DIR/current.json"
    temp_path="$STATE_DIR/.current.json.tmp"
    python3 -c 'import json,sys; data=json.load(sys.stdin); assert data.get("schemaVersion") == 2; assert data.get("state") in {"pending", "active", "rolled_back", "rollback_failed"}; assert data.get("current", {}).get("imageId"); assert data.get("rollback", {}).get("imageId"); assert data.get("gatewayBackupDir"); assert data.get("configBackupPath"); assert data.get("tsGatewayImage"); assert data.get("envHash"); json.dump(data,sys.stdout,indent=2); print()' > "$temp_path"
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
    fail "usage: $0 {dispatch-json|preflight|lock|unlock|lock-canary|unlock-canary|inspect-image|inspect-prod|inspect-canary|compose-hash|backup|prepare-canary|start-canary|stop-canary|delete-canary-data|call-log-max|combo-log-evidence|tag-rollback|tag-gateway-rollback|verify-rollback-tag|set-image|recreate-prod|verify-image|adopt-gateway|backup-gateway|reconcile-gateway|restore-gateway|reconcile-squrvq-env|backup-config|restore-config|write-manifest|read-manifest|status}"
    ;;
esac
