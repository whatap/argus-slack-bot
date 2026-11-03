// Slack 첫 연결과 help 에서 같은 계정 생성 안내를 사용한다.
export const ACCOUNT_SETUP_GUIDANCE =
  "와탭 계정이 없으면 <https://service.whatap.io|와탭 콘솔>에서 가입하거나 조직 관리자에게 초대를 요청하세요. 프로젝트 접근 권한도 필요해요.";

export const WHATAP_LOGIN_HELP = [
  "*argus 봇 사용법*",
  "",
  "*와탭 계정 연결:*",
  "• `login` 와탭 계정으로 로그인해 봇과 연결해요. 링크는 나에게만 보여요.",
  "• `whoami` 연결된 와탭 계정을 확인해요.",
  "• `logout` 연결을 끊고 저장된 토큰을 지워요.",
  "",
  ACCOUNT_SETUP_GUIDANCE,
  "",
  "*질문:*",
  "• DM 으로 묻거나 채널에서 `@argus <질문>`",
  "• 답은 내 와탭 계정 권한으로 조회한 데이터예요. 채널에서 물으면 채널의 모든 사람이 답을 봐요.",
].join("\n");
