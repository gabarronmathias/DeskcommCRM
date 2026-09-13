#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

usage() {
  echo "uso: bash scripts/production/deploy.sh vX.Y.Z [--previous vA.B.C]" >&2
  exit 2
}

TARGET_REF="${1:-}"
[ -n "$TARGET_REF" ] || usage
shift

PREVIOUS_REF=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --previous)
      shift
      PREVIOUS_REF="${1:-}"
      [ -n "$PREVIOUS_REF" ] || usage
      ;;
    *) usage ;;
  esac
  shift
done

case "$TARGET_REF" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "erro: o alvo deve ser uma tag imutável vX.Y.Z" >&2; exit 2 ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "erro: worktree sujo; deploy cancelado" >&2
  exit 1
fi

git fetch --tags --quiet origin
git rev-parse --verify "${TARGET_REF}^{commit}" >/dev/null

if [ -z "$PREVIOUS_REF" ]; then
  PREVIOUS_REF="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
fi
case "$PREVIOUS_REF" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *)
    echo "erro: informe --previous vA.B.C para garantir rollback determinístico" >&2
    exit 2
    ;;
esac

mkdir -p .release-state
umask 077
printf '%s\n' "$PREVIOUS_REF" > .release-state/previous-ref

docker compose -f docker-compose.prod.yml --env-file .env config --quiet
bash hostgator-setup-kit/update.sh --to "$TARGET_REF"
bash scripts/production/healthcheck.sh --expect-version "${TARGET_REF#v}"

printf '%s\n' "$TARGET_REF" > .release-state/current-ref
echo "deploy concluído: $PREVIOUS_REF -> $TARGET_REF"
