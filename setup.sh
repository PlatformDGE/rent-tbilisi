#!/bin/bash
# ============================================================
#  Rent in Tbilisi — Deploy Script
#  Запускать на свежем Ubuntu 22.04 (DigitalOcean / VPS)
#  ./setup.sh
# ============================================================
set -e

echo ""
echo "══════════════════════════════════════"
echo "  Rent in Tbilisi — Auto Setup"
echo "══════════════════════════════════════"
echo ""

# ── 1. Системные зависимости ──
echo "→ Устанавливаем Python и зависимости..."
sudo apt-get update -qq
sudo apt-get install -y python3 python3-pip python3-venv cron nginx -qq

# ── 2. Виртуальное окружение ──
cd /home/ubuntu/rent_parser
python3 -m venv venv
source venv/bin/activate

# ── 3. Python пакеты ──
echo "→ Устанавливаем Python пакеты..."
pip install -q requests beautifulsoup4 gspread google-auth

# ── 4. Директории ──
mkdir -p logs

# ── 5. Cron — каждые 30 минут ──
echo "→ Настраиваем cron (каждые 30 минут)..."
CRON_JOB="*/30 * * * * cd /home/ubuntu/rent_parser && /home/ubuntu/rent_parser/venv/bin/python parser.py >> logs/parser.log 2>&1"
( crontab -l 2>/dev/null | grep -v "rent_parser"; echo "$CRON_JOB" ) | crontab -
echo "  ✓ Cron настроен"

# ── 6. Nginx для статического сайта ──
echo "→ Настраиваем Nginx..."
sudo tee /etc/nginx/sites-available/rent-tbilisi > /dev/null << 'NGINX'
server {
    listen 80;
    server_name _;

    root /home/ubuntu/rent_parser/www;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # CORS для Google Sheets JSON
    add_header Access-Control-Allow-Origin *;
    add_header Cache-Control "no-cache";

    gzip on;
    gzip_types text/html text/css application/javascript application/json;
}
NGINX

sudo ln -sf /etc/nginx/sites-available/rent-tbilisi /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
echo "  ✓ Nginx запущен"

# ── 7. Первый запуск парсера ──
echo "→ Первый запуск парсера..."
/home/ubuntu/rent_parser/venv/bin/python parser.py

echo ""
echo "══════════════════════════════════════"
echo "  ✅ Готово!"
echo "  Парсер запускается каждые 30 минут"
echo "  Логи: tail -f /home/ubuntu/rent_parser/logs/parser.log"
echo "══════════════════════════════════════"
echo ""
