// src/turn-queue.ts
//
// 같은 대화의 턴을 한 번에 하나씩 돌린다.
//
// DM 본문은 메시지가 달라도 한 대화라, 답이 오기 전에 다음 메시지를 보내면 두 턴이 같은 argus 대화를
// 동시에 만진다. argus 는 같은 대화의 동시 턴을 막지 않고, 봇도 앞 턴이 끝나야 그 대화 ID 를 저장하므로
// 뒤 턴이 앞 턴을 모른 채 돌거나 새 대화를 따로 연다. 앞 턴이 끝난 뒤에 뒤 턴을 시작한다.
//
// 앞 턴이 멈춰 버려도 그 대화가 영영 막히지 않게 기다림에는 상한을 둔다. 상한을 넘기면 예전처럼 그냥 돈다.

export class TurnQueue {
  /** 대화마다 가장 최근에 줄 선 턴이 끝났는지. */
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly maxWaitMs: number) {}

  /**
   * 같은 key 의 앞 턴이 끝나기를(길어야 maxWaitMs) 기다린 뒤 돌아온다. 돌려준 함수는 턴이 끝날 때 부른다
   * (finally 에서). 부르지 않으면 다음 턴이 maxWaitMs 만큼 기다린다.
   */
  async enter(key: string): Promise<() => void> {
    const prev = this.tails.get(key);
    let finish!: () => void;
    const mine = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.tails.set(key, mine);
    if (prev) await waitAtMost(prev, this.maxWaitMs);
    return () => {
      finish();
      // 뒤에 줄 선 턴이 있으면 그 턴의 자리다. 지우지 않는다.
      if (this.tails.get(key) === mine) this.tails.delete(key);
    };
  }

  /** 턴이 돌거나 기다리는 대화 수. */
  get size(): number {
    return this.tails.size;
  }
}

function waitAtMost(done: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void done.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
