#!/usr/bin/env bash
# Exercise real cutover/rollback logic with fake packages and HTTP, never a real DB.
set -euo pipefail
source_script=${1:-scripts/deploy-production.sh}
queue_script=${2:-scripts/run-deployment-queue.sh}
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
export DEPLOY_FIXTURE="$fixture"
mkdir -p "$fixture/base/incoming" "$fixture/base/releases" "$fixture/app" "$fixture/bin"
printf 'private-env-must-survive\n' > "$fixture/app/.env"
for entry in app.cjs package.json package-lock.json release.json; do
  printf 'original\n' > "$fixture/app/$entry"
done
mkdir "$fixture/app/src" "$fixture/app/scripts" "$fixture/app/public" "$fixture/app/node_modules"
python3 - "$source_script" "$fixture" "$queue_script" <<'PY'
import sys
source, fixture, queue_source = sys.argv[1:]
with open(source) as f:
    script = f.read()
script = script.replace('/home/madoafri/mado-deploy', fixture + '/base')
script = script.replace('/home/madoafri/mado-app', fixture + '/app')
script = script.replace('export PATH=/opt/alt/alt-nodejs20/root/usr/bin:$PATH',
                        'export PATH="' + fixture + '/bin:$PATH"')
script = script.replace('{1..24}', '{1..2}').replace('sleep 5', 'sleep 0')
with open(fixture + '/deploy.sh', 'w') as f:
    f.write(script)
with open(queue_source) as f:
    queue = f.read().replace('/home/madoafri/mado-deploy', fixture + '/base')
with open(fixture + '/queue.sh', 'w') as f:
    f.write(queue)
PY
cat > "$fixture/bin/npm" <<'SH'
#!/usr/bin/env bash
set -eu
if [[ "$1" == ci ]]; then mkdir node_modules; exit 0; fi
if [[ -f "$DEPLOY_FIXTURE/fail-migration" ]]; then exit 1; fi
echo 'Fixture migrations complete'
SH
cat > "$fixture/bin/curl" <<'SH'
#!/usr/bin/env bash
set -eu
if [[ -f "$DEPLOY_FIXTURE/fail-health" ]]; then exit 22; fi
if [[ "$*" == *'/health'* ]]; then
  node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.env.DEPLOY_FIXTURE+"/app/release.json"));console.log(JSON.stringify({status:"ok",revision:r.revision}))'
fi
SH
printf '#!/usr/bin/env bash\necho backup >> "$DEPLOY_FIXTURE/backups"\n' > "$fixture/base/backup-database.sh"
chmod +x "$fixture/bin/npm" "$fixture/bin/curl" "$fixture/base/backup-database.sh"
archive() {
  revision=$1
  mkdir -p "$fixture/package/src" "$fixture/package/scripts" "$fixture/package/public"
  printf 'new application\n' > "$fixture/package/app.cjs"
  printf '{}\n' > "$fixture/package/package.json"
  printf '{}\n' > "$fixture/package/package-lock.json"
  cp "$fixture/deploy.sh" "$fixture/package/scripts/deploy-production.sh"
  cp "$fixture/queue.sh" "$fixture/package/scripts/run-deployment-queue.sh"
  tar -czf "$fixture/base/incoming/$revision.tar.gz" -C "$fixture/package" app.cjs package.json package-lock.json src scripts public
  (cd "$fixture/base/incoming"; sha256sum "$revision.tar.gz" > "$revision.tar.gz.sha256")
}
first=1111111111111111111111111111111111111111
archive "$first"
bash "$fixture/deploy.sh" "$first"
[[ -L "$fixture/app/src" && -d "$fixture/app/node_modules" ]]
original_target=$(readlink "$fixture/app/src")
grep -q "$first" "$fixture/app/release.json"

second=2222222222222222222222222222222222222222
archive "$second"
touch "$fixture/fail-migration"
if bash "$fixture/deploy.sh" "$second"; then echo 'Migration failure was ignored'; exit 1; fi
[[ $(readlink "$fixture/app/src") == "$original_target" ]]
rm "$fixture/fail-migration"

third=3333333333333333333333333333333333333333
archive "$third"
touch "$fixture/fail-health"
if bash "$fixture/deploy.sh" "$third"; then echo 'Health failure was ignored'; exit 1; fi
[[ $(readlink "$fixture/app/src") == "$original_target" ]]
grep -q "$first" "$fixture/app/release.json"
[[ $(cat "$fixture/app/.env") == private-env-must-survive ]]
[[ $(wc -l < "$fixture/backups") -eq 3 ]]
rm "$fixture/fail-health"
fourth=4444444444444444444444444444444444444444
archive "$fourth"
touch "$fixture/base/incoming/$fourth-123-1.request"
bash "$fixture/queue.sh"
grep -q '"state":"succeeded"' "$fixture/base/status/$fourth-123-1.json"
grep -q "$fourth" "$fixture/app/release.json"
fifth=5555555555555555555555555555555555555555
archive "$fifth"
printf '%064d  %s.tar.gz\n' 0 "$fifth" > "$fixture/base/incoming/$fifth.tar.gz.sha256"
touch "$fixture/base/incoming/$fifth-123-1.request"
bash "$fixture/queue.sh"
grep -q '"state":"failed"' "$fixture/base/status/$fifth-123-1.json"
grep -q "$fourth" "$fixture/app/release.json"
[[ $(wc -l < "$fixture/backups") -eq 4 ]]

# Cleanup: keep live plus two rollbacks, and touch nothing else.
releases="$fixture/base/releases"
has() { compgen -G "$releases/$1-*" > /dev/null; }
# Everything so far is recent: the failed attempts must still be there.
has "$second" && has "$third" && has "$first" && has "$fourth"
mkdir -p "$fixture/uploads" "$fixture/backups-dir" "$releases/keep-me" "$fixture/outside"
echo receipt > "$fixture/uploads/payment.webp"
echo dump > "$fixture/backups-dir/db.sql.gz"
echo precious > "$fixture/outside/file"
fake=9999999999999999999999999999999999999999
ln -s "$fixture/outside" "$releases/$fake-20200101T000000Z-1"
touch -d '3 days ago' "$releases/keep-me"
touch -d '3 days ago' "$releases/$second"-* "$releases/$third"-*
mkdir "$fixture/base/previous/20200101T000000Z-$fake"
echo 'original code' > "$fixture/base/previous/20200101T000000Z-$fake/app.cjs"
touch -d '3 days ago' "$fixture/base/incoming/$second.tar.gz" "$fixture/base/incoming/$third.tar.gz"
touch "$fixture/base/incoming/$third-123-9.request.hold"
touch "$fixture/base/incoming/unrelated.txt"
touch -d '3 days ago' "$fixture/base/incoming/unrelated.txt"
for code in 6 7 8; do
  next=$(printf "$code%.0s" {1..40})
  archive "$next"
  sleep 1
  bash "$fixture/deploy.sh" "$next" > "$fixture/deploy.log"
done
grep -q 'Cleanup finished: kept live and 2 rollback' "$fixture/deploy.log"
sixth=$(printf '6%.0s' {1..40}); seventh=$(printf '7%.0s' {1..40}); eighth=$(printf '8%.0s' {1..40})
has "$sixth" && has "$seventh" && has "$eighth"
for gone in "$first" "$second" "$third" "$fourth"; do
  if has "$gone"; then echo "Old release $gone was kept"; exit 1; fi
done
[[ $(cat "$fixture/app/.env") == private-env-must-survive ]]
[[ $(cat "$fixture/uploads/payment.webp") == receipt && $(cat "$fixture/backups-dir/db.sql.gz") == dump ]]
[[ $(cat "$fixture/outside/file") == precious && -L "$releases/$fake-20200101T000000Z-1" ]]
[[ -d "$releases/keep-me" && -f "$fixture/base/incoming/unrelated.txt" ]]
[[ -f "$fixture/base/previous/20200101T000000Z-$fake/app.cjs" ]]
[[ ! -e "$fixture/base/incoming/$second.tar.gz" && -f "$fixture/base/incoming/$eighth.tar.gz" ]]
[[ -f "$fixture/app/app.cjs" && -d "$fixture/app/node_modules" ]]
grep -q "$eighth" "$fixture/app/release.json"
# Both kept rollbacks are complete and reachable through their snapshots.
for old in "$sixth" "$seventh"; do
  snapshot=$(grep -l "$old" "$fixture"/base/previous/*/release.json)
  [[ -f "$(dirname "$snapshot")/app.cjs" && -d "$(dirname "$snapshot")/node_modules" ]]
done

# A failed cutover rolls back and cleans nothing.
ninth=$(printf 'a%.0s' {1..40})
archive "$ninth"
touch "$fixture/fail-health"
before=$(ls "$releases" | grep -v "^$ninth" | sort)
if bash "$fixture/deploy.sh" "$ninth" > /dev/null 2>&1; then exit 1; fi
rm "$fixture/fail-health"
[[ $(ls "$releases" | grep -v "^$ninth" | sort) == "$before" ]]
grep -q "$eighth" "$fixture/app/release.json"

# If no rollback can be identified, nothing is removed and the deploy succeeds.
mv "$fixture/base/previous" "$fixture/base/previous-away"
tenth=$(printf 'b%.0s' {1..40})
archive "$tenth"
rm "$fixture/app/node_modules" && mkdir "$fixture/app/node_modules"
before=$(ls "$releases" | sort)
bash "$fixture/deploy.sh" "$tenth" > "$fixture/deploy.log"
grep -q 'Cleanup skipped: no rollback release found' "$fixture/deploy.log"
grep -q 'the verified release stays live' "$fixture/deploy.log"
[[ $(ls "$releases" | grep -v "^$tenth" | sort) == "$before" ]]
grep -q "$tenth" "$fixture/app/release.json"
echo 'Deployment checks passed: cutover, backups, migration failure, rollback, env preservation, queued deployment, corrupt archive rejection and safe cleanup.'
