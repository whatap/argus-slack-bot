# 운영 배포 (AWS EC2 · ALB · GitHub Actions → S3 → SSM)

Argus 운영 배포와 같은 모양이다. GitHub Actions 가 OIDC 로 AWS 역할을 받아 묶음을 S3 에 올리고, SSM RunCommand 로 서버에서 `deploy/remote-install.sh` 를 실행한다. 서버 요청은 DEVOPS-6837.

```
Slack 서버 · 사용자 브라우저
  → https://argus-bot.whatap.io (ALB, TLS)
  → EC2 1대   :3000  /slack/*  /  /privacy  /terms  /support
              :3901  /oauth/start  /oauth/callback
EC2 → slack.com · service.whatap.io(와탭 로그인) · Argus /v1/agent
```

반드시 1대다. SQLite 파일과 진행 중인 로그인 상태(메모리)를 프로세스 하나가 들고 있어서 여러 대·오토스케일·서버리스는 안 된다.

## 묶음

`deploy/package.sh <arm64|x64> <출력>` 이 만든다 (CI 와 배포 워크플로가 같은 스크립트를 쓴다).

- `node/bin/node`: nodejs.org 공식 linux 바이너리(Node 22, SHASUMS256 대조). 서버에 Node 를 따로 설치하지 않는다.
- `node_modules`: 운영 의존성만. better-sqlite3 는 대상 아키텍처 prebuilt 이고, 모든 `.node` 의 ELF 아키텍처를 확인한다.
- `BUILD-INFO`: 커밋·아키텍처·Node 판·필요한 glibc(현재 2.29 이상). 서버가 자기 아키텍처와 대조한다.
- 크기: 압축 약 55MB, 풀면 약 195MB. 서버에는 최근 5개 판을 남긴다.

CI(`ci.yml`)는 PR 마다 두 아키텍처 묶음을 만들어 ubuntu 22.04 컨테이너(arm64 는 QEMU)에서 실제 진입점을 띄워 본다 (`deploy/test/smoke.sh`).

## DevOps 가 준비할 것

1. EC2 1대
   - arm64·x86_64 둘 다 된다. 배포할 때 서버 아키텍처를 읽어 맞는 묶음을 고른다.
   - glibc 2.29 이상 (Ubuntu 20.04 이상, Amazon Linux 2023)
   - SSM agent 등록(AmazonSSMManagedInstanceCore), aws cli v2, curl
   - 서비스 계정 `whatap` (unit 의 `User=`). 비밀 읽기(`load-secrets.sh`)와 백업이 이 계정으로 돌며 IMDS 로 인스턴스 역할을 쓴다. IMDS 를 root 로만 제한하지 않는다.
   - `/data` 영속 디스크: 묶음 5개(약 1GB) + SQLite 3개 + 서버 백업 7개
2. 보안그룹
   - 인바운드 3000·3901: ALB 보안그룹만
   - 아웃바운드 443: slack.com, service.whatap.io, Argus 주소(front 의 `argus_backend_url` 과 같은 곳)
3. ALB (호스트 `argus-bot.whatap.io`, 리스너 443, TLS 1.2 이상, `*.whatap.io` 인증서)
   - 대상 그룹 3000: `/slack/*`, `/`, `/privacy`, `/terms`, `/support`. 헬스체크 `/` 200
   - 대상 그룹 3901: `/oauth/*`. 헬스체크 `/oauth/callback`, 성공 코드 400 (state 없는 요청은 400 이 정상)
   - 요청 본문·헤더를 바꾸지 않는다 (Slack 서명 `X-Slack-Signature`, `X-Slack-Request-Timestamp`)
   - `/oauth/*`, `/slack/oauth_redirect` 는 접근 로그에 query 를 남기지 않는다 (일회용 code·state)
   - Cloudflare 를 거치면 `/slack/events` 에 봇 차단·챌린지를 걸지 않는다 (Slack 서버가 호출한다)
4. Secrets Manager 비밀 1개 — JSON, 키 5개. 값은 따로 전달한다.
   - `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET`, `SLACK_TOKENS_ENCRYPTION_KEY`, `WHATAP_OAUTH_CLIENT_SECRET`
   - 값은 영문·숫자와 `+ / = _ . ~ -` 만 쓴다. 다른 키가 섞이거나 하나라도 비면 서비스가 시작하지 않는다 (`deploy/secrets-to-env.mjs`).
5. S3 경로 두 개 (같은 버킷이어도 된다)
   - 배포 묶음 `S3_PREFIX`
   - 백업 `BACKUP_S3_URI`: 접근은 운영 계정만, 보관 기간은 lifecycle 로. 사본의 토큰은 암호화된 그대로지만 대화 기록은 평문이다.
6. IAM 역할 두 개
   - GitHub 배포 역할(`AWS_ROLE_ARN`)
     - trust: `token.actions.githubusercontent.com`, `aud = sts.amazonaws.com`, `sub = repo:whatap/argus-slack-bot:environment:production`
     - `s3:PutObject` on `arn:aws:s3:::<버킷>/<S3_PREFIX>/*`
     - `ssm:SendCommand` on `arn:aws:ssm:<region>::document/AWS-RunShellScript` 과 그 인스턴스
     - `ssm:GetCommandInvocation`
   - 인스턴스 역할
     - `AmazonSSMManagedInstanceCore`
     - `s3:GetObject` on `<버킷>/<S3_PREFIX>/*`
     - `secretsmanager:GetSecretValue` on 위 비밀
     - 비밀이 고객 관리형 KMS 키로 암호화돼 있으면 그 키의 `kms:Decrypt`
     - `s3:PutObject` on 백업 경로
7. GitHub environment `production` (저장소 Settings → Environments)
   - variables: `AWS_REGION`, `AWS_ROLE_ARN`, `S3_BUCKET`, `S3_PREFIX`, `INSTANCE_ID`
   - deployment branch: `main` 만 (필수). 다른 ref 에서 돌린 실행은 그 ref 의 스크립트를 운영 서버에서 root 로 실행한다. 워크플로의 main 검사는 실수 방지용이다.
   - 선택: 저장소 OIDC 의 sub 에 ref 를 넣어 IAM trust 로도 main 만 받을 수 있다. 먼저 IAM trust 의 sub 조건에 `repo:whatap/argus-slack-bot:environment:production:ref:refs/heads/main` 을 더하고(바꾸는 동안은 기존 값도 허용), `PUT /repos/{owner}/{repo}/actions/oidc/customization/sub` 에 `{"use_default": false, "include_claim_keys": ["repo", "context", "ref"]}` 를 보낸 뒤, 배포가 되면 기존 값을 뺀다.

## 서버 최초 준비 (1회)

`deploy/config.env.example` 을 채워 `/data/whatap/argus-slack-bot/conf/config.env` 로 둔다. 비밀값은 넣지 않는다.

```sh
id whatap || sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin whatap
sudo install -d -m 0755 -o root -g root /data/whatap /data/whatap/argus-slack-bot
sudo install -d -m 0750 -o root -g whatap /data/whatap/argus-slack-bot/conf
sudo install -m 0640 -o root -g whatap config.env /data/whatap/argus-slack-bot/conf/config.env
```

`/data/whatap`, `/data/whatap/argus-slack-bot`, `conf/` 는 root 소유이고 group·other 쓰기 권한이 없어야 한다 (`config.env` 도 같다). root 로 도는 배포 스크립트가 그 아래에 묶음을 풀고 unit 이 그 아래 파일을 실행·읽으므로, 아니면 배포·되돌리기가 `UNSAFE-DIR`(`config.env` 는 `UNSAFE-CONFIG`)로 멈춘다 (`releases/` 도 같다). `conf/` 는 배포마다 바뀌는 `releases/` 나 서비스 계정이 쓰는 `data/` 와 따로 두고, 배포는 건드리지 않는다.

첫 배포가 `releases/`, `data/`, `backups/` 를 만들고 systemd unit 3개(`argus-slack-bot.service`, `argus-slack-bot-backup.service`·`.timer`)를 설치·활성화한다. 이후 배포는 묶음의 unit 이 바뀌었을 때만 교체한다.

## 배포·상태·되돌리기

```sh
gh workflow run deploy-prod.yml --ref main -f action=status     # 서버 상태만 읽기
gh workflow run deploy-prod.yml --ref main -f action=deploy
gh workflow run deploy-prod.yml --ref main -f action=rollback
```

deploy 순서:
1. 테스트·타입·빌드 → arm64·x64 묶음 → 컨테이너 실행 확인
2. 서버 상태 읽기(아키텍처 확인) → 맞는 묶음을 S3 로
3. 서버(root): 디렉터리 소유·권한 확인 → sha256 대조 → `releases/<UTC시각>-<커밋>` 에 풀기 → 묶음 검사(.env 없음, 아키텍처, 서비스 계정으로 Node 22·better-sqlite3 로드). 묶음의 앱 코드(node)는 root 로 실행하지 않는다. 중단된 배포가 남긴 `*.partial` 은 이때 지운다.
4. `current` 교체 → 재시작 → 헬스체크(3000 `/` 200, 3901 `/oauth/callback` 400, 최대 60초)
5. 실패하면 직전 판으로 되돌린다. 직전 판이 헬스체크를 넘을 때만 실패한 판을 지우고, 아니면 둘 다 남긴다. Actions 로그에 재시작마다 그 이후의 서비스 로그를 30줄까지 싣는다(되돌리기까지 실패하면 두 번). 워크플로는 실패로 끝난다.
6. 첫 배포라 되돌릴 판이 없으면(`FIRST-DEPLOY-FAILED`) 서비스는 그 판으로 계속 다시 시작한다. config.env·비밀을 고치면 뜨므로 `action=status` 로 확인한다.

서비스는 시작 횟수 제한 없이 5초마다 다시 시작한다(`Restart=always`, `StartLimitIntervalSec=0`). 배포·되돌리기는 재시작 전에 `systemctl reset-failed` 를 부르고, 성공 여부는 헬스체크로 정한다.

rollback 은 `history` 기준으로 지금 판 직전에 돌던 판으로 바꾼다. 두 번 하면 원래 판으로 돌아온다. 되돌린 판이 헬스체크를 못 넘으면 원래 판으로 돌려놓고 다시 띄운 결과를 알린다 (`ROLLBACK-FAILED release=<되돌리려던 판> restored=<원래 판> health=ok|fail`). 워크플로는 실패로 끝난다.

평소에는 워크플로의 `status`·`rollback` 을 쓴다. 서버에서 직접 해야 하면: `sudo bash /data/whatap/argus-slack-bot/current/deploy/remote-install.sh status` (또는 `rollback`). 설치 스크립트 자체라 root 로 돌리며, `releases/` 가 root 소유라서 가능하다(스크립트가 소유·권한을 먼저 확인한다).

서버 경로:

```
/run/argus-slack-bot/secrets.env         시작할 때 서비스 계정이 Secrets Manager 에서 만든다 (whatap 0600). 메모리(tmpfs)라 디스크·스냅샷에 남지 않고, 서비스가 멈추면 지워진다
/data/whatap/                            root 소유, group·other 쓰기 금지
/data/whatap/argus-slack-bot/            root 소유, group·other 쓰기 금지
  conf/config.env                        비밀이 아닌 설정 (conf/ root:whatap 0750, 파일 root:whatap 0640). 배포가 바꾸지 않는다
  releases/<UTC시각>-<커밋>/              root 소유, 읽기 전용
  current -> releases/...
  data/                                  SQLite (whatap 0700)
  backups/                               백업 (whatap 0700)
  history                                current 가 된 판 기록
```

## 비밀값

- `SLACK_TOKENS_ENCRYPTION_KEY` 는 Slack 설치 토큰과 와탭 연결 토큰의 암호화 키다. 바꾸면 기존 DB 의 토큰을 읽지 못한다(모든 워크스페이스 재설치·재로그인). 백업을 복구할 때도 같은 키가 필요하다.
- `load-secrets.sh`(unit 의 `ExecStartPre`)는 root 가 아니라 서비스 계정 `whatap` 으로 unit 의 샌드박스 안에서 돈다. 그래서 `whatap` 이 IMDS 로 인스턴스 역할을 쓸 수 있어야 하고, 비밀이 고객 관리형 KMS 키를 쓰면 인스턴스 역할에 그 키의 `kms:Decrypt` 가 필요하다. 비밀을 못 읽으면 서비스는 시작하지 않고 계속 다시 시도한다.
- 비밀을 바꾼 뒤에는 `sudo systemctl restart argus-slack-bot`. 시작할 때마다 다시 읽는다.
- 봇은 dotenv override 로 작업 디렉터리의 `.env` 를 환경변수보다 우선한다. 운영 디렉터리에 `.env` 를 두지 않는다(배포 스크립트가 `.env` 든 묶음을 거부한다).

## 백업·복구

- 매일 03:30(서버 시각, 최대 15분 지연): SQLite 3개를 온라인 백업해 `backups/<UTC시각>/` 에 두고(서버에 7개) `BACKUP_S3_URI` 로 올린다. 사본마다 `integrity_check` 를 본다.
- config.env 의 `SLACK_INSTALLATIONS_DB`, `SLACK_USER_TOKENS_DB`, `SLACK_THREAD_HISTORY_DB` 는 필수다. DB 가 하나라도 없으면 백업은 실패로 끝나고 S3 업로드와 오래된 백업 정리를 하지 않는다. 이전 백업은 그대로 남는다.
- 지금 바로: `sudo systemctl start argus-slack-bot-backup`
- 복구: `sudo systemctl stop argus-slack-bot` → `data/` 의 파일을 백업본으로 바꾸고(소유자 `whatap`, 권한 0600 유지) 같은 이름의 `-wal`·`-shm` 을 지운다 → `sudo systemctl start argus-slack-bot`

## 확인 기준

배포 뒤 (DEVOPS-6837):

- `https://argus-bot.whatap.io/`, `/privacy` 200
- `/slack/install` → `slack.com/oauth/v2/authorize` 로 302
- 서명 없는 `POST /slack/events` 401
- state 없는 `/oauth/callback` 400
- 3000·3901 은 외부에서 직접 접근 불가

CI 의 `smoke.sh` 가 앞의 네 항목을 묶음 단위로 확인한다. 로그: `journalctl -u argus-slack-bot -f`

## 함께 필요한 것 (이 저장소 밖)

- 운영 와탭 로그인 서버 활성화와 봇 클라이언트 등록 (콜백 `https://argus-bot.whatap.io/oauth/callback`)
- Argus 운영에 사용자 Bearer 조회(whatap/argus#1052)와 설정 반영
- Slack 앱을 Socket Mode 에서 HTTP 로 전환: [http-rollout.md](http-rollout.md)
