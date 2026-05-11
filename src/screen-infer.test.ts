// src/screen-infer.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { inferCurrentUrl } from "./screen-infer.js";

test("gpu 트렌드 + pcode 명시 → gpu/trend URL", () => {
  const r = inferCurrentUrl("k8s-gpu (3396 프로젝트) gpu 트렌드 맵 기준 비용 최적화");
  assert.ok(r);
  assert.equal(r.product, "cpm");
  assert.equal(r.key, "gpu/trend");
  assert.equal(r.pcode, 3396);
  assert.equal(r.currentUrl, "/v2/project/cpm/3396/gpu/trend");
});

test("gpu/trend slash 형식도 매칭", () => {
  const r = inferCurrentUrl("pcode 3396 의 gpu/trend 화면 분석");
  assert.ok(r);
  assert.equal(r.key, "gpu/trend");
});

test("영어 'gpu trend' 매칭", () => {
  const r = inferCurrentUrl("show me GPU trend for project 3396");
  assert.ok(r);
  assert.equal(r.key, "gpu/trend");
});

test("gpu 워크로드 매칭", () => {
  const r = inferCurrentUrl("프로젝트 3396 gpu 워크로드 분포");
  assert.ok(r);
  assert.equal(r.key, "gpu/workload");
});

test("gpu 대시보드 매칭", () => {
  const r = inferCurrentUrl("3396 gpu 대시보드 보여줘");
  assert.ok(r);
  assert.equal(r.key, "gpu/dashboard");
});

test("컨테이너 맵 매칭", () => {
  const r = inferCurrentUrl("pcode 3396 컨테이너 맵");
  assert.ok(r);
  assert.equal(r.key, "containerMap");
});

test("pcode 없으면 undefined — 잘못된 화면 매칭 방지", () => {
  const r = inferCurrentUrl("gpu 트렌드 분석해줘");
  assert.equal(r, undefined);
});

test("화면 keyword 없으면 undefined — pcode 만으로는 매칭 X", () => {
  const r = inferCurrentUrl("프로젝트 3396 상태");
  assert.equal(r, undefined);
});

test("pcode=0 같은 잘못된 값 거부", () => {
  const r = inferCurrentUrl("gpu 트렌드 프로젝트 0");
  assert.equal(r, undefined);
});

test("우선순위: workload > dashboard (둘 다 매칭 가능한 키워드)", () => {
  // "gpu 워크로드" 가 "gpu 대시보드" 보다 위 — 워크로드가 매칭되어야
  const r = inferCurrentUrl("3396 gpu 워크로드 대시보드 비교");
  assert.ok(r);
  assert.equal(r.key, "gpu/workload");
});

test("pcode 다양한 형식 모두 매칭 — '(3396 프로젝트)' 패턴", () => {
  const r = inferCurrentUrl("k8s-gpu (3396 프로젝트) gpu 트렌드");
  assert.ok(r);
  assert.equal(r.pcode, 3396);
});

test("pcode 'pcode=3396' 형식 매칭", () => {
  const r = inferCurrentUrl("pcode=3396 gpu 트렌드 알려줘");
  assert.ok(r);
  assert.equal(r.pcode, 3396);
});

test("pcode 6자리 (예: 100000) 도 매칭", () => {
  const r = inferCurrentUrl("프로젝트 123456 의 gpu 트렌드");
  assert.ok(r);
  assert.equal(r.pcode, 123456);
});
