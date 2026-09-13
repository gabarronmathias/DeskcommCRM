#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TARGET_REF=""
CONFIRMED=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --to) shift; TARGET_REF="${1:-}" ;;
    --confirm) CONFIRMED=1 ;;
    *) echo "uso: bash scripts/production/rollback.sh [--to vX.Y.Z] --confirm" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$TARGET_REF" ] && [ -f .release-state/previous-ref ]; then
  TARGET_REF="$(tr -d '\r\n' < .release-state/previous-ref)"
fi
case "$TARGET_REF" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "erro: versão anterior ausente; use --to vX.Y.Z" >&2; exit 2 ;;
esac
[ -n "$CONFIRMED" ] || { echo "erro: rollback exige --confirm" >&2; exit 2; }

git fetch --tags --quiet origin
git rev-parse --verify "${TARGET_REF}^{commit}" >/dev/null
bash hostgator-setup-kit/update.sh --to "$TARGET_REF" --force
# A versão anterior pode ser mais antiga que estes wrappers. O healthcheck do
# kit existe nas releases suportadas e continua disponível depois do checkout.
bash hostgator-setup-kit/healthcheck.sh

mkdir -p .release-state
umask 077
printf '%s\n' "$TARGET_REF" > .release-state/current-ref
echo "rollback concluído: $TARGET_REF"
