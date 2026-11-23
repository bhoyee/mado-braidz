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
# The host limits the number of files as well as gigabytes.
file_count=$(find "$base" 2>/dev/null | wc -l) || file_count=0
echo "Deployment folder holds $file_count files"
if (( file_count > 150000 )); then
  echo 'WARNING: file count is high; check the hosting file limit and old releases'
fi
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
  npm run catalog:men

# Keep the registered app root, private env, uploads, logs and cron paths stable.
# Each release owns its Linux dependencies; the previous release stays available.
previous="$base/previous/$(date -u +%Y%m%dT%H%M%SZ)-$revision"
mkdir -p "$previous"
entries=(app.cjs package.json package-lock.json src scripts public node_modules release.json)
changed=()
# Remove superseded code copies once the new release is verified. Keeps the live
# release and two rollbacks. Any doubt deletes nothing, and a problem here never
# fails a good deployment. Uploads, backups, logs and .env are outside its reach.
cleanup_old_copies() {
  local releases snapshots live path name target kept='' kept_snapshots=''
  local referenced='' rollbacks=0
  releases=$(readlink -f "$base/releases") || return 1
  snapshots=$(readlink -f "$base/previous") || return 1
  live=$(dirname "$(readlink -f "$app/node_modules")")
  if [[ "$live" != "$(readlink -f "$release")" || "$(dirname "$live")" != "$releases" || ! -f "$live/app.cjs" ]]; then
    echo 'Cleanup skipped: live release is unclear'
    return 1
  fi
  kept="$live"
  # Snapshot names start with a UTC timestamp, so reverse order is newest first.
  while IFS= read -r path; do
    name=$(basename "$path")
    [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{40}$ && ! -L "$path" ]] || continue
    [[ -L "$path/node_modules" ]] || continue
    target=$(dirname "$(readlink "$path/node_modules")")
    [[ "$(dirname "$target")" == "$releases" ]] || continue
    referenced="$referenced
$target"
    if (( rollbacks < 2 )) && [[ -f "$target/app.cjs" ]] && ! grep -Fxq -- "$target" <<< "$kept"; then
      kept="$kept
$target"
      kept_snapshots="$kept_snapshots
$path"
      rollbacks=$((rollbacks + 1))
    fi
  done < <(find "$snapshots" -mindepth 1 -maxdepth 1 -type d | sort -r)
  if (( rollbacks < 1 )); then
    echo 'Cleanup skipped: no rollback release found'
    return 1
  fi
  while IFS= read -r path; do
    name=$(basename "$path")
    [[ "$name" =~ ^[a-f0-9]{40}-[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || continue
    grep -Fxq -- "$path" <<< "$kept" && continue
    # Never-live copies are failed attempts; keep them a day for diagnosis.
    if ! grep -Fxq -- "$path" <<< "$referenced"; then
      [[ -n "$(find "$path" -maxdepth 0 -mmin +1440)" ]] || continue
    fi
    rm -rf --one-file-system -- "$path" && echo "Removed old release $name"
  done < <(find "$releases" -mindepth 1 -maxdepth 1 -type d)
  while IFS= read -r path; do
    name=$(basename "$path")
    [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{40}$ ]] || continue
    grep -Fxq -- "$path" <<< "$kept_snapshots" && continue
    # Only shortcut folders are removed; anything holding real files is left.
    [[ -z "$(find "$path" -mindepth 1 ! -type l -print -quit)" ]] || continue
    rm -rf --one-file-system -- "$path"
  done < <(find "$snapshots" -mindepth 1 -maxdepth 1 -type d)
  while IFS= read -r path; do
    name=$(basename "$path")
    [[ "$name" =~ ^([a-f0-9]{40})\.tar\.gz(\.sha256)?$ ]] || continue
    target=${BASH_REMATCH[1]}
    [[ "$target" != "$revision" ]] || continue
    compgen -G "$base/incoming/$target-*.request" > /dev/null && continue
    rm -f -- "$path"
  done < <(find "$base/incoming" -mindepth 1 -maxdepth 1 -type f -mmin +1440)
  [[ "$(readlink -f "$app/node_modules")" == "$live/node_modules" && -f "$live/app.cjs" ]] || return 1
  curl --fail --silent --show-error --max-time 15 https://madoafricanbraidz.com/health -o /dev/null || return 1
  echo "Cleanup finished: kept live and $rollbacks rollback release(s)"
}
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
if ! cleanup_old_copies; then
  echo 'WARNING: old copies were not fully cleaned; the verified release stays live'
fi
