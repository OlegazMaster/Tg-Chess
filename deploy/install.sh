#!/usr/bin/env bash
# Установка и обновление шахмат на VPS (Ubuntu/Debian).
# Первая установка:  sudo bash deploy/install.sh chess.example.com 123456:ТОКЕН_БОТА
# Обновление:        sudo bash deploy/install.sh
set -euo pipefail

APP_DIR=/opt/tg-chess
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${1:-}"
TOKEN="${2:-}"

say()  { echo -e "\n\033[1;34m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m[!] $*\033[0m"; }
die()  { echo -e "\033[1;31m[x] $*\033[0m"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запустите через sudo"

# ---------- Node.js 22 ----------
need_node=1
if command -v node >/dev/null 2>&1; then
  v=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);console.log(a>22||(a===22&&b>=5)?1:0)')
  [ "$v" = "1" ] && need_node=0
fi
if [ "$need_node" = "1" ]; then
  say "Устанавливаю Node.js 22"
  apt-get update -y
  apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
say "Node.js $(node -v)"

# ---------- файлы приложения ----------
say "Копирую файлы в $APP_DIR"
mkdir -p "$APP_DIR/data"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  for item in server shared public deploy test package.json .env.example README.md; do
    [ -e "$SRC_DIR/$item" ] && rm -rf "$APP_DIR/$item" && cp -r "$SRC_DIR/$item" "$APP_DIR/"
  done
fi
cd "$APP_DIR"
say "Устанавливаю зависимости"
npm install --omit=dev --no-audit --no-fund

# ---------- настройки ----------
if [ ! -f .env ]; then
  [ -n "$DOMAIN" ] && [ -n "$TOKEN" ] || die "Первая установка: sudo bash deploy/install.sh ДОМЕН ТОКЕН_БОТА"
  say "Создаю .env"
  cat > .env <<EOF
BOT_TOKEN=$TOKEN
WEBAPP_URL=https://$DOMAIN
HOST=127.0.0.1
PORT=8090
DEV_MODE=0
EOF
  chmod 600 .env
else
  if [ -n "$TOKEN" ]; then sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=$TOKEN|" .env; fi
  if [ -n "$DOMAIN" ]; then sed -i "s|^WEBAPP_URL=.*|WEBAPP_URL=https://$DOMAIN|" .env; fi
fi
# 3-й и 4-й параметры: username бота и короткое имя Mini App из BotFather
set_env() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
if [ -n "${3:-}" ]; then set_env BOT_USERNAME "${3#@}"; fi
if [ -n "${4:-}" ]; then set_env APP_NAME "$4"; fi
DOMAIN="$(grep '^WEBAPP_URL=' .env | sed 's|WEBAPP_URL=https\?://||; s|/.*||')"
PORT="$(grep '^PORT=' .env | cut -d= -f2)"; PORT="${PORT:-8090}"
chown -R www-data:www-data "$APP_DIR"
chmod 600 .env

# ---------- служба ----------
say "Запускаю службу tg-chess"
sed "s|/usr/bin/node|$(command -v node)|" deploy/tg-chess.service > /etc/systemd/system/tg-chess.service
systemctl daemon-reload
systemctl enable tg-chess >/dev/null 2>&1
systemctl restart tg-chess
sleep 2
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  say "Сервер отвечает на порту $PORT"
else
  journalctl -u tg-chess -n 30 --no-pager
  die "Сервер не запустился, лог выше"
fi

# ---------- nginx и HTTPS ----------
owner() { ss -ltnpH "( sport = :$1 )" 2>/dev/null | grep -o 'users:(("[^"]*' | head -1 | sed 's/users:(("//'; }
p80=$(owner 80); p443=$(owner 443)
if { [ -n "$p80" ] && [ "$p80" != "nginx" ]; } || { [ -n "$p443" ] && [ "$p443" != "nginx" ]; }; then
  warn "Порты 80/443 заняты программой: ${p80:-—} / ${p443:-—}. nginx не трогаю."
  warn "Сервер шахмат работает на 127.0.0.1:$PORT — нужно направить на него https://$DOMAIN через ту программу (см. README)."
  exit 0
fi

if ! command -v nginx >/dev/null 2>&1; then
  say "Устанавливаю nginx и certbot"
  apt-get update -y
  apt-get install -y nginx certbot python3-certbot-nginx
fi
command -v certbot >/dev/null 2>&1 || apt-get install -y certbot python3-certbot-nginx

CONF_NAME="$DOMAIN.conf"
if [ -d /etc/nginx/sites-available ]; then
  CONF="/etc/nginx/sites-available/$CONF_NAME"
  LINK="/etc/nginx/sites-enabled/$CONF_NAME"
else
  CONF="/etc/nginx/conf.d/$CONF_NAME"
  LINK=""
fi
if [ ! -f "$CONF" ]; then
  say "Настраиваю nginx для $DOMAIN"
  sed "s|chess.example.com|$DOMAIN|g; s|127.0.0.1:8090|127.0.0.1:$PORT|g" deploy/nginx-chess.conf > "$CONF"
  [ -n "$LINK" ] && ln -sf "$CONF" "$LINK"
fi
nginx -t
systemctl reload nginx || systemctl restart nginx

if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  say "Получаю сертификат Let's Encrypt для $DOMAIN"
  if ! certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect; then
    warn "Сертификат не получен. Проверьте, что A-запись $DOMAIN указывает на IP этого сервера, и запустите скрипт ещё раз."
    exit 1
  fi
fi

say "Готово! Приложение: https://$DOMAIN"
echo "Логи: journalctl -u tg-chess -f"
