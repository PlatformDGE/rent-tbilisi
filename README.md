# Rent in Tbilisi — Полная инструкция по запуску
## Что делает система
```
@rent_tbilisi_ge (Telegram)
        ↓  каждые 30 минут
   parser.py (Python, VPS)
        ↓  пишет новые объявления
  Google Sheets (база данных)
        ↓  читает каждые 5 минут
    index.html (сайт)
```
**Ты не делаешь ничего.** Всё работает автоматически.

---

## ШАГ 1 — Google Service Account (5 минут)

1. Открой https://console.cloud.google.com
2. Создай новый проект → название `rent-tbilisi`
3. Слева: **APIs & Services → Enable APIs**
   - Включи **Google Sheets API**
   - Включи **Google Drive API**
4. Слева: **APIs & Services → Credentials**
   - Нажми **Create Credentials → Service Account**
   - Название: `rent-parser`
   - Нажми **Create and Continue → Done**
5. Кликни на созданный сервисный аккаунт
6. Вкладка **Keys → Add Key → Create new key → JSON**
7. Скачается файл — переименуй его в `credentials.json`
8. Запомни email сервисного аккаунта (вида `rent-parser@...iam.gserviceaccount.com`)

---

## ШАГ 2 — Google Sheets (2 минуты)

1. Открой https://sheets.google.com → создай новую таблицу
2. Назови её **RentTbilisi_Listings**
3. Нажми **Share** → вставь email сервисного аккаунта из шага 1 → **Editor**
4. Скопируй **SHEET_ID** из URL:
   ```
   https://docs.google.com/spreadsheets/d/ЭТОТ_ID_СЮДА/edit
   ```
5. Вставь SHEET_ID в `index.html` в строку:
   ```javascript
   const SHEET_ID = "ВСТАВЬ_SHEET_ID_СЮДА";
   ```

---

## ШАГ 3 — VPS сервер (DigitalOcean / Hetzner)

### Рекомендация: Hetzner CX11, €3.29/мес, Ubuntu 22.04

1. Создай дроплет / сервер
2. Подключись по SSH:
   ```bash
   ssh root@IP_СЕРВЕРА
   ```

3. Загрузи файлы:
   ```bash
   mkdir -p /home/ubuntu/rent_parser
   # Загрузи parser.py, requirements.txt, setup.sh, credentials.json
   # Способ 1 — через scp:
   scp parser.py requirements.txt setup.sh credentials.json root@IP:/home/ubuntu/rent_parser/
   # Способ 2 — создай вручную через nano
   ```

4. Запусти установку:
   ```bash
   cd /home/ubuntu/rent_parser
   chmod +x setup.sh
   ./setup.sh
   ```

5. Проверь что парсер работает:
   ```bash
   tail -f /home/ubuntu/rent_parser/logs/parser.log
   ```

   Увидишь что-то вроде:
   ```
   2024-01-15 10:30:01 [INFO] === Запуск парсера @rent_tbilisi_ge ===
   2024-01-15 10:30:01 [INFO] Страница 1: https://t.me/s/rent_tbilisi_ge
   2024-01-15 10:30:03 [INFO]   ✓ [478531] Vake rent $1800
   2024-01-15 10:30:03 [INFO]   ✓ [478522] Krtsanisi commercial $2800
   2024-01-15 10:30:03 [INFO] Записано 12 объявлений в Sheets
   ```

---

## ШАГ 4 — Деплой сайта

### Вариант A: GitHub Pages (бесплатно)
1. Создай репозиторий на GitHub → загрузи `index.html`
2. Settings → Pages → Branch: main → Save
3. Сайт будет на `https://твой-username.github.io/репозиторий`

### Вариант B: Свой домен через Nginx (уже настроен в setup.sh)
1. Укажи A-запись домена на IP сервера
2. Скопируй `index.html` в `/home/ubuntu/rent_parser/www/`
3. Открой домен в браузере — всё работает

### Вариант C: Netlify (бесплатно, быстро)
1. Перейди на https://netlify.com
2. Drag & drop папку с `index.html`
3. Готово — дают домен типа `rent-tbilisi.netlify.app`

---

## ШАГ 5 — Проверка работы

После запуска:
- Открой Google Sheets — увидишь строки с объявлениями
- Открой сайт — карточки с реальными данными из канала
- Сайт обновляется каждые **5 минут** автоматически
- Парсер пишет новые посты каждые **30 минут**

---

## Команды для управления

```bash
# Запустить парсер вручную
cd /home/ubuntu/rent_parser && venv/bin/python parser.py

# Посмотреть логи
tail -100 /home/ubuntu/rent_parser/logs/parser.log

# Посмотреть cron задачи
crontab -l

# Перезапустить nginx
sudo systemctl restart nginx

# Сколько объявлений в базе
grep "Записано" logs/parser.log | tail -5
```

---

## Что парсер извлекает из каждого поста

| Поле | Пример |
|------|--------|
| Район | Vake, Saburtalo |
| Метро | Rustaveli, Isani |
| Адрес | 56 Irakli Abashidze St |
| Тип | rent / sale / commercial |
| Комнаты | 1, 2, 3, 4 |
| Площадь | 210 м² |
| Этаж | 5/11 |
| Отопление | Central / Gas / Electric |
| Цена | $1800 |
| Депозит | $1800 |
| Удобства | WiFi, Balcony, Conditioner... |
| Фото | URL первого фото поста |
| Агент | Michel, Sergi, David... |
| Ссылка на пост | t.me/rent_tbilisi_ge/478531 |

---

## Архитектура (полная схема)

```
┌─────────────────────────────────────────────┐
│           @rent_tbilisi_ge                  │
│         Telegram Channel                    │
└──────────────┬──────────────────────────────┘
               │ t.me/s/ (публичный HTML)
               │ каждые 30 минут
               ▼
┌─────────────────────────────────────────────┐
│         parser.py (VPS Ubuntu)              │
│  • Requests + BeautifulSoup                 │
│  • Регулярные выражения                     │
│  • state.json (последний msg_id)            │
└──────────────┬──────────────────────────────┘
               │ gspread API
               ▼
┌─────────────────────────────────────────────┐
│         Google Sheets                       │
│    Таблица: RentTbilisi_Listings            │
│    Лист: listings (30 колонок)              │
└──────────────┬──────────────────────────────┘
               │ Public JSON (gviz/tq)
               │ каждые 5 минут
               ▼
┌─────────────────────────────────────────────┐
│         index.html (сайт)                  │
│  • Split view: список + карта               │
│  • Leaflet.js (OpenStreetMap)               │
│  • Фильтры, поиск, модальное окно           │
│  • Реальные фото из Telegram                │
└─────────────────────────────────────────────┘
```

---

## Вопросы?

Telegram: @david_tibelashvili
Канал: @rent_tbilisi_ge
