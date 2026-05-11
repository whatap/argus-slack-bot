// src/crypto.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { decryptToken, deriveKey, encryptToken } from "./crypto.js";

test("encrypt → decrypt roundtrip", () => {
  const key = deriveKey("test-secret-1");
  const plaintext = "JSESSIONID=abcdef.node-A1; Path=/; HttpOnly";
  const enc = encryptToken(plaintext, key);
  assert.ok(enc.startsWith("enc:"), "enc: prefix 있어야");
  const dec = decryptToken(enc, key);
  assert.equal(dec, plaintext);
});

test("같은 plaintext 두 번 encrypt → 서로 다른 ciphertext (IV 다름)", () => {
  const key = deriveKey("s");
  const a = encryptToken("hello", key);
  const b = encryptToken("hello", key);
  assert.notEqual(a, b);
  assert.equal(decryptToken(a, key), "hello");
  assert.equal(decryptToken(b, key), "hello");
});

test("wrong key → decrypt throw", () => {
  const k1 = deriveKey("key-one");
  const k2 = deriveKey("key-two");
  const enc = encryptToken("secret", k1);
  assert.throws(() => decryptToken(enc, k2));
});

test("legacy plaintext (no enc: prefix) → 그대로 반환", () => {
  const key = deriveKey("any-key");
  assert.equal(decryptToken("plain-token", key), "plain-token");
  // key 없어도 plaintext 는 통과
  assert.equal(decryptToken("plain-token", null), "plain-token");
});

test("encrypted blob 에 key 없으면 throw", () => {
  const key = deriveKey("k");
  const enc = encryptToken("x", key);
  assert.throws(
    () => decryptToken(enc, null),
    /SLACK_TOKENS_ENCRYPTION_KEY 미설정/,
  );
});

test("ciphertext 짧으면 throw — 변조 / corruption 가드", () => {
  const key = deriveKey("k");
  assert.throws(
    () => decryptToken("enc:" + Buffer.from("short").toString("base64"), key),
    /ciphertext too short/,
  );
});

test("AAD tag 변조 시 throw (GCM auth)", () => {
  const key = deriveKey("k");
  const enc = encryptToken("hello", key);
  // base64 디코드 → tag 부분 (offset 12~28) 한 바이트 뒤집기 → 재인코딩
  const raw = Buffer.from(enc.slice(4), "base64");
  raw[15] ^= 0xff;
  const tampered = "enc:" + raw.toString("base64");
  assert.throws(() => decryptToken(tampered, key));
});

test("UTF-8 (한국어) 안전", () => {
  const key = deriveKey("k");
  const plain = "한글 토큰: 안녕하세요 🎉";
  const enc = encryptToken(plain, key);
  assert.equal(decryptToken(enc, key), plain);
});

test("deriveKey 빈 문자열 → throw", () => {
  assert.throws(() => deriveKey(""), /empty secret/);
});
