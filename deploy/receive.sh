#!/usr/bin/env bash
# The ONLY thing the GitHub deploy key may run on the VPS: its authorized_keys
# line forces this script (command="...",restrict), so a leaked key can load
# and start a GetSetPaid image and nothing else -- no shell, no forwarding.
#
#   ssh getsetpaid-deploy "deploy <40-hex git sha>"  < image.tar.gz
#   ssh getsetpaid-deploy "rollback"
#
# Lives at ~/getsetpaid/receive.sh beside compose.yml and .env.production
# (docs/runbooks/deploy.md § 3). Keeps the previous tag for rollback.
set -euo pipefail
cd "$(dirname "$0")"

read -r verb arg <<<"${SSH_ORIGINAL_COMMAND:-}"
compose() { GETSETPAID_TAG="$1" docker compose -f compose.yml up -d --wait --wait-timeout 120; }

case "${verb:-}" in
  deploy)
    [[ "${arg:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "deploy needs a full git sha" >&2; exit 2; }
    gunzip -c | docker load >/dev/null
    docker image inspect "getsetpaid:$arg" >/dev/null 2>&1 || { echo "image getsetpaid:$arg not in the upload" >&2; exit 3; }
    [ -f current ] && cp current previous
    if compose "$arg"; then
      echo "$arg" > current
      # Keep the running image and the rollback one; drop the rest.
      keep="$arg $(cat previous 2>/dev/null || true)"
      for t in $(docker image ls getsetpaid --format '{{.Tag}}'); do
        [[ " $keep " == *" $t "* ]] || docker image rm "getsetpaid:$t" >/dev/null || true
      done
      echo "deployed $arg"
    else
      echo "the new container did not become healthy; rolling back" >&2
      [ -f previous ] && compose "$(cat previous)"
      exit 4
    fi
    ;;
  rollback)
    [ -f previous ] || { echo "nothing to roll back to" >&2; exit 5; }
    compose "$(cat previous)" && cp previous current && echo "rolled back to $(cat current)"
    ;;
  *)
    echo "usage: deploy <sha> | rollback" >&2
    exit 1
    ;;
esac
