// 운영 SQLite 온라인 백업 — better-sqlite3 backup API 로 서비스가 쓰는 중에도 일관된 사본을 만든다.
//   node deploy/backup-db.mjs <out-dir> <db 경로>...
// 같은 경로는 한 번만 뜨고 빈 인자는 무시한다. 사본마다 integrity_check 가 ok 여야 한다.
// CLI 는 있는 DB 를 다 뜬 뒤, 없는 DB 가 하나라도 있거나 뜬 DB 가 없으면 종료 코드 1 로 끝난다.
import Database from "better-sqlite3";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export async function backupDatabases(outDir, paths, log = console.log) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const seen = new Set();
  const results = [];
  for (const src of paths) {
    if (!src || seen.has(src)) continue;
    seen.add(src);
    if (!existsSync(src)) {
      log(`[asb-backup] skip (없음) ${src}`);
      results.push({ src, status: "missing" });
      continue;
    }
    const dest = join(outDir, basename(src));
    const db = new Database(src, { readonly: true, fileMustExist: true });
    try {
      await db.backup(dest);
    } finally {
      db.close();
    }
    const copy = new Database(dest, { readonly: true, fileMustExist: true });
    let check;
    try {
      check = copy.pragma("integrity_check", { simple: true });
    } finally {
      copy.close();
    }
    if (check !== "ok") throw new Error(`integrity_check=${check} (${src})`);
    log(`[asb-backup] ok ${basename(src)} ${statSync(dest).size}B`);
    results.push({ src, dest, status: "ok" });
  }
  return results;
}

// systemd 는 current 심볼릭 링크 경로로 실행한다. import.meta.url 은 링크를 푼 실제 경로라서 argv[1] 도 풀어서 비교한다.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [outDir, ...paths] = process.argv.slice(2);
  if (!outDir || paths.length === 0) {
    console.error("usage: node deploy/backup-db.mjs <out-dir> <db 경로>...");
    process.exit(2);
  }
  backupDatabases(outDir, paths)
    .then((results) => {
      const missing = results.filter((r) => r.status === "missing").map((r) => r.src);
      if (missing.length) {
        console.error(`[asb-backup] FAIL 없는 DB: ${missing.join(", ")}`);
        process.exit(1);
      }
      if (!results.some((r) => r.status === "ok")) {
        console.error("[asb-backup] FAIL 백업한 DB 가 없어요");
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`[asb-backup] FAIL ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
