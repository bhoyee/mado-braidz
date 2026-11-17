#!/usr/bin/env bash
# Executed on the production host, never on a pull request runner.
set -euo pipefail
umask 077
revision=${1:?Expected full Git revision}
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 2
base=/home/madoafri/mado-deploy
app=/home/madoafri/mado-app
release="$base/releases/$revision-$(date -u +%Y%m%dT%H%M%SZ)-$$"
archive="$base/incoming/$revision.tar.gz"
exec 9>"$base/deployment.lock"
flock -n 9 || { echo 'Another deployment is running'; exit 1; }
[[ -f "$app/.env" && -f "$archive" && ! -e "$release" ]]
cd "$base/incoming"
sha256sum -c "$revision.tar.gz.sha256"
mkdir -p "$release"
# Archives are produced from an explicit repository file list by trusted main CI.
tar -xzf "$archive" -C "$release"
ln -s "$app/.env" "$release/.env"
export PATH=/opt/alt/alt-nodejs20/root/usr/bin:$PATH
[[ $(node --version) == v20.* ]]
cd "$release"
npm ci --omit=dev --no-audit --no-fund
printf '{"revision":"%s"}\n' "$revision" > release.json
"$base/backup-database.sh"
npm run db:migrate

# Keep the registered app root, private env, uploads, logs and cron paths stable.
# Each release owns its Linux dependencies; the previous release stays available.
previous="$base/previous/$(date -u +%Y%m%dT%H%M%SZ)-$revision"
mkdir -p "$previous"
entries=(app.cjs package.json package-lock.json src scripts public node_modules release.json)
changed=()
restart() {
  python3 - "$app" <<'PY'
import os, signal, subprocess, sys
target = 'lsnode:' + sys.argv[1] + '/'
result = subprocess.run(['ps', '-u', str(os.getuid()), '-o', 'pid=,args='],
                        stdout=subprocess.PIPE, universal_newlines=True, check=True)
for line in result.stdout.splitlines():
    parts = line.strip().split(None, 1)
    if len(parts) == 2 and parts[1].strip() == target:
        pid = int(parts[0])
        if os.stat('/proc/' + str(pid)).st_uid != os.getuid():
            raise RuntimeError('Unexpected process owner')
        os.kill(pid, signal.SIGTERM)
PY
}
rollback() {
  result=$?
  trap - ERR
  echo 'Deployment failed; restoring previous application files. Database changes are retained.'
  for entry in "${changed[@]}"; do
    if [[ -L "$app/$entry" ]]; then unlink "$app/$entry"; fi
    if [[ -e "$previous/$entry" || -L "$previous/$entry" ]]; then
      mv "$previous/$entry" "$app/$entry"
    fi
  done
  restart || true
  exit "$result"
}
trap rollback ERR
for entry in "${entries[@]}"; do
  changed+=("$entry")
  if [[ -e "$app/$entry" || -L "$app/$entry" ]]; then
    mv "$app/$entry" "$previous/$entry"
  fi
  ln -s "$release/$entry" "$app/$entry"
done
restart
verified=false
for attempt in {1..24}; do
  if curl --fail --silent --show-error --max-time 15 https://madoafricanbraidz.com/health |
    node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const h=JSON.parse(s);process.exit(h.status==="ok"&&h.revision===process.argv[1]?0:1)}catch{process.exit(1)}})' "$revision"; then
    verified=true
    break
  fi
  sleep 5
done
[[ "$verified" == true ]]
curl --fail --silent --show-error --max-time 30 https://madoafricanbraidz.com/styles -o /dev/null
curl --fail --silent --show-error --max-time 30 https://madoafricanbraidz.com/book -o /dev/null
if [[ -f "$release/scripts/run-deployment-queue.sh" ]]; then
  bash -n "$release/scripts/run-deployment-queue.sh"
  cp "$release/scripts/run-deployment-queue.sh" "$base/run-deployment-queue.sh.next"
  mv "$base/run-deployment-queue.sh.next" "$base/run-deployment-queue.sh"
fi
trap - ERR
printf '{"gitRevision":"%s","release":"%s","previous":"%s"}\n' "$revision" "$release" "$previous" > "$base/ci-release.json"
echo "Production verified at revision $revision"
