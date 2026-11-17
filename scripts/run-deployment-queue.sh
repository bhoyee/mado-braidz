#!/usr/bin/env bash
# One short cron invocation; deployment files and logs remain outside the web root.
set -euo pipefail
umask 077
base=/home/madoafri/mado-deploy
mkdir -p "$base/status" "$base/processing" "$base/deployment-logs" "$base/releases"
exec 8>"$base/queue.lock"
flock -n 8 || exit 0
for request in "$base/incoming/"*.request; do
  [[ -f "$request" ]] || break
  name=$(basename "$request" .request)
  [[ "$name" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || continue
  revision=${name:0:40}
  mv "$request" "$base/processing/$name.request"
  printf '{"state":"processing","revision":"%s"}\n' "$revision" > "$base/status/$name.json.tmp"
  mv "$base/status/$name.json.tmp" "$base/status/$name.json"
  if (
    set -e
    cd "$base/incoming"
    sha256sum -c "$revision.tar.gz.sha256" || exit 1
    tar -xOf "$revision.tar.gz" scripts/deploy-production.sh > "$base/processing/$name.sh" || exit 1
    bash "$base/processing/$name.sh" "$revision"
  ) > "$base/deployment-logs/$name.log" 2>&1; then
    state=succeeded
  else
    state=failed
  fi
  printf '{"state":"%s","revision":"%s"}\n' "$state" "$revision" > "$base/status/$name.json.tmp"
  mv "$base/status/$name.json.tmp" "$base/status/$name.json"
  rm "$base/processing/$name.request"
  break
done
