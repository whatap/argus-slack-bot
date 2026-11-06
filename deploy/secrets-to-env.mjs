// stdin 의 Secrets Manager JSON → systemd EnvironmentFile 형식(KEY=value 줄).
// 허용 키 5개만 받고, 하나라도 비면 실패한다. 값은 어디에도 출력하지 않는다(오류에는 키 이름만).
// 값은 따옴표 없이 쓰므로 영문·숫자와 + / = _ . ~ - 만 허용한다 (systemd 파서의 따옴표·$·역슬래시 해석을 피한다).
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SECRET_KEYS = [
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_SECRET",
  "SLACK_STATE_SECRET",
  "SLACK_TOKENS_ENCRYPTION_KEY",
  "WHATAP_OAUTH_CLIENT_SECRET",
];

const SAFE_VALUE = /^[A-Za-z0-9+/=_.~-]+$/;

export function secretsToEnv(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("비밀이 JSON 이 아니에요");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("비밀이 JSON 객체가 아니에요");
  const unknown = Object.keys(obj).filter((k) => !SECRET_KEYS.includes(k));
  if (unknown.length) throw new Error(`허용하지 않는 키: ${unknown.join(", ")}`);
  const missing = SECRET_KEYS.filter((k) => typeof obj[k] !== "string" || obj[k] === "");
  if (missing.length) throw new Error(`비어 있거나 없는 키: ${missing.join(", ")}`);
  const unsafe = SECRET_KEYS.filter((k) => !SAFE_VALUE.test(obj[k]));
  if (unsafe.length) throw new Error(`값에 쓸 수 없는 문자가 있는 키 (영문·숫자·+/=_.~- 만): ${unsafe.join(", ")}`);
  return SECRET_KEYS.map((k) => `${k}=${obj[k]}`).join("\n") + "\n";
}

// systemd 는 current 심볼릭 링크 경로로 실행한다. import.meta.url 은 링크를 푼 실제 경로라서 argv[1] 도 풀어서 비교한다.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.stdout.write(secretsToEnv(readFileSync(0, "utf8")));
  } catch (err) {
    console.error(`[asb] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
