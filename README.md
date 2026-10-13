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

### 현재 관점 복합 오버레이

여러 시나리오가 동시에 작동한다는 판단 자체를 커밋하고, 지도와 전달경로를 T+90에 검토한다.

```text
/view new 1,2 | 대만 유사와 호르무즈 충격이 현재 흐름의 주된 설명이다
# 봇이 주/보조 시나리오와 합집합 경로 초안을 보냄
# 그 메시지에 답장: commit 또는 cancel

/view                  현재 관점·수정 제안 목록
/view show <id>        동결된 관점 조회
/view review <id>      판정일 전이라도 예비검토 실행
/view apply <제안id>   weight·조건 수정 명시 승인
/view reject <제안id>  수정 제안 기각
```

커밋에는 당시 그래프 지문, 사용한 모든 경로·간선, 국가별 정치구조 version이 동결된다.
관측 가능한 경로는 `data/worldview-observables.js` 규칙에 따라 지표·예상 방향·최소 변화폭·시차와 커밋 시점 기준값도 함께 동결된다.
해도에서 `🧭 현재 관점`을 선택하면 여러 시나리오의 요소가 동시에 켜지고, 중복은 `×N`, 방향 경합은 `⚔️`로 표시된다.
판정일에는 Claude가 뉴스·실제 지표를 보강해 시나리오 선택, 경로의 전달·차단·역전·지연, 누락된 정치구조를 분리해 예비검토한다.
숫자는 코드가 계산하고 Claude는 바꾸지 못한다:

- 시나리오 선택 적합도 0~100: `consistent=1`, `partial=.5`, `inconsistent=0`; 주 시나리오 65%, 보조 합계 35%
- 전달경로 점수 -100~100: `transmitted=1`, `lagged=.5`, `blocked=0`, `reversed=-1`; 커밋 당시 `|impact|` 가중
- 실측 방향 점수 -100~100: 커밋 기준값 대비 실제 변화가 예상 방향이면 1, 무변화 0, 반대면 -1; `|impact|` 가중
- 관측 커버리지: 상위 24개 경로 impact 중 실제 지표에 연결된 비중

Claude는 이 기계 점수와 뉴스·정치구조 차이를 받아 가장 큰 오차원, 관측 사각지대, 누락 메커니즘을 `quantitative_insight`로 설명한다.
사용자 확인 전에는 그래프가 바뀌지 않는다. `adjust_weight`와 `adjust_condition`만 `/view apply`로 자동 적용되며,
새 간선·조절변수·시나리오 분할은 `manual_review`로 남는다. 적용 시 이전 값과 새 값이 수정 제안 JSON에 함께 보존된다.

### 채점 규칙
- **hit**: 실제값이 커밋 밴드 안 / **partial**: 밴드 폭 10% 확장 범위 안 / **miss**: 그 외
- **void**: 일간 지표는 채점일 기준 14일 내 관측 결측 / **manual**: 자유 서술 → self-grade
- **월·분기 지표**(경상수지 등)는 채점일이 속한 기간의 관측이 공표될 때까지 대기 후 채점 (공표 지연 한도 M 120일·Q 200일 초과 시 void)
- 미커밋 알림은 24시간마다 재촉, 최대 3회. 커밋 없이는 닫히지 않는다.
- 같은 가설·같은 이탈 방향의 90일 예측이 채점 대기 중이면 cooldown이 지나도 중복 알림을 보내지 않는다.

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

### 크론 (분기당 10회, 30개사씩 5시간 간격으로 분산)
```
0 3,8,13,18,23 13-14 1,4,7,10 *  cd /home/pi/macro-obs && PATH=/home/pi/.local/bin:/usr/bin:/bin /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/quarterly.js --limit 30 >> log/quarterly.log 2>&1
```
이미 저장된 `(corp, fy, reprt)`는 건너뛰므로 매 실행은 다음 미처리 기업부터 이어진다.
기본 모델은 Haiku이며 JSON·범위·evidence 검증에 실패한 기업만 Sonnet으로 한 번 승급한다.
`EXTRACT_MODEL`을 지정하면 사다리를 끄고 해당 모델로 고정할 수 있다.

### 신뢰성 장치
- 프롬프트가 "보고서에 명시된 수치만, 추정 금지 + 근거 인용 필수"를 강제
- validate()가 인용 구절의 **원문 실존 여부를 기계 검증** — 지어낸 evidence는 자동 반려
- 비율 범위(0~1) 위반, JSON 파싱 실패, evidence 불일치 시 Sonnet으로 1회 승급 재시도
- 발췌는 키워드 앞뒤 900자·최대 30,000자. 표 공백·반복 머리말을 정리하며 `.env`의
  `DART_EXCERPT_RADIUS`/`DART_EXCERPT_MAX`로 즉시 조정 가능 (구 기본값: 1500/45000)
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


## 글로벌 계기판 (추가)

계기판의 국내 편중을 보완하는 FRED 지표 9종 + "관찰 지표" 계층 신설.

### 두 계층의 구분 (설계 원칙)
- **가설 지표** = 뉴노멀 주장이 있는 것. 밴드 + 이탈 알림 + 커밋 강제.
- **관찰 지표** = 눈금만. 계기판 카드(스파크라인 + 노브 문장)로 표시되고 알림은 없다.
  알림은 커밋을 요구하므로(§0-2) 밴드 남발 = 커밋 피로 = 시스템 사망. 관찰하다가 주장이 생기면 그때 가설로 승격.

### 셋업
```bash
# .env에 FRED_API_KEY 추가 (fred.stlouisfed.org 무료 발급) 후:
node --no-warnings --no-network-family-autoselection scripts/verify-fred.js   # 9종 확인
node --no-warnings --no-network-family-autoselection src/jobs/daily.js        # 수집 (키 없으면 자동 스킵)

# 글로벌 가설 3종 등록 (미국10년/VIX/HY — 자리표시자 밴드 확인 후)
nano scripts/seed-hypotheses.js   # SEEDS_GLOBAL 밴드 검토
node --no-warnings scripts/seed-hypotheses.js --global
```

### 지표 구성 (Tier 기준: 시나리오 연결성 × 무료 API × 가설화 가능성)
- 수집 9종: 미국 10년물·2년물, 10y-3m 금리차, VIX, HY 스프레드, 달러지수(광의), USD/JPY, USD/CNY, Brent
- 가설 3종: 미국 10년물(고금리 뉴노멀) / VIX(레짐) / HY(신용 사이클) — 나머지 6종은 관찰 전용
- 해도 연동: DGS10→미국장기금리, USDJPY→엔화유동성, USDCNY→위안화가치, 달러지수→달러유동성, Brent→원유수입
  (해당 가설 이탈 시 역방향 시나리오 자동 첨부)
- 보류 (무료 API 없음 → Phase 4 프록시 리서치): MOVE, 한국 CDS, LNG JKM, SCFI, BDI
- "글로벌 리스크 심리" 노드는 추가하지 않음 — 달러유동성 노드가 이미 그 채널이라 이중계상 방지

## 작업 워크플로 (중요)
**너의 git이 source of truth다.** 로컬 수정(인라인 키보드, setMyCommands, 커밋 예시 일반화 등)은 코드베이스에 반영돼 있고,
앞으로 업데이트는 변경 파일 목록과 함께 온다. zip을 받으면: 로컬 커밋 먼저 → 새 파일 반영 → `git diff`로 확인 → 충돌은 로컬 우선.


## Phase 4a — 파생 지표 + 결정 트리거 (추가)

### 파생 지표
원시 시계열에서 계산되는 2차 지표. `src/derived.js`의 DERIVED에 정의, daily 배치가 수집 직후 자동 계산.
- **yoy**(전년동월비): 수출 YoY, 반도체 수출 YoY — AI CAPEX 피크아웃의 한국측 실측치
- **spread**(차): 한미 10년 금리차 (국고채10년 − DGS10)
- **mom_diff**(전월차): 누적(YTD) 공시 시리즈의 월간 플로우 복원 — **경상수지가 누적으로 확인되면 disabled:false로**

⚠️ Tier 2 ECOS 코드 3종이 VERIFY 상태 — 파이에서:
```bash
node --no-warnings scripts/find-ecos-code.js --items 817Y002 국고채   # 10년 항목코드
node --no-warnings scripts/find-ecos-code.js 수출                     # 관세청 무역통계 표
# → src/collectors/ecos.js의 VERIFY 3곳 + src/derived.js의 base 코드 수정 → verify-ecos-codes.js 재실행
```
파생은 base 미수집 시 조용히 스킵되므로, 코드 확정 전에도 시스템은 정상 작동한다.

### 결정 트리거 (스펙 §3.4 — 철학의 마지막 조각)
평온할 때의 판단을 조건-액션 지시서로 예약한다. 전 조건(AND) 충족 시 발동 → 지시문이 **작성일과 함께** 돌아옴 → 이행 노트 답장으로 마감. 발동 후 자동 disarm.

```
/ind                          지표 id + 최신값 (조건 작성용)
/trig                         목록
/trig add 환율위기 | 1>1600 & 7>5 | 신규 리스크자산 매수 중단, 달러예금 재검토
/trig arm <id>                재장전   ·   /trig del <id>  삭제
```
조건 형식: `<지표id><연산자><값>`, `&` 결합. 연산자 > < >= <=.
발동 알림은 이행 노트를 답장해야 닫힌다 — "위기 때의 나는 평시의 내가 시켜둔 일을 수행할 뿐이다"의 집행 장치.


## Phase 4b — HHI 무역 검증 (추가)

해도의 `manual:trade` 간선 weight(정성 추정치)를 UN Comtrade 실측 무역 집중도와 대조한다.
시스템은 **집중도라는 사실의 계산·비교까지만** — weight 수정은 사람 (리포트 → graph-seed 편집 → 재시드).

### 셋업 (연 1~2회 작업 — 연간 데이터라 자주 돌 필요 없음)
```bash
# .env에 COMTRADE_API_KEY (comtradeplus.un.org 무료 구독)
node --no-warnings --no-network-family-autoselection scripts/verify-comtrade.js   # 스키마 확인 (원유 1건)
node --no-warnings --no-network-family-autoselection scripts/hhi-report.js --collect  # 전 품목 수집 (~30초)
node --no-warnings scripts/hhi-report.js   # 리포트: weight vs 1위 점유율, ✅ok/🟡review/🔴mismatch
```

### 대상과 해석
- `data/hhi-map.js`: flow 노드 10종 ↔ HS 코드 (원유 2709, 요소 310210, 배터리광물 리튬+흑연 합산 등)
- 판정 앵커 = 1위 상대국 점유율 (transit/supply weight의 1차 근사). HHI는 edges.hhi에 저장돼 해도 노드 패널에 표시
- 🔴mismatch가 나온 간선이 이 검증의 수확 — "그 weight, 무슨 근거였지?"를 데이터가 묻는 것
- manual:fin/geo 간선은 대상 외 (무역통계로 검증 불가 — v2에서 정의한 범위)


## Phase 4c — 국기 표시 + 선거 캘린더/정책 레버 (추가)

### 연관국 국기
단일 매핑 소스 `src/flags.js` (PWA는 /api 응답으로, 봇은 직접 참조).
- 계기판 카드 우상단: 지표별 연관국 전부 (국기+국가명). Brent처럼 특정국이 모호하면 무표시
- 해도 노드: **이름에 국가가 명시된 것만** (대미자동차수출 🇰🇷🇺🇸 / 호르무즈·핵심광물은 의도적 무표시)
- 시나리오: 이름 옆 연관국 나열 (드롭다운·카드·텔레그램 /scn 공통)

### 선거 캘린더 + 정책 레버
원칙: **이념 라벨이 아니라 정책 레버 단위** — 결과 분기에 따라 실제로 바뀌는 손잡이만 적고, 해도 시나리오와 이름으로 연결.
```bash
node --no-warnings scripts/seed-elections.js   # 5건 시드 (미 중간선거 2026-11 ~ 미 대선 2028-11)
```
- `/elec`: 다가오는 선거 + 레버 분기 (D-day 포함)
- daily 배치가 D-30·D-7에 리마인더 발송 (레버 미작성이면 갱신 촉구)
- 계기판 하단에 D-day 라인
- 갱신 운영: 선거 3~6개월 전 `data/elections-seed.js`의 levers를 채우고 재실행 (멱등)


## Phase 5 — 뉴스 프레이밍 diff (추가)

같은 사건을 축의 양끝이 어떻게 다르게 서사화하고, **90일 뒤 누구의 예측이 살아남았는지** 측정한다.
저장은 제목·API 요약·링크·매체·날짜만 (본문 전문 저장 금지 — 저작권/ToS). LLM은 claude -p 일 배치.

### 파이프라인 (일 1회, daily와 분리된 cron)
수집(네이버 API, 쿼리 10종: 경제 8 + 정치 2) → 클러스터+프레이밍(쿼리당 claude 1콜: 사건 슬러그 부여·축별 프레임·검증가능 주장 추출)
→ initial 스냅샷 박제 → **T+90 재방문**(같은 사건 재검색 → 당시 주장 채점 held/failed/unclear → 리포트 발송 + 언론사 트랙레코드 적립)

정치 사건은 `data/political-contexts.js`의 국가별·유효기간별 구조 파라미터를 함께 넣는다.
국가의 정부 상태·연정·선거제도가 바뀌면 과거 값을 덮어쓰지 않고 `valid_from`이 다른 version을 추가한다.
최초 사건에는 당시 version이 고정되고 T+90에는 현재 version과 비교한다. 구조적 가설 판정은 인과 확정이 아니라
`consistent|inconsistent|unclear`만 허용한다.

### 셋업
```bash
# .env: NAVER_CLIENT_ID / NAVER_CLIENT_SECRET (developers.naver.com 무료)
node --no-warnings --no-network-family-autoselection src/jobs/news.js   # 수동 1회 확인
# cron 추가:
# 30 21 * * *  cd /home/pi/macro-obs && PATH=/home/pi/.local/bin:/usr/bin:/bin /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/news.js >> log/news.log 2>&1
```

### 조회
`/news` 최근 클러스터(축별 보도량 A·B 분포) · `/press` 언론사 트랙레코드 · 재방문 리포트는 자동 발송

### 신뢰성 장치
- 클러스터 출력 기계 검증: event_key 슬러그 형식, 전 기사 id의 단일 배정(중복·누락 거부)
- 재방문 검증: 당시 주장 목록에 없는 매체 판정 거부(지어내기 방지), verdict enum 강제
- notable_claims는 "90일 뒤 검증 가능한 주장"만 — 프레이밍 요약·주장은 전부 재서술 (원문 인용 금지)
- 스펙트럼 라벨(data/press-map.js)은 편집 가능한 데이터 — 시스템 로직은 라벨 내용에 무관심
- 재방문 하루 3건 상한 (구독 한도 보호)
- cron PATH와 무관하게 `.env`의 `CLAUDE_BIN`(기본 설치경로 자동 탐색)을 사용


## Phase 6 — 관측 노트 초안 생성기 (스펙 완결)

지난 30일의 [채점된 예측 / 가설 수정 / 밴드 이탈 / 지표 변화 / 뉴스 재방문 교훈]을 모아
발행 가능한 마크다운 초안(`out/drafts/YYYY-MM.md`)을 만든다. **시스템은 초안까지 — 발행은 사람.**

- 재료가 없으면 LLM을 호출하지 않고 skip (graded가 쌓여야 의미 있다는 설계 그대로)
- 프롬프트가 "입력 JSON의 수치·사실만, 지어내기 금지 + miss 먼저" 강제, 분량·구조 기계 검증
- 매월 1일 배치 (kv 가드) + `/draft`로 즉시 생성
```
0 22 1 * *  cd /home/pi/macro-obs && PATH=/home/pi/.local/bin:/usr/bin:/bin /usr/bin/node --no-warnings --no-network-family-autoselection src/jobs/monthly.js >> log/monthly.log 2>&1
```

## Tier 3 프록시 (조사 완료 — docs/tier3-proxies.md)
- **MOVE → MOVE_PROXY** (미국 10년물 20일 실현변동성, bp) / **한국 CDS → KRW_STRESS** (원화 20일 실현변동성, %) — 파생지표로 즉시 가동, 신규 외부 의존성 제로
- **SCFI/BDI → KCCI/KDCI** (해양진흥공사, 주간·공공데이터) — 프록시가 아니라 한국판 원본. 수집기는 차기 작업
- **JKM → ECOS 수입물가지수(천연가스)** — 코드 확인 대기


## MCP 서버 — 1층: 읽기 전용 (추가)

Claude(Code/데스크톱)와의 거시 대화를 관측소의 사실에 접지한다. 의존성 제로 JSON-RPC 직접 구현.
도구 9종 전부 읽기 — 시스템은 사실·사전계산 제공, 판단은 대화에서 (쓰기 도구는 3층에서 origin 태깅과 함께).

| 도구 | 용도 |
|---|---|
| get_status / list_indicators / get_series | 가설 현황 · 지표 탐색 · 시계열 |
| list_scenarios / run_scenario | 시나리오 12종 · 전파 결과 + 경로별 노트(왜/조건/지경학), 경합 표시 |
| get_graph_node | 노드의 유입/유출 간선 + HHI + 계절성 + 역방향 시나리오 |
| get_exposures | DART 노출 순위 (fx/rates 프리셋) |
| get_track / search_news | 캘리브레이션 이력 · 뉴스 클러스터/재방문/언론사 트랙 |

### 등록
```bash
# 파이 로컬 Claude Code (stdio):
claude mcp add macro-obs -- node --no-warnings /home/pi/macro-obs/src/jobs/mcp-stdio.js

# 외부 기기 Claude 데스크톱 (Streamable HTTP, 테일넷 전용):
#   URL: http://<파이 테일넷 주소>:8787/mcp
```
⚠️ /mcp는 웹서버와 같은 보안 경계 — 인증 없음, 공인망 노출 금지.

### 사용 예
"대만 시나리오 기준으로 이 뉴스 평가해줘" → Claude가 run_scenario로 사전계산 경로·노트를 조회하며 답한다.
"내 환율 판단 이력 보면서 이번 커밋 논의하자" → get_track + get_series 접지.


## MCP 서버 — 2층: 배치 에이전트화 (추가)

DART 추출·뉴스 배치의 claude가 **도구를 호출하며** 일한다. 단방향 프롬프트의 한계 해제:
- **DART**: 발췌 45k 상한에 없는 필드를 null로 포기하기 전에 `search_report` → `fetch_report_section`으로 원문 확인. 발췌 밖 원문 인용 evidence는 반려 대신 `_evidence_outside_excerpt` 표본검증 표시
- **뉴스 재방문**: 수치가 걸린 주장은 뉴스 서사가 아니라 `obs.get_series`의 **실제 지표 데이터로 채점** — 근거 부족 시 `search_news_live`로 보강
- **뉴스 클러스터**: 맥락 부족 기사는 추가 검색 후 배정

### 켜기 (opt-in — 실패 시 기존 방식 자동 폴백)
```bash
# .env에 추가:
EXTRACT_AGENT=1
```
claude -p가 --mcp-config로 obs(1층)·batch(2층 도구 3종) 서버를 띄운다. 도구 서버는 stdio 자식 프로세스라
추가 포트·보안 경계 없음. 배치용 보고서 원문 캐시(tmp/reports/)는 배치 종료 시 자동 정리.

⚠️ **파이 첫 실검증 필요**: `claude --mcp-config`/`--allowedTools` 플래그는 CLI 버전에 따라 다를 수 있다.
`EXTRACT_AGENT=1 node --no-warnings --no-network-family-autoselection src/jobs/quarterly.js --limit 1` 로
1건 돌려 로그 확인 — "agent 모드 실패 → 플레인 폴백" 경고가 뜨면 플래그 호환 문제이며, 그래도 배치는 기존 방식으로 완주한다.


## MCP 서버 — 3층: 쓰기 + origin 실험 (완결)

대화에서 합의된 판단을 관측소에 주입한다. 쓰기 도구 3종:
`commit_prediction`(open 알림에 90일 예측) · `revise_hypothesis`(밴드 수정 — revised_from 체인·근거 필수 그대로) · `add_trigger`(지시서 장전).
텔레그램 흐름과 동일한 가드가 도구 레벨에서 강제되고, **mute는 도구에서 의도적으로 제외** — 회피는 사용자가 직접.

### origin 실험 (이 층의 핵심)
MCP 경유 커밋·수정은 `origin='assisted'`, 텔레그램 직접 입력은 `'human'`으로 태깅되어 **분리 집계**된다.
/track과 관측소 기록 탭에 두 origin의 채점본이 모두 생기면 "origin 실험" 섹션이 나타난다:
> 🧠 human: n% vs 🤝 assisted: n%

"내 단독 판단과 Claude와 토론한 판단, 90일 hit rate가 다른가" — 이 시스템만 답할 수 있는 질문의 계측 인프라.

### 노출 경계
- **stdio (파이 로컬 Claude Code)**: 읽기+쓰기 전체 — 로컬 신뢰 경계
- **HTTP (:8787/mcp)**: 기본 읽기 전용. 쓰기는 `.env`에 `MCP_WRITE_TOKEN=<긴 무작위 문자열>` 설정 후
  클라이언트가 `Authorization: Bearer <토큰>` 헤더를 보낼 때만 노출 (timing-safe 비교). 토큰 미설정 = HTTP 영구 읽기 전용.

### 사용 규율 (도구 description에 내장 — 호출하는 Claude가 물려받는다)
사용자가 명시적으로 요청했을 때만 호출 · 커밋 문장은 되물어 확정 · revise rationale은 사용자 논리의 재서술.

## Phase 0의 완료 기준
환율이 밴드를 벗어나면 폰이 울린다. 알림에는 가설 원문 + 등록 논리 + 커밋 요청이 담긴다.
**Phase 1 완료 기준: 첫 예측이 커밋되고 90일 타이머가 돈다.**

## 이벤트 로그 API (외부 에이전트 연동)

텔레그램으로 나가는 모든 메시지와 배치 갱신을 `events` 테이블에 적재 (발송 실패해도 `delivered=0`으로 남음, DRY_RUN은 미기록).

| kind | 출처 | data |
|---|---|---|
| `breach` | daily | alert_id, hypothesis_id, indicator, band, observed_value/date, direction |
| `trigger` | daily | alert_id, trigger_id, name |
| `grade` / `grade_request` | daily | prediction_id, expected, actual, score |
| `track_weekly` | daily | 지표별 hit rate rows |
| `worldview_review` | daily | worldview_id, review |
| `news_cluster` | news | 쿼리별 클러스터 신규/갱신 수 |
| `news_revisit` | news | cluster_id, title, review(T+90 채점) |
| `message` | 그 외 (bot 응답·월간·분기 요약·재촉 등) | — |

- HTTP: `GET http://<tailnet>:8787/api/events?since_id=N&kind=breach,grade&source=daily&since=2026-10-01&limit=100`
  - `since_id` 주면 오래된 순 + `next_since_id` 반환 → 다음 폴링에 그대로 넘기면 중복/누락 없음
- MCP: `get_events` (같은 인자) — `/mcp` HTTP 또는 stdio
- 내부 판단을 추가로 남기려면: `require('./src/events').record({ kind, text, data })`
- 인증 없음 — 웹서버와 같은 테일넷 전용 경계

### 공인망 노출 (클라우드플레어 터널)
터널 경유 요청(`Cf-Connecting-Ip` 헤더 또는 docker 브리지발)은 `Authorization: Bearer $PUBLIC_API_TOKEN` 필수,
경로는 `/api/events`·`/api/track`·`/mcp`만, MCP는 `PUBLIC_MCP_TOOLS`(기본 get_events,get_track,search_news) 읽기 전용.
토큰 미설정이면 전부 401. 테일넷/LAN은 기존대로 무인증. 앞단에 Cloudflare Access 서비스 토큰을 겹쳐 거는 것을 권장.

### OAuth (원격 MCP 커넥터) + 보고서
OAuth만 지원하는 에이전트용. `src/oauth.js` = 인가 서버(MCP Authorization 규격: 보호 리소스/AS 메타데이터, 동적 등록, PKCE S256, refresh 회전).
- 커넥터 URL: `https://macro.lee-blog.me/mcp` → 401의 `WWW-Authenticate`로 자동 탐색
- 승인 화면 `/oauth/authorize`는 Cloudflare Access(이메일 로그인) 뒤. 서버가 `Cf-Access-Jwt-Assertion`을 팀 공개키로 검증 + `OAUTH_OWNER_EMAIL` 일치 확인 (`src/cf-access.js`). env 미설정이면 승인 불가(fail closed)
- 스코프: `macro.read`(get_events·get_track·search_news·get_reports) / `macro.report`(save_report). 가설·예측 쓰기 도구는 OAuth로 노출 안 함
- 보고서: `reports` 테이블, author는 서버가 OAuth 클라이언트명으로 주입. 조회 `GET /api/reports`, MCP `get_reports`
- 보고서 → 뉴스 파이프라인: `event_ids`가 가리키는 `news_revisit`/`news_cluster` 이벤트로만 클러스터에 연결. 재방문·클러스터링에 "참고, 관측소 판단 아님" 발췌로 들어간다
- 재검토: 재방문 **뒤에** 도착한 미참조 보고서가 있으면 뉴스 배치가 이전 판정을 놓고 재검토 (하루 2건, 클러스터당 최대 2회).
  판정 변경은 모델이 직접 확인한 evidence가 있을 때만 반영, 차이는 코드가 계산(`diff`), 근거 없으면 이전 판정 유지(`rejected_diff`).
  이전 재방문 스냅샷은 보존되고 press_track만 최신 판정으로 교체
- 연결 끊기: `sqlite3 $DB_PATH "UPDATE oauth_tokens SET revoked=1 WHERE client_id='mo_...'"` (클라이언트 목록은 `oauth_clients`)
- 테스트: `node --no-warnings test/oauth.test.js`
