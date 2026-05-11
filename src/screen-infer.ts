// src/screen-infer.ts
//
// Slack 봇은 브라우저 URL 컨텍스트가 없어 argus 의 screens.Lookup() 가 nil
// 반환 → cpm.yaml 의 domain_knowledge / analysis_guides / data_registry 가
// system prompt 에 inject 안 됨. (whatap-front 패널은 browser URL 자동으로
// 박혀서 cost optimization / scale safety 가이드 자연스레 적용)
//
// 이 모듈은 사용자 메시지 텍스트에서 화면 의도 + pcode 를 추론해 가짜
// currentUrl 을 만들어 argus 에 전달. argus 의 screens.Lookup() 이 그 URL
// 로 매칭 → 화면 컨텍스트 inject. whatap-front 와 같은 효과.
//
// 매칭은 보수적 — 화면 키워드 + pcode 둘 다 명확할 때만 박음. 잘못된
// 화면 매칭은 LLM 을 잘못된 도메인 가이드 쪽으로 끌고 가므로 추측 금지.

interface ScreenKeyword {
  /** 사용자 메시지 매칭 정규식. */
  pattern: RegExp;
  /** URL 의 product slug (e.g. cpm, apm, database, server). */
  product: string;
  /** screen key (cpm.yaml 의 `- key:`). */
  key: string;
}

// 우선순위: 위에서 아래로 첫 매칭 use. 더 구체적인 패턴을 위에 둠.
// 추가 화면 / 한국어 변형은 여기서 확장.
const SCREEN_KEYWORDS: ScreenKeyword[] = [
  // GPU 화면 — 자주 사용
  {
    pattern: /\bgpu[\s/_-]*트렌드|\bgpu[\s/_-]*trend\b|gpu[\s/_-]*트렌드[\s]*맵|gpu[\s/_-]*trend[\s]*map/i,
    product: "cpm",
    key: "gpu/trend",
  },
  {
    pattern: /\bgpu[\s/_-]*워크로드|\bgpu[\s/_-]*workload\b/i,
    product: "cpm",
    key: "gpu/workload",
  },
  {
    pattern: /\bgpu[\s/_-]*대시보드|\bgpu[\s/_-]*dashboard\b|\bgpu[\s/_-]*맵\b|\bgpu[\s/_-]*map\b/i,
    product: "cpm",
    key: "gpu/dashboard",
  },
  // 컨테이너 맵
  {
    pattern: /컨테이너[\s]*맵|container[\s]*map\b|containerMap/i,
    product: "cpm",
    key: "containerMap",
  },
  // Pod / 컨테이너 목록
  {
    pattern: /\bpod[\s]*리스트|\bpod[\s]*list\b|파드[\s]*목록/i,
    product: "cpm",
    key: "pod/list",
  },
];

// pcode 추출 패턴 — 우선순위 높은 순. 명시적 키워드 매칭 우선, 단독 숫자는
// 마지막 fallback (false positive 위험은 화면 keyword 매칭 후만 적용되니 적음).
const PCODE_PATTERNS: RegExp[] = [
  /\bpcode[\s:=]+(\d{3,6})\b/i, // "pcode 3396", "pcode=3396"
  /프로젝트[\s]*(\d{3,6})\b/, // "프로젝트 3396"
  /\((\d{3,6})\b[^)]*\)/, // "(3396 프로젝트)"
  /\b(\d{4,6})\s*프로젝트/, // "3396 프로젝트"
  /\bproject[\s]+(\d{3,6})\b/i, // "project 3396" (영어)
  /\b(\d{4,6})\b/, // 단독 4-6자리 숫자 — 화면 매칭 됐을 때만 시도
];

export interface InferredScreen {
  currentUrl: string;
  pcode: number;
  product: string;
  key: string;
}

/** 사용자 메시지 텍스트에서 화면 의도 + pcode 추론.
 *  둘 다 매칭되어야 currentUrl 반환 — pcode 없거나 화면 모호하면 undefined.
 *  argus 가 screens.Lookup() 으로 매칭하니 정확한 URL 형식 필수. */
export function inferCurrentUrl(text: string): InferredScreen | undefined {
  // 화면 매칭
  let product: string | undefined;
  let key: string | undefined;
  for (const sk of SCREEN_KEYWORDS) {
    if (sk.pattern.test(text)) {
      product = sk.product;
      key = sk.key;
      break;
    }
  }
  if (!product || !key) return undefined;

  // pcode 추출
  let pcode: number | undefined;
  for (const p of PCODE_PATTERNS) {
    const m = text.match(p);
    if (m && m[1]) {
      const n = Number(m[1]);
      if (n > 0 && n < 1000000) {
        pcode = n;
        break;
      }
    }
  }
  if (!pcode) return undefined;

  return {
    currentUrl: `/v2/project/${product}/${pcode}/${key}`,
    pcode,
    product,
    key,
  };
}
