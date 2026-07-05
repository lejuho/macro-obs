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
# 0 9  * * *  cd /home/pi/macro-obs && /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/daily.js >> log/daily.log 2>&1
# 0 19 * * *  cd /home/pi/macro-obs && /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/daily.js >> log/daily.log 2>&1
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
| 예측 커밋 | 알림 메시지에 **답장**: `하한~상한`(밴드) / `단일값`(점→±2% 밴드) / 자유 서술 |
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


## Phase 2 — DART 노출 매트릭스 (추가)

시총 상위 기업의 정기보고서에서 구조적 노출(수출/외화부채/변동금리 비중)을 추출해,
밴드 이탈 알림에 "구조적 노출 상위 5"가 자동으로 붙는다. 추출은 파이의 Claude Code 헤드리스(`claude -p`)로 — 한계비용 0.

### 셋업
```bash
# .env에 DART_API_KEY 추가 후:
node --no-warnings --no-network-family-autoselection src/jobs/quarterly.js --sync   # 고유번호 동기화 + 대상 마킹
nano data/targets.csv     # 초기 20개사 예시 확인 (시총 상위 200으로 확장은 파일럿 검증 후)

# 파일럿: 3개사만 추출해 결과 검증
node --no-warnings --no-network-family-autoselection src/jobs/quarterly.js --limit 3
sqlite3 db/macro.db "SELECT c.name, e.export_ratio, e.fx_debt_ratio, e.float_rate_ratio, e.evidence FROM exposures e JOIN corps c USING(corp_code)"
# → evidence의 인용이 실제 보고서 구절인지 눈으로 대조 (스펙 §8-3: 초기 20개사 수동 검증)

# 전체 실행 (중단돼도 재실행하면 이어서 — 이미 추출된 기업은 스킵)
node --no-warnings --no-network-family-autoselection src/jobs/quarterly.js
```

### 크론 (분기 1회, 보고서 제출 마감 이후인 1/4/7/10월 15일)
```
0 3 15 1,4,7,10 *  cd /home/pi/macro-obs && /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/quarterly.js >> log/quarterly.log 2>&1
```

### 신뢰성 장치
- 프롬프트가 "보고서에 명시된 수치만, 추정 금지 + 근거 인용 필수"를 강제
- validate()가 인용 구절의 **원문 실존 여부를 기계 검증** — 지어낸 evidence는 자동 반려
- 비율 범위(0~1) 위반, JSON 파싱 실패 시 사유를 붙여 1회 재시도
- null이 많은 건 정상 (금융사 등). 지어내는 게 실패지 비어있는 건 실패가 아니다

### 알림 변화
환율 이탈 알림에 수출·외화부채 비중 상위, 금리 이탈 알림에 변동금리 부채 비중 상위가 붙는다.
노출 데이터가 없으면 알림은 Phase 1 형태 그대로 (하위호환).


## Phase 3a — 의존성 그래프 + 시나리오 (추가)

지정학 초크포인트→흐름→산업으로 이어지는 의존성 그래프와, 테일 이벤트 6종의 전파 결과 사전계산.
이벤트가 터지면 분석이 아니라 **조회**를 한다 — 텔레그램에서 30초.

### 셋업
```bash
node --no-warnings scripts/seed-graph.js   # 노드 28 · 간선 37 · 시나리오 6 등록 + 사전계산
```

### 사용법 (텔레그램)
| 명령 | 동작 |
|---|---|
| `/scn` | 시나리오 목록 (호르무즈/대만/미중/한중/대미강압/원화급락) |
| `/scn 5` | 결과: 노드별 임팩트 순위. ⚔️는 수혜/피해 경로 경합 — 지배 경로 판단은 사람 몫 |
| `/scn path 5 반도체` | 해당 노드까지의 경로 역추적 — 간선마다 path_note(왜)와 condition_note(작동 조건) |
| `/scn recompute` | 간선 수정 후 전체 재계산 (수백 노드 규모에서 밀리초) |

### 그래프 편집
`data/graph-seed.js`의 NODES/EDGES/SCENARIOS를 수정 → `node scripts/seed-graph.js --wipe` → `/scn recompute`.
초기 weight는 정성 추정치 — Comtrade/관세청 HHI로 검증·갱신은 Phase 4.
간선의 세 노트가 이 그래프의 본체다: path_note(경로), condition_note(이 경로가 작동하는 조건),
leverage_note(지경학 주석 — 예: 한미통상→반도체 coercion_transfer 간선의 CMS slack sharing).

### 전파 규칙
BFS ≤3홉 · impact = ∏(weight×sign) · 2홉째부터 감쇠 0.7 · |impact|<0.05 가지치기.
coercion_transfer/policy 간선은 물리 전파가 아니므로 홉·감쇠 미계상.
경합 경로(같은 노드에 +와 −)는 합산하지 않고 병렬 표시. 수치는 순위용 휴리스틱이지 추정치가 아니다.


## Phase 3b — PWA 관측소 (추가)

폰/PC 브라우저에서 여는 시각 계기판. 의존성 제로(node:http + 단일 HTML) — 빌드 스텝 없음.
디자인은 해도(海圖) 계기판: 옅은 바다색 종이 + 잉크 선, 정책·강압 경로는 항로 마젠타 점선.

### 셋업
```bash
sudo cp deploy/macro-obs-web.service /etc/systemd/system/   # User/경로 확인
sudo systemctl daemon-reload && sudo systemctl enable --now macro-obs-web
# → http://<파이IP>:8787  (포트 변경: .env에 WEB_PORT)
# 폰에서 열고 "홈 화면에 추가" → PWA 설치 (앱 셸은 오프라인에서도 열림)
```
⚠️ 인증 없음 — LAN/테일넷 전용. 공유기 포트포워딩으로 공인망에 노출하지 말 것. 외부 접속은 Tailscale 권장.

### 화면 4개
| 탭 | 내용 |
|---|---|
| 계기판 | 가설별 밴드 채널 게이지 — 밴드(점선 채널) 안에 최근 120일 궤적 + 현재 위치 마커. open 알림 |
| 해도 | 초크포인트·관계 → 흐름 → 산업 3열 의존성 지도. 시나리오 오버레이(적=피해, 녹=수혜 농도). 노드 클릭 → 간선 노트(경로/조건/지경학) |
| 시나리오 | 6종 순위표, 행 클릭 → 경로 전개 (⚔️=경합) |
| 기록 | 지표별 hit rate + 예측 타임라인 전체 (miss 포함) |


## 해도 v2 — 층위 규칙 엄격화 (구조 개편)

외부 피드백 반영. **구조가 측정에 선행**하므로 Phase 4(HHI 검증) 전에 적용.

### 층위 규칙 (v2 확정)
- **초크포인트** = 막히거나 통제될 수 있는 물리·제도 병목만. "나라"가 아니라 구체 관문(BOJ·JGB, 미국국채시장, 중국부동산).
- **흐름** = 가격·자금·물량의 이동만. 원화가치·엔캐리 같은 2차 현상은 시나리오가 아니라 여기 — 여러 시나리오가 이 노드로 수렴한다.
- **산업** = 최종 피해/수혜 부문만. 계절성(동복/하복 등)은 산업 노드의 meta 속성(해도에서 노드 클릭 시 표시).
- **시나리오** = 외생 사건만 (12종: 지정학 6 + 금융 3 + 수요 2 + 기후 1). 결과·산업테마는 넣지 않는다.

### 규모: 노드 50 (초크 13 · 흐름 19 · 산업 18) · 간선 84 · 시나리오 12
금융 레이어 신설: BOJ·JGB / 미국국채시장 / 중국부동산 → 엔화·달러 유동성 → 위안·원화 → 산업.
금융 체인은 4홉이라 시나리오가 초크포인트+1차 흐름을 **동시 충격**해 3홉 안에 산업 도달.

### 역방향 조회 (신규)
"원화 급락"은 시나리오가 아니라 여러 시나리오의 수렴점 → 환율 밴드 이탈 알림에
**"원화가치를 미는 시나리오 상위 3"이 자동 첨부**되고, `/scn node 원화가치`로 언제든 조회.
지금 어느 세계인지 판단이 곧 주입할 판단이다.

### 간선 source 태그 (Phase 4 범위 정의)
`manual:trade` = Comtrade/관세청 HHI로 검증 가능 (Phase 4 대상) / `manual:fin` = 정성 유지 (무역통계로 검증 불가) / `manual:geo` = 지정학 정성.

### 적용
```bash
node --no-warnings scripts/seed-graph.js --wipe   # v1 백업: data/graph-seed-v1.js.bak
```

## Phase 0의 완료 기준
환율이 밴드를 벗어나면 폰이 울린다. 알림에는 가설 원문 + 등록 논리 + 커밋 요청이 담긴다.
**Phase 1 완료 기준: 첫 예측이 커밋되고 90일 타이머가 돈다.**
