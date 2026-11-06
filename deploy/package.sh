#!/usr/bin/env bash
# 배포 묶음(tar.gz) 만들기 — CI(ci.yml·deploy-prod.yml)와 로컬이 같은 스크립트를 쓴다.
#   deploy/package.sh <arm64|x64> <출력 디렉터리>
# 전제: 이 커밋에서 pnpm run build 를 마친 작업 트리(dist/). 작업 트리가 깨끗해야 한다(ALLOW_DIRTY=1 로 무시).
# 결과: <출력>/argus-slack-bot-<rev>-linux-<arch>.tar.gz 와 .sha256
#   node/bin/node   nodejs.org 공식 linux 바이너리 (SHASUMS256.txt 대조) — 서버에 Node 를 따로 깔지 않는다
#   node_modules    운영 의존성만. better-sqlite3 는 대상 아키텍처 prebuilt (모든 .node 의 ELF 아키텍처 확인)
#   BUILD-INFO      rev·arch·node·필요 glibc — remote-install.sh 가 서버 아키텍처와 대조한다
set -euo pipefail

ARCH=${1:?arm64 또는 x64}
OUT=${2:?출력 디렉터리}
NODE_VERSION=${NODE_VERSION:-22.23.4}
case "$ARCH" in
  arm64) ELF='ARM aarch64' ;;
  x64) ELF='x86-64' ;;
  *) echo "arch 는 arm64 또는 x64" >&2; exit 2 ;;
esac

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
max_glibc() { LC_ALL=C grep -aoE 'GLIBC_[0-9]+\.[0-9]+(\.[0-9]+)?' "$1" | sed 's/GLIBC_//' | sort -u -t. -k1,1n -k2,2n -k3,3n | tail -n 1; }
elf_check() {  # <파일>
  local desc
  desc=$(file -b "$1")
  case "$desc" in *ELF*"$ELF"*) echo "  ok ${1#"$STAGE"/}: $(max_glibc "$1" | sed 's/^/glibc>=/')" ;; *) echo "아키텍처 불일치 ($ARCH): $1: $desc" >&2; exit 1 ;; esac
}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
[ -f dist/index.js ] || { echo "dist/index.js 없음 — pnpm run build 먼저" >&2; exit 1; }
if [ "${ALLOW_DIRTY:-0}" != 1 ] && [ -n "$(git status --porcelain)" ]; then
  echo "작업 트리가 깨끗하지 않아요 (묶음이 커밋과 달라진다):" >&2
  git status --short >&2
  exit 1
fi
REV=$(git rev-parse --short=12 HEAD)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/bundle"
mkdir -p "$STAGE/deploy" "$STAGE/node/bin"

echo "[package] rev=$REV arch=$ARCH node=v$NODE_VERSION"
cp -R dist "$STAGE/dist"
cp package.json pnpm-lock.yaml "$STAGE/"
cp deploy/remote-install.sh deploy/load-secrets.sh deploy/secrets-to-env.mjs deploy/backup.sh deploy/backup-db.mjs \
  deploy/config.env.example "$STAGE/deploy/"
cp -R deploy/systemd "$STAGE/deploy/systemd"
# git 의 파일 모드와 상관없이 systemd 가 실행하는 스크립트는 실행 가능하게 둔다
chmod 0755 "$STAGE"/deploy/*.sh
chmod 0644 "$STAGE"/deploy/*.mjs "$STAGE"/deploy/config.env.example "$STAGE"/deploy/systemd/*

# 운영 의존성 — prebuild-install 이 npm_config_arch/platform 을 따라 대상 linux/<arch> 용 better-sqlite3 를 받는다.
# 빌드 스크립트 허용은 package.json 의 pnpm.onlyBuiltDependencies.
# side-effects-cache 를 끈다: 켜 두면 store 에 남은 호스트용 빌드 결과(macOS·linux-x64)를 그대로 복사해 온다.
(
  cd "$STAGE"
  npm_config_arch="$ARCH" npm_config_platform=linux \
    pnpm install --prod --frozen-lockfile --config.node-linker=hoisted --config.package-import-method=copy \
      --config.side-effects-cache=false --reporter=append-only
)
[ -n "$(find "$STAGE/node_modules" -name better_sqlite3.node -type f)" ] \
  || { echo "better_sqlite3.node 없음 — 빌드 스크립트가 막혔는지 확인 (pnpm.onlyBuiltDependencies)" >&2; exit 1; }
echo "[package] native modules:"
find "$STAGE/node_modules" -name '*.node' -type f | sort > "$WORK/natives"
while IFS= read -r f; do elf_check "$f"; done < "$WORK/natives"

# Node 런타임 — 공식 배포본을 SHASUMS256.txt 로 대조한다
dist_name="node-v$NODE_VERSION-linux-$ARCH"
base_url="https://nodejs.org/dist/v$NODE_VERSION"
curl -fsSL "$base_url/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
curl -fsSL "$base_url/$dist_name.tar.xz" -o "$WORK/$dist_name.tar.xz"
expected=$(awk -v f="$dist_name.tar.xz" '$2 == f { print $1 }' "$WORK/SHASUMS256.txt")
actual=$(sha256 "$WORK/$dist_name.tar.xz")
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "Node 배포본 sha256 불일치: $dist_name" >&2; exit 1; }
tar -xJf "$WORK/$dist_name.tar.xz" -C "$WORK" "$dist_name/bin/node" "$dist_name/LICENSE"
mv "$WORK/$dist_name/bin/node" "$STAGE/node/bin/node"
mv "$WORK/$dist_name/LICENSE" "$STAGE/node/LICENSE"
echo "[package] node runtime:"
elf_check "$STAGE/node/bin/node"

glibc_node=$(max_glibc "$STAGE/node/bin/node")
glibc_native=$(while IFS= read -r f; do max_glibc "$f"; done < "$WORK/natives" | sort -u -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
cat > "$STAGE/BUILD-INFO" <<EOF
rev=$REV
arch=$ARCH
node=v$NODE_VERSION
glibc_min=$(printf '%s\n%s\n' "$glibc_node" "$glibc_native" | sort -u -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
[ ! -e "$STAGE/.env" ] || { echo ".env 가 묶음에 들어갔어요" >&2; exit 1; }

name="argus-slack-bot-$REV-linux-$ARCH.tar.gz"
export COPYFILE_DISABLE=1
tar -czf "$OUT/$name" -C "$STAGE" .
(cd "$OUT" && printf '%s  %s\n' "$(sha256 "$name")" "$name" > "$name.sha256")
echo "[package] $(cat "$STAGE/BUILD-INFO" | tr '\n' ' ')"
echo "[package] $OUT/$name ($(du -h "$OUT/$name" | cut -f1)) sha256=$(cut -d' ' -f1 "$OUT/$name.sha256")"
