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
  local -a background_args=()
  # Opt in only after the operator has removed public proxy access and is using
  # an SSH tunnel. Host/Origin checks alone are not a network security boundary.
  if [[ -f "$STATE_DIR/background-enabled" ]]; then
    mkdir -p "$STATE_DIR/background-jobs"
    chown 1000:1000 "$STATE_DIR/background-jobs"
    chmod 700 "$STATE_DIR/background-jobs"
    background_args=(-e WALLETO_BACKGROUND_DIR=/var/lib/walleto-jobs -v "$STATE_DIR/background-jobs:/var/lib/walleto-jobs")
  fi
  docker run -d --name "$APP_NAME" --restart unless-stopped -p 127.0.0.1:3000:3000 "${background_args[@]}" "$1" >/dev/null || return 1
  wait_healthy "$APP_NAME"
}
cleanup_candidate() { docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true; }
trap cleanup_candidate EXIT

if [[ -f "$STATE_DIR/deployed.sha" ]] && [[ "$(cat "$STATE_DIR/deployed.sha")" == "$commit" ]] && healthy "$APP_NAME"; then
  echo "Already healthy at $commit"
  exit 0
fi

# The checkout is a dedicated deployment checkout, not a developer working directory.
git reset --hard "$commit"
# Dockerfile runs the test suite before building the runtime image. Old app stays up on failure.
docker build -t "$image" .
cleanup_candidate
# Probe the image without publishing a port before touching the current container.
docker run -d --name "$CANDIDATE_NAME" --network none "$image" >/dev/null
if ! wait_healthy "$CANDIDATE_NAME"; then
  echo "New image did not pass its health check; keeping the previous app." >&2
  exit 1
fi
cleanup_candidate

docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
if ! start_app "$image"; then
  echo 'New app did not become healthy; attempting rollback.' >&2
  docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
  if [[ -n "$previous_image" ]] && docker image inspect "$previous_image" >/dev/null 2>&1; then
    if start_app "$previous_image"; then echo "Restored $previous_image" >&2; else echo 'Rollback failed; manual intervention required.' >&2; fi
  else
    echo 'No prior image available for rollback.' >&2
  fi
  exit 1
fi
printf '%s\n' "$image" > "$STATE_DIR/current-image"
printf '%s\n' "$commit" > "$STATE_DIR/deployed.sha"
echo "Deployed $commit"

# Keep the current and last successful image for rollback; remove only our old tags.
while IFS= read -r old; do
  [[ -n "$old" && "$old" != "$image" && "$old" != "$previous_image" ]] || continue
  docker image rm "$old" >/dev/null 2>&1 || true
done < <(docker image ls "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}')
