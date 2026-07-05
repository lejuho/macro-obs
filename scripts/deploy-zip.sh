#!/bin/bash
# zip 배포 스크립트 — 백업 → 검증 → 덮어쓰기 → 로컬 패치 재적용 → 테스트 → 마이그레이션 → 봇 재시작
# 사용법: ./scripts/deploy-zip.sh ~/macro-obs-phaseN.zip
# 테스트 실패 시 백업으로 자동 롤백.
set -euo pipefail

ZIP="${1:?사용법: deploy-zip.sh <zip 경로>}"
ROOT=/home/pi/macro-obs
PARENT=$(dirname "$ROOT")
FLAG=--no-network-family-autoselection   # 이 파이의 IPv6 happy-eyeballs 버그 대응 (memory 참조)
TS=$(date +%Y%m%d-%H%M%S)
BACKUP="$PARENT/macro-obs-backup-$TS.tgz"

step() { echo; echo "== $* =="; }

# 0. zip 사전 검증: macro-obs/ 루트 필수, .env·db 파일 포함 시 경고 후 제외
step "zip 검증: $ZIP"
[ -f "$ZIP" ] || { echo "zip 없음: $ZIP"; exit 1; }
unzip -l "$ZIP" | awk '{print $4}' | grep -q '^macro-obs/' \
  || { echo "zip 안에 macro-obs/ 루트 폴더가 없음 — 구조 확인 필요"; exit 1; }
if unzip -l "$ZIP" | awk '{print $4}' | grep -qE '^macro-obs/(\.env$|db/.*\.db$)'; then
  echo "경고: zip에 .env 또는 db 파일 포함 — 추출에서 제외함"
fi

# 1. 백업
step "백업: $BACKUP"
tar czf "$BACKUP" -C "$PARENT" --exclude='macro-obs/node_modules' --exclude='macro-obs/log' macro-obs

rollback() {
  echo; echo "!! 실패 — 백업에서 롤백"
  rm -rf "$ROOT"
  tar xzf "$BACKUP" -C "$PARENT"
  exit 1
}

# 2. 덮어쓰기 (.env / *.db는 어떤 경우에도 제외)
step "압축 해제"
unzip -o "$ZIP" -x 'macro-obs/.env' 'macro-obs/db/*.db' -d "$PARENT" | tail -2

# 3. 로컬 패치 재적용: node 실행 라인에 IPv6 플래그, 경로 오타(macro_obs) 교정
step "로컬 패치 재적용"
for f in "$ROOT"/deploy/*.service; do
  grep -q -- "$FLAG" "$f" || sed -i "s|/usr/bin/node --no-warnings|/usr/bin/node --no-warnings $FLAG|" "$f"
done
# 소스/문서의 cron 예시 주석: 경로 통일 + 플래그 (기능엔 무관, 다음에 사람이 복붙할 때를 위해)
grep -rl 'macro_obs' "$ROOT/src" "$ROOT/README.md" 2>/dev/null | while read -r f; do
  sed -i "s|cd /home/pi/macro_obs && /usr/bin/node --no-warnings src/jobs/|cd /home/pi/macro-obs \&\& /usr/bin/node --no-warnings $FLAG src/jobs/|g" "$f"
done
grep -rn -- "$FLAG" "$ROOT"/deploy/*.service >/dev/null && echo "service: 플래그 OK"

# 4. 테스트 (실패 시 롤백)
step "테스트"
cd "$ROOT"
node --test test/*.test.js 2>&1 | tail -8 | tee /tmp/deploy-test.out
grep -q '^# fail 0$' /tmp/deploy-test.out || rollback

# 5. DB 마이그레이션 (db.js 로드 시 자동 적용)
step "DB 마이그레이션"
node --no-warnings -e "
const { db, MIGRATION_COUNT } = require('$ROOT/src/db');
const v = db.prepare('PRAGMA user_version').get().user_version;
console.log('user_version:', v, '/', MIGRATION_COUNT);
if (v !== MIGRATION_COUNT) { console.error('마이그레이션 불일치'); process.exit(1); }
" || rollback

# 6. systemd 유닛이 설치본과 다르면 재설치
step "systemd 유닛 동기화 + 봇 재시작"
if ! sudo -n diff -q "$ROOT/deploy/macro-obs-bot.service" /etc/systemd/system/macro-obs-bot.service >/dev/null 2>&1; then
  sudo -n cp "$ROOT/deploy/macro-obs-bot.service" /etc/systemd/system/ && sudo -n systemctl daemon-reload
  echo "유닛 파일 갱신됨"
fi
sudo -n systemctl restart macro-obs-bot
sleep 5
systemctl is-active macro-obs-bot >/dev/null || rollback
if sudo -n journalctl -u macro-obs-bot --since '-10s' -o cat | grep -q 'poll error'; then
  echo "경고: 봇 poll 에러 감지 — journalctl -u macro-obs-bot -f 로 확인 필요"
else
  echo "봇: active, poll 에러 없음"
fi

# 7. .env 키 누락 점검 (정보 제공만, 실패 아님)
step ".env 키 점검"
MISSING=$(comm -23 <(grep -oE '^[A-Z_]+' "$ROOT/.env.example" | sort -u) <(grep -oE '^[A-Z_]+' "$ROOT/.env" | sort -u) || true)
[ -n "$MISSING" ] && echo "누락된 키: $MISSING" || echo "누락 키 없음"

# 8. 크론 현황 출력 (신규 잡 등록은 수동 판단)
step "현재 macro-obs 크론"
crontab -l | grep macro-obs || echo "(없음)"
echo
echo "완료. 롤백이 필요하면: tar xzf $BACKUP -C $PARENT"
