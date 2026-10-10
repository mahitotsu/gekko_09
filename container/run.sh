#!/usr/bin/env bash
# Builds the eval image from this checkout and runs one command in it.
#   container/run.sh                                     (records the environment; no model requests)
#   container/run.sh npx tsx eval/run.ts --arms haiku --tasks e1-timeout
#   container/run.sh npx tsx eval/run.ts --resume eval/results/<stamp>.jsonl
# Auth: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), from the
# environment or else from .env at the repository root (or $EVAL_ENV_FILE),
# a file git and the image build both ignore:
#   CLAUDE_CODE_OAUTH_TOKEN=...
# It is passed to the container by name only, so its value never appears on
# a command line, in the image, or in this script.
# CONTAINER_ENGINE=podman uses podman instead of docker.
set -euo pipefail

for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY; do
  if [[ -n "${!v+x}" ]]; then
    echo "unset $v: the eval authenticates only with CLAUDE_CODE_OAUTH_TOKEN" >&2
    exit 1
  fi
done

engine="${CONTAINER_ENGINE:-docker}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
commit="$(git -C "$root" rev-parse HEAD)"
dirty=0
[[ -n "$(git -C "$root" status --porcelain)" ]] && dirty=1
tag="gekko-eval:${commit:0:12}$( (( dirty )) && echo -dirty || true)"

"$engine" build --quiet -f "$root/container/Dockerfile" -t "$tag" "$root" >/dev/null
image_id="$("$engine" image inspect --format '{{.Id}}' "$tag")"
mkdir -p "$root/eval/results"

env_file="${EVAL_ENV_FILE:-$root/.env}"
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -f "$env_file" ]]; then
  if [[ -n "$(find "$env_file" -perm /077)" ]]; then
    echo "$env_file is readable by others: chmod 600 it" >&2
    exit 1
  fi
  # Accepts `export NAME=value`, a quoted value, and CRLF line ends.
  CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '\r' < "$env_file" | sed -nE 's/^[[:space:]]*(export[[:space:]]+)?CLAUDE_CODE_OAUTH_TOKEN[[:space:]]*=[[:space:]]*//p' | tail -n 1 | sed -E "s/^(['\"])(.*)\1[[:space:]]*$/\2/; s/[[:space:]]+$//")"
  export CLAUDE_CODE_OAUTH_TOKEN
  [[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]] || unset CLAUDE_CODE_OAUTH_TOKEN
fi

token_flag=()
if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN+x}" ]]; then
  token_flag=(-e CLAUDE_CODE_OAUTH_TOKEN)
else
  echo "no token: CLAUDE_CODE_OAUTH_TOKEN is unset and $env_file has none (only --env-only works without it)" >&2
fi

exec "$engine" run --rm \
  --user "$(id -u):$(id -g)" \
  "${token_flag[@]}" \
  -e EVAL_IMAGE="$tag@$image_id" \
  -e EVAL_GIT_COMMIT="$commit" \
  -e EVAL_GIT_DIRTY="$dirty" \
  -v "$root/eval/results:/work/eval/results" \
  "$tag" "$@"
