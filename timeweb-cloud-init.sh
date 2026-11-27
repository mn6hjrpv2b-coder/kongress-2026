#!/bin/bash
# Установка сайта форума на чистый облачный сервер Timeweb Cloud (Ubuntu 24.04).
# Вставляется целиком в поле «Сценарий cloud-init» при создании сервера и выполняется один раз при первом запуске.
# Перед вставкой заполните блок ниже. Всё остальное не трогайте.
#
# Репозиторий может быть закрытым: сервер сам создаёт ключ доступа (deploy key) и показывает его
# по адресу http://IP-сервера/deploy-key.txt. Как только ключ добавлен в GitHub (только чтение),
# сервер в течение 5 минут сам скачивает код и запускает сайт.

# ===== ЗАПОЛНИТЕ =====
REPO_URL="git@github.com:ВАШ-ЛОГИН/ВАШ-РЕПОЗИТОРИЙ.git"  # адрес репозитория: кнопка Code → вкладка SSH (адрес с вкладки HTTPS тоже подойдёт)
DOMAIN="rcb-barnaul.ru"
SMTP_USER="ваш-ящик@mail.ru"        # ящик mail.ru, с которого уходят письма
SMTP_PASS="пароль-для-приложения"   # НЕ пароль от ящика, а пароль для внешнего приложения mail.ru
MAIL_TO="ваш-ящик@mail.ru"          # куда приходят заявки (можно тот же ящик)
TELEGRAM_BOT_TOKEN=""               # токен бота от @BotFather; можно оставить пустым
TELEGRAM_CHAT_ID=""                 # оставьте пустым, узнаете через страницу /setup
SETUP_SECRET=""                     # придумайте слово от 8 символов латиницей, нужно один раз для /setup
# =====================

set -euo pipefail
exec >>/var/log/forum-setup.log 2>&1
echo "=== старт $(date -Is)"

NODE_VERSION=v24.22.3
APP_DIR=/srv/forum/app
DATA_DIR=/srv/forum/data
ENV_FILE=/etc/forum.env
KEY_DIR=/var/www/forum-key

# Адрес вида https://github.com/логин/репо(.git) переводим в SSH-вид git@github.com:логин/репо.git
if [[ $REPO_URL =~ ^https://github\.com/([^/]+)/([^/]+)/?$ ]]; then
  REPO_URL="git@github.com:${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}.git"
fi
echo "репозиторий: $REPO_URL"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -o DPkg::Lock::Timeout=600 install -y git curl xz-utils ufw python3 sudo gnupg openssh-client
# Caddy из Ubuntu; если в этой версии Ubuntu его нет – из официального репозитория Caddy
if ! apt-get -o DPkg::Lock::Timeout=600 install -y caddy; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get -o DPkg::Lock::Timeout=600 install -y caddy
fi

# Node.js с официального сайта nodejs.org
curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /opt
ln -sf "/opt/node-${NODE_VERSION}-linux-x64/bin/node" /usr/local/bin/node
ln -sf "/opt/node-${NODE_VERSION}-linux-x64/bin/npm" /usr/local/bin/npm

# Отдельный пользователь без прав администратора
id forum >/dev/null 2>&1 || useradd --system --create-home --home-dir /srv/forum --shell /usr/sbin/nologin forum
install -d -o forum -g forum -m 700 "$DATA_DIR"

# Ключ доступа к GitHub (deploy key). Закрытая часть остаётся на сервере, открытую показываем для GitHub.
install -d -o forum -g forum -m 700 /srv/forum/.ssh
[ -f /srv/forum/.ssh/id_ed25519 ] || sudo -H -u forum ssh-keygen -q -t ed25519 -N "" -C "forum-server-deploy-key" -f /srv/forum/.ssh/id_ed25519
# Ключ GitHub опубликован на docs.github.com (githubs-ssh-key-fingerprints); порт 443 работает и там, где 22 закрыт
cat >/srv/forum/.ssh/known_hosts <<'EOF'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
[ssh.github.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
EOF
cat >/srv/forum/.ssh/config <<'EOF'
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking yes
EOF
chown forum:forum /srv/forum/.ssh/known_hosts /srv/forum/.ssh/config
chmod 600 /srv/forum/.ssh/config
install -d -m 755 "$KEY_DIR"
install -m 644 /srv/forum/.ssh/id_ed25519.pub "$KEY_DIR/deploy-key.txt"
printf '%s\n' "$REPO_URL" >/etc/forum-repo

# Настройки сайта: пароли лежат только здесь, не в коде
umask 077
cat >"$ENV_FILE" <<EOF
PORT=3000
HOST=127.0.0.1
DATA_DIR=$DATA_DIR
SMTP_HOST=smtp.mail.ru
SMTP_PORT=465
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
MAIL_TO=$MAIL_TO
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
SETUP_SECRET=$SETUP_SECRET
EOF
chmod 600 "$ENV_FILE"
umask 022

cat >/etc/systemd/system/forum.service <<EOF
[Unit]
Description=Сайт форума
After=network-online.target
Wants=network-online.target
ConditionPathExists=$APP_DIR/server.js

[Service]
User=forum
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# HTTPS: Caddy сам получает и продлевает сертификат, как только домен смотрит на этот сервер.
# Ключ для GitHub виден и по домену, и по IP-адресу сервера (http://IP/deploy-key.txt) – это открытая часть, она не секретна.
cat >/etc/caddy/Caddyfile <<EOF
$DOMAIN, www.$DOMAIN {
	encode gzip
	handle /deploy-key.txt {
		root * $KEY_DIR
		file_server
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}

:80 {
	root * $KEY_DIR
	file_server
}
EOF

# Установка и обновление сайта: каждые 5 минут.
# Пока кода нет – пробует скачать его (ждёт, когда ключ добавят в GitHub); потом забирает изменения и перезапускает сайт.
cat >/usr/local/bin/forum-update <<'EOF'
#!/bin/bash
set -euo pipefail
APP=/srv/forum/app
if [ ! -d "$APP/.git" ]; then
  rm -rf -- "$APP.new"
  if ! sudo -H -u forum git clone -q "$(cat /etc/forum-repo)" "$APP.new" 2>/tmp/forum-clone.err; then
    rm -rf -- "$APP.new"
    echo "$(date -Is) нет доступа к репозиторию – добавьте ключ http://IP-сервера/deploy-key.txt в GitHub (Settings → Deploy keys). Ошибка: $(head -c 200 /tmp/forum-clone.err | tr '\n' ' ')"
    exit 0
  fi
  # зависимости ставим до переноса: если npm ci упадёт, следующий запуск начнёт заново
  cd "$APP.new"
  sudo -H -u forum npm ci --omit=dev --no-audit --no-fund
  cd /
  mv "$APP.new" "$APP"
  cd "$APP"
  systemctl enable forum
  systemctl restart forum
  sleep 3
  if curl -fsS http://127.0.0.1:3000/health >/dev/null; then
    echo "$(date -Is) сайт установлен и запущен"
  else
    echo "$(date -Is) код скачан, но сайт не ответил – смотрите journalctl -u forum -n 30"
  fi
  exit 0
fi
cd "$APP"
before=$(sudo -H -u forum git rev-parse HEAD)
sudo -H -u forum git pull --ff-only -q
after=$(sudo -H -u forum git rev-parse HEAD)
if [ "$before" != "$after" ] || [ "${1:-}" = "--force" ]; then
  sudo -H -u forum npm ci --omit=dev --no-audit --no-fund
  systemctl restart forum
  echo "$(date -Is) обновлено до $after"
fi
EOF
chmod 755 /usr/local/bin/forum-update
echo '*/5 * * * * root /usr/local/bin/forum-update >>/var/log/forum-update.log 2>&1' >/etc/cron.d/forum-update

# Смена одной настройки: forum-set ИМЯ значение (например, forum-set TELEGRAM_CHAT_ID 123456789)
cat >/usr/local/bin/forum-set <<'EOF2'
#!/bin/bash
set -euo pipefail
[ $# -eq 2 ] || { echo "Пример: forum-set TELEGRAM_CHAT_ID 123456789"; exit 1; }
grep -q "^$1=" /etc/forum.env || { echo "Нет такой настройки: $1"; exit 1; }
python3 - "$1" "$2" <<'PY'
import sys
k,v=sys.argv[1],sys.argv[2]
p="/etc/forum.env"; lines=open(p).read().splitlines()
open(p,"w").write("\n".join(f"{k}={v}" if l.startswith(k+"=") else l for l in lines)+"\n")
PY
systemctl restart forum
echo "Готово: $1 изменена, сайт перезапущен"
EOF2
chmod 755 /usr/local/bin/forum-set

# Закрыть всё, кроме входа на сервер и сайта
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl daemon-reload
systemctl restart caddy
echo "ключ для GitHub (Deploy keys, без права записи): $(cat "$KEY_DIR/deploy-key.txt")"
/usr/local/bin/forum-update >>/var/log/forum-update.log 2>&1 || true
tail -1 /var/log/forum-update.log
echo "=== готово $(date -Is)"
