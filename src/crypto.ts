// src/crypto.ts
//
// 사용자 WhaTap creds 의 AES-256-GCM envelope encryption.
//
// 운영 위협 모델: 봇 호스트 침해 시 user_tokens.sqlite 파일 노출 →
// 모든 사용자 cookie/API token 평문 유출. 호스트 침해를 100% 막진 못해도,
// "DB 파일만 유출" 시나리오 (백업 누설, 디스크 마운트 등) 에서 별 가치.
//
// 점진 전환 정책:
//   - SLACK_TOKENS_ENCRYPTION_KEY 미설정 → 그대로 plaintext (legacy / dev).
//   - 설정됨 → 새 row 부터 encrypt. legacy plaintext row 도 계속 read 가능
//     (decryptToken 이 'enc:' prefix 없으면 그대로 반환). 마이그레이션 함수 X.
//
// 한계:
//   - 메모리상엔 평문 — process 메모리 dump 시 노출.
//   - 키 자체가 .env / systemd EnvironmentFile 평문 → 호스트 침해 시 같이 노출.
//     vault / KMS 통합은 별 작업.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/** secret 문자열에서 32-byte key 유도. sha256 — 키 길이 정규화 + 결정적 derivation. */
export function deriveKey(secret: string): Buffer {
  if (!secret) {
    throw new Error("deriveKey: empty secret");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/** plaintext 를 'enc:base64(iv(12) || tag(16) || ct)' 형식으로 암호화. */
export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return "enc:" + Buffer.concat([iv, tag, ct]).toString("base64");
}

/** 'enc:...' prefix 면 decrypt, 아니면 그대로 반환 (legacy plaintext 호환). */
export function decryptToken(blob: string, key: Buffer | null): string {
  if (!blob.startsWith("enc:")) {
    // legacy plaintext — key 유무 무관하게 그대로.
    return blob;
  }
  if (!key) {
    throw new Error(
      "decryptToken: blob 이 암호화되어 있지만 SLACK_TOKENS_ENCRYPTION_KEY 미설정",
    );
  }
  const buf = Buffer.from(blob.slice(4), "base64");
  if (buf.length < 28) {
    throw new Error(
      `decryptToken: ciphertext too short (got ${buf.length} bytes, need >= 28)`,
    );
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const dec = createDecipheriv("aes-256-gcm", key, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString("utf8");
}
