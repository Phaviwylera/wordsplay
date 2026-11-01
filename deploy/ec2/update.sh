#!/usr/bin/env bash
# Runs as root from a root-owned EC2 checkout. Deploys only a tested image of origin/main.
set -Eeuo pipefail

REPO_DIR=${REPO_DIR:-/opt/walleto/source}
STATE_DIR=${STATE_DIR:-/var/lib/walleto}
APP_NAME=${APP_NAME:-walleto-app}
IMAGE_REPO=${IMAGE_REPO:-walleto}
PROBE_ATTEMPTS=${PROBE_ATTEMPTS:-30}
CANDIDATE_NAME="${APP_NAME}-candidate"
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || { echo 'A deployment is already running.'; exit 0; }
cd "$REPO_DIR"

# Never deploy an uncommitted checkout or a branch other than origin/main.
git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
commit=$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit ID'; exit 1; }
image="$IMAGE_REPO:$commit"
previous_image=''
[[ ! -f "$STATE_DIR/current-image" ]] || previous_image=$(cat "$STATE_DIR/current-image")

# Check settings before stopping the current app. The limits are concurrent
# checks inside one process, not permission to start more containers.
worker_global=${WALLETO_SCAN_CONCURRENCY-12}
worker_network=${WALLETO_SCAN_PER_NETWORK-3}
worker_settings='disabled'
worker_enabled=0
if [[ -f "$STATE_DIR/background-enabled" ]]; then
  worker_enabled=1
  [[ "$worker_global" =~ ^([1-9]|[1-3][0-9]|40)$ ]] || { echo 'WALLETO_SCAN_CONCURRENCY must be an integer from 1 to 40.' >&2; exit 1; }
  [[ "$worker_network" =~ ^[1-8]$ ]] || { echo 'WALLETO_SCAN_PER_NETWORK must be an integer from 1 to 8.' >&2; exit 1; }
  worker_settings="enabled:$worker_global:$worker_network"
fi
# Preserve the last successful configuration for rollback. Never trust the
# settings file as shell code, and never re-enable a worker if its opt-in flag
# has been removed.
previous_settings=$worker_settings
if [[ -f "$STATE_DIR/deployed-worker-settings" ]]; then
  saved_settings=$(cat "$STATE_DIR/deployed-worker-settings")
  if [[ "$saved_settings" == 'disabled' || "$saved_settings" =~ ^enabled:([1-9]|[1-3][0-9]|40):[1-8]$ ]]; then
    previous_settings=$saved_settings
  fi
fi
if [[ "$worker_enabled" == 0 && "$previous_settings" == enabled:* ]]; then previous_settings='disabled'; fi

healthy() {
  docker exec "$1" node -e "fetch('http://127.0.0.1:3000/',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}
wait_healthy() {
  local name=$1
  for ((i=0; i<PROBE_ATTEMPTS; i++)); do
    if healthy "$name"; then return 0; fi
    sleep 1
  done
  return 1
}
start_app() {
  local image_to_start=$1 settings=$2 mode global network
  local -a background_args=()
  IFS=: read -r mode global network <<< "$settings"
  # Opt in only after the operator has removed public proxy access and is using
  # an SSH tunnel. Host/Origin checks alone are not a network security boundary.
  if [[ "$mode" == 'enabled' ]]; then
    mkdir -p "$STATE_DIR/background-jobs"
    chown 1000:1000 "$STATE_DIR/background-jobs"
    chmod 700 "$STATE_DIR/background-jobs"
    background_args=(-e WALLETO_BACKGROUND_DIR=/var/lib/walleto-jobs -v "$STATE_DIR/background-jobs:/var/lib/walleto-jobs"
      -e "WALLETO_SCAN_CONCURRENCY=$global" -e "WALLETO_SCAN_PER_NETWORK=$network")
  fi
  docker run -d --name "$APP_NAME" --restart unless-stopped -p 127.0.0.1:3000:3000 "${background_args[@]}" "$image_to_start" >/dev/null || return 1
  wait_healthy "$APP_NAME"
}
cleanup_candidate() { docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true; }
trap cleanup_candidate EXIT

if [[ -f "$STATE_DIR/deployed.sha" ]] && [[ "$(cat "$STATE_DIR/deployed.sha")" == "$commit" ]] &&
   [[ -f "$STATE_DIR/deployed-worker-settings" ]] && [[ "$(cat "$STATE_DIR/deployed-worker-settings")" == "$worker_settings" ]] && healthy "$APP_NAME"; then
  echo "Already healthy at $commit with the requested worker settings"
  exit 0
fi

# The checkout is a dedicated deployment checkout, not a developer working directory.
git reset --hard "$commit"
# Reuse the known-good image for a configuration-only restart. Rebuilding the
# same tag could overwrite the rollback image and is unnecessary here.
if [[ -f "$STATE_DIR/deployed.sha" ]] && [[ "$(cat "$STATE_DIR/deployed.sha")" == "$commit" ]] &&
   [[ "$previous_image" == "$image" ]] && docker image inspect "$image" >/dev/null 2>&1; then
  echo "Reusing image $image for changed worker settings"
else
  # Dockerfile runs the test suite before building the runtime image.
  docker build -t "$image" .
fi
cleanup_candidate
# Probe the image without publishing a port before touching the current container.
docker run -d --name "$CANDIDATE_NAME" --network none "$image" >/dev/null
if ! wait_healthy "$CANDIDATE_NAME"; then
  echo "New image did not pass its health check; keeping the previous app." >&2
  exit 1
fi
cleanup_candidate
# If opt-in changed while the image was building, leave the current app alone
# and let the next deployment use the newly requested private-worker state.
if { [[ "$worker_enabled" == 1 ]] && [[ ! -f "$STATE_DIR/background-enabled" ]]; } ||
   { [[ "$worker_enabled" == 0 ]] && [[ -f "$STATE_DIR/background-enabled" ]]; }; then
  echo 'Background-worker opt-in changed during the build; retry deployment.' >&2
  exit 1
fi

docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
if ! start_app "$image" "$worker_settings"; then
  echo 'New app did not become healthy; attempting rollback.' >&2
  docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
  if [[ -n "$previous_image" ]] && docker image inspect "$previous_image" >/dev/null 2>&1; then
    if start_app "$previous_image" "$previous_settings"; then echo "Restored $previous_image with previous worker settings" >&2; else echo 'Rollback failed; manual intervention required.' >&2; fi
  else
    echo 'No prior image available for rollback.' >&2
  fi
  exit 1
fi
printf '%s\n' "$image" > "$STATE_DIR/current-image"
printf '%s\n' "$commit" > "$STATE_DIR/deployed.sha"
printf '%s\n' "$worker_settings" > "$STATE_DIR/deployed-worker-settings"
echo "Deployed $commit ($worker_settings worker settings)"

# Keep the current and last successful image for rollback; remove only our old tags.
while IFS= read -r old; do
  [[ -n "$old" && "$old" != "$image" && "$old" != "$previous_image" ]] || continue
  docker image rm "$old" >/dev/null 2>&1 || true
done < <(docker image ls "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}')
