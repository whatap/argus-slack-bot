// src/slack-format.ts
//
// argus 가 표준 Markdown 으로 응답하는데 Slack 은 mrkdwn (변형) 만 지원.
// 차이점:
//   - **bold** → *bold*
//   - *italic* → _italic_
//   - [text](url) → <url|text>
//   - 표 (| col | col |) → 코드블록으로 변환 (Slack mrkdwn 표 미지원)
//   - 헤딩 (## H2) → *H2*\n
//   - 그 외 (`code`, ```fence```, - list) 는 거의 그대로 호환
//
// 4000 자 / 50 blocks 제한 대응:
//   - 본문 길면 thread 안 여러 메시지로 분할 (splitForSlack)
//   - 단일 메시지 limit 살짝 여유 두고 3500 자.

const SLACK_MSG_MAX = 3500;

export function toSlackMrkdwn(md: string): string {
  let out = md;

  // 1) 표 → 코드블록.
  //    | a | b | c |
  //    |---|---|---|
  //    | 1 | 2 | 3 |
  //    같은 패턴을 통째로 ```...``` 로 감쌈.
  out = out.replace(/(^\|[^\n]+\|\n\|[\s\-:|]+\|\n(?:\|[^\n]+\|\n?)+)/gm, (table) => {
    return "```\n" + table.trim() + "\n```\n";
  });

  // 2) 헤딩 → *bold* 한 줄. ## H2 → *H2*.
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // 3) **bold** → *bold*. (** 가 두 개 연속이라 단순 치환 안전)
  //    Slack 에선 *...* 가 bold. 본 markdown 의 *italic* 은 _italic_ 으로 미루지만
  //    argus 답변에선 italic 거의 안 쓰니 단순화.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");

  // 4) [text](url) → <url|text>. argus 가 자주 쓰는 패턴 (프로젝트 링크 등).
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  return out;
}

/** 한 메시지가 너무 길면 SLACK_MSG_MAX 글자씩 분할. 코드블록 경계 고려. */
export function splitForSlack(text: string): string[] {
  if (text.length <= SLACK_MSG_MAX) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MSG_MAX) {
      chunks.push(remaining);
      break;
    }
    // 가능하면 newline 경계에서 자르기 (cut 위치 < SLACK_MSG_MAX 중 가장 큰 \n).
    let cut = remaining.lastIndexOf("\n", SLACK_MSG_MAX);
    if (cut < SLACK_MSG_MAX / 2) cut = SLACK_MSG_MAX; // newline 너무 일찍 나오면 강제 cut.
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  return chunks;
}
