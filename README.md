# macro-obs — Phase 0 (심장)

ECOS 수집 → 가설 밴드 감시 → 텔레그램 알림. 스펙 문서(macro-observatory-spec.md) §3~4의 Phase 0 구현.

**의존성 제로.** Node 22+의 내장 `node:sqlite` 사용 — 파이에서 `npm install` 자체가 필요 없다.
(실행 시 SQLite experimental 경고가 뜨는데 무해. 거슬리면 `node --no-warnings`)

## 파이 셋업 (10분)

```bash
# 1. Node 22+ 확인
node -v   # v22.x 이상

# 2. 코드 배치 + 환경변수
cp .env.example .env && nano .env   # ECOS 키, 텔레그램 토큰/챗ID

# 3. ECOS 통계코드 검증 (최초 1회, 필수)
node scripts/verify-ecos-codes.js
#    ❌ 뜨는 시리즈는 ecos.bok.or.kr 통계코드검색에서 코드 확인 후
#    src/collectors/ecos.js 의 SERIES 수정 → 재실행 → 전체 ✅ 될 때까지

# 4. 최초 수집 (indicator 생성)
node src/jobs/daily.js

# 5. 가설 등록 — ⚠️ 밴드 값이 자리표시자이므로 파일 열어서 본인 판단으로 확정 후 실행
nano scripts/seed-hypotheses.js
node scripts/seed-hypotheses.js

# 6. 상태 확인
node scripts/status.js

# 7. cron 등록 — 하루 2회 (ECOS 반영 시차 흡수용. UPSERT/쿨다운 덕에 중복 실행 무해)
crontab -e
# 0 9  * * *  cd /home/pi/macro_obs && /usr/bin/node --no-warnings src/jobs/daily.js >> log/daily.log 2>&1
# 0 19 * * *  cd /home/pi/macro_obs && /usr/bin/node --no-warnings src/jobs/daily.js >> log/daily.log 2>&1
mkdir -p log
```

## 테스트 (네트워크 불필요)
```bash
node --no-warnings test/e2e.test.js   # 합성 데이터로 판정/쿨다운/포맷 검증
```

## 구조
```
src/config.js           .env 로더
src/db.js               node:sqlite + 마이그레이션 + prepared statements
src/collectors/ecos.js  ECOS 수집 (SERIES 정의가 여기)
src/watcher.js          close_N 밴드 판정 + 쿨다운 (judge()는 순수함수)
src/notify/telegram.js  발송 + 알림 포맷
src/jobs/daily.js       수집→감시→알림 오케스트레이션 (cron 진입점)
scripts/                verify-ecos-codes / seed-hypotheses / status
db/schema.sql           Phase 0 스키마 (스펙 §3 부분집합)
```


## Phase 1 — 커밋 루프 (추가)

Phase 0 위에 답장 커밋 → 90일 채점 → 트랙레코드가 붙었다. 기존 DB는 첫 실행 시 자동 마이그레이션된다(user_version).

### 추가 셋업 (5분)
```bash
# 봇 데몬 (답장 수신) — systemd 상시 구동
sudo cp deploy/macro-obs-bot.service /etc/systemd/system/
# 유닛 파일의 User/WorkingDirectory가 실제 경로와 맞는지 확인 (기본: pi / /home/pi/macro-obs)
sudo systemctl daemon-reload && sudo systemctl enable --now macro-obs-bot
journalctl -u macro-obs-bot -f   # 로그 확인

```

### 사용법 (전부 텔레그램에서)
| 행동 | 방법 |
|---|---|
| 예측 커밋 | 알림 메시지에 **답장**: `1450~1520`(밴드) / `1500`(점→±2% 밴드) / 자유 서술 |
| 판단 회피 | 답장 `mute` — 단, 회피도 기록에 남는다 |
| 현황 | `/status` — 가설별 최신값 vs 밴드, open 알림 수 |
| 트랙레코드 | `/track` — 지표별 hit rate (월요일마다 자동 발송도 됨) |
| 가설 목록 | `/hyp` — id 확인 |
| 밴드 참고치 | `/hyp ctx <id>` — 최근 1y/3y 분포(min/max/백분위). 추천이 아니라 참고 자료 |
| 가설 수정 | `/hyp revise <id> <lo>~<hi> <근거>` — 근거 필수, revised_from 체인으로 이력 보존 |
| self-grade | 자유 서술 예측은 90일 뒤 채점 요청이 오면 답장 `hit`/`miss` |

### 채점 규칙
- **hit**: 실제값이 커밋 밴드 안 / **partial**: 밴드 폭 10% 확장 범위 안 / **miss**: 그 외
- **void**: 채점일 기준 14일 내 관측 결측 / **manual**: 자유 서술 → self-grade
- 미커밋 알림은 24시간마다 재촉, 최대 3회. 커밋 없이는 닫히지 않는다.

### 테스트
```bash
node --no-warnings test/phase1.test.js   # 파싱/채점/플로우 22 케이스
```

## Phase 0의 완료 기준
환율이 밴드를 벗어나면 폰이 울린다. 알림에는 가설 원문 + 등록 논리 + 커밋 요청이 담긴다.
**Phase 1 완료 기준: 첫 예측이 커밋되고 90일 타이머가 돈다.**
