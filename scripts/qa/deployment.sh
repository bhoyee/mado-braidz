#!/usr/bin/env bash
# Exercise real cutover/rollback logic with fake packages and HTTP, never a real DB.
set -euo pipefail
source_script=${1:-scripts/deploy-production.sh}
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
export DEPLOY_FIXTURE="$fixture"
mkdir -p "$fixture/base/incoming" "$fixture/base/releases" "$fixture/app" "$fixture/bin"
printf 'private-env-must-survive\n' > "$fixture/app/.env"
for entry in app.cjs package.json package-lock.json release.json; do
  printf 'original\n' > "$fixture/app/$entry"
done
mkdir "$fixture/app/src" "$fixture/app/scripts" "$fixture/app/public" "$fixture/app/node_modules"
python3 - "$source_script" "$fixture" <<'PY'
import sys
source, fixture = sys.argv[1:]
with open(source) as f:
    script = f.read()
script = script.replace('/home/madoafri/mado-deploy', fixture + '/base')
script = script.replace('/home/madoafri/mado-app', fixture + '/app')
script = script.replace('export PATH=/opt/alt/alt-nodejs20/root/usr/bin:$PATH',
                        'export PATH="' + fixture + '/bin:$PATH"')
script = script.replace('{1..24}', '{1..2}').replace('sleep 5', 'sleep 0')
with open(fixture + '/deploy.sh', 'w') as f:
    f.write(script)
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
  tar -czf "$fixture/base/incoming/$revision.tar.gz" -C "$fixture/package" .
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
echo 'Deployment checks passed: cutover, pre-migration backup, migration failure, health rollback and env preservation.'
