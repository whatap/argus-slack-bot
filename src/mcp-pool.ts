// src/mcp-pool.ts
//
// 사용자별 WhatapMcpClient keep-warm 풀. 매 요청마다 stdio child spawn 하면
// 0.5-1s 오버헤드 → 사용자가 연달아 멘션할 때 누적 부담. 풀로 재사용해 응답
// 시작까지 시간 단축.
//
// 격리 보장:
//   - pool key = slackUserId. 사용자별 별도 child — env (WHATAP_API_TOKEN,
//     ARGUS_COOKIE) 가 한 사용자 전용으로 spawn 시 고정.
//   - envHash 로 creds 변경 (cookie 갱신, register 등) 감지 → 재spawn.
//
// 메모리 관리:
//   - idle 5분 (idleMs) 지난 entry 는 lazy gc (acquire 시) + 1분 interval gc.
//   - shutdown 시 closeAll() 명시 호출.
//   - gcInterval.unref() — 봇 종료 시 process exit 막지 않게.

import { createHash } from "node:crypto";

import { WhatapMcpClient } from "./mcp-client.js";

interface PoolEntry {
  client: WhatapMcpClient;
  envHash: string;
  lastUsed: number;
}

export class McpClientPool {
  private clients = new Map<string, PoolEntry>();
  private gcTimer: NodeJS.Timeout;

  constructor(
    private scriptPath: string,
    /** idle 이 이 ms 넘으면 close. 기본 5분. */
    private idleMs: number = 5 * 60 * 1000,
    /** 강제 gc 주기. lazy gc 만으로는 트래픽 없는 사용자 정리 불가. */
    gcIntervalMs: number = 60 * 1000,
  ) {
    this.gcTimer = setInterval(() => this.gcIdle(), gcIntervalMs);
    this.gcTimer.unref();
  }

  /** 사용자별 client 획득. 같은 env 면 재사용, 다르면 재spawn. */
  async acquire(
    slackUserId: string,
    env: Record<string, string>,
  ): Promise<WhatapMcpClient> {
    const h = this.envHash(env);
    const entry = this.clients.get(slackUserId);
    if (entry) {
      if (entry.envHash === h) {
        entry.lastUsed = Date.now();
        this.gcIdle();
        return entry.client;
      }
      // creds 변경됨 → 옛 child 정리
      console.log(
        `[mcp-pool] creds changed for ${slackUserId} → respawn`,
      );
      await entry.client.close().catch(() => {});
      this.clients.delete(slackUserId);
    }
    const client = new WhatapMcpClient({ scriptPath: this.scriptPath, env });
    await client.connect();
    this.clients.set(slackUserId, {
      client,
      envHash: h,
      lastUsed: Date.now(),
    });
    this.gcIdle();
    return client;
  }

  /** acquire 한 client 사용 후 호출. 풀 정책상 즉시 close 안 하고 lastUsed 만 갱신. */
  release(slackUserId: string): void {
    const e = this.clients.get(slackUserId);
    if (e) e.lastUsed = Date.now();
  }

  /** 사용자 강제 evict — cookie/register 명령 등에서 호출 가능. 다음 acquire
   *  에서 새 child spawn 보장. (현재는 envHash 기반 자동 감지로 충분) */
  async evict(slackUserId: string): Promise<void> {
    const e = this.clients.get(slackUserId);
    if (!e) return;
    await e.client.close().catch(() => {});
    this.clients.delete(slackUserId);
  }

  /** 봇 shutdown 시 모든 child 종료. */
  async closeAll(): Promise<void> {
    clearInterval(this.gcTimer);
    const entries = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(
      entries.map((e) => e.client.close().catch(() => {})),
    );
  }

  /** 현재 풀 크기 — 부팅/디버그 로그용. */
  size(): number {
    return this.clients.size;
  }

  private gcIdle(): void {
    const cutoff = Date.now() - this.idleMs;
    for (const [k, e] of this.clients) {
      if (e.lastUsed < cutoff) {
        console.log(
          `[mcp-pool] idle evict ${k} (last ${Math.round((Date.now() - e.lastUsed) / 1000)}s ago)`,
        );
        e.client.close().catch(() => {});
        this.clients.delete(k);
      }
    }
  }

  private envHash(env: Record<string, string>): string {
    // 키 순서 무관하게 안정적 hash. JSON.stringify 는 키 순서가 input 순서라
    // 둘 다 sort 해서 stringify.
    const sorted: Record<string, string> = {};
    for (const k of Object.keys(env).sort()) sorted[k] = env[k];
    return createHash("sha256")
      .update(JSON.stringify(sorted))
      .digest("hex")
      .slice(0, 16);
  }
}
