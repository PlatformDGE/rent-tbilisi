"""
Rent in Tbilisi — Telegram Channel Parser
==========================================
Парсит @rent_tbilisi_ge → Google Sheets → сайт читает Sheets как JSON

Запуск: python parser.py
Cron:   */30 * * * * cd /home/ubuntu/rent_parser && python parser.py >> logs/parser.log 2>&1
"""

import re
import json
import time
import logging
import hashlib
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup
import gspread
from google.oauth2.service_account import Credentials

# ──────────────────────────────────────
#  CONFIG
# ──────────────────────────────────────
CHANNEL_URL   = "https://t.me/s/rent_tbilisi_ge"
SHEET_NAME    = "RentTbilisi_Listings"          # название Google Sheets документа
WORKSHEET     = "listings"                       # название листа
CREDS_FILE    = "credentials.json"              # сервисный аккаунт Google
MAX_PAGES     = 5                               # сколько страниц парсить за раз (20 постов/страница)
SLEEP_BETWEEN = 2                               # секунд между запросами (не баниться)
STATE_FILE    = "state.json"                    # последний обработанный message_id

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
log = logging.getLogger("parser")

# ──────────────────────────────────────
#  КООРДИНАТЫ РАЙОНОВ ТБИЛИСИ
# ──────────────────────────────────────
DISTRICT_COORDS = {
    "vake":        (41.7151, 44.7640),
    "saburtalo":   (41.7237, 44.7852),
    "didube":      (41.7370, 44.7730),
    "isani":       (41.6891, 44.8289),
    "gldani":      (41.7627, 44.7989),
    "nadzaladevi": (41.7198, 44.8124),
    "mtatsminda":  (41.6940, 44.7934),
    "chugureti":   (41.6973, 44.8180),
    "vera":        (41.7020, 44.7870),
    "tsereteli":   (41.7100, 44.7780),
    "rustaveli":   (41.6960, 44.8000),
    "dighomi":     (41.7490, 44.7630),
    "ortachala":   (41.6810, 44.8390),
    "marjanishvili":(41.6930, 44.8120),
    "avlabari":    (41.6880, 44.8240),
    "liberty square":(41.6944, 44.8016),
    "krtsanisi":   (41.6820, 44.8050),
    "didgori":     (41.6750, 44.7980),
    "varketili":   (41.7040, 44.8640),
    "samgori":     (41.6880, 44.8480),
    "gldan":       (41.7627, 44.7989),
    "temqa":       (41.7380, 44.8280),
}

# ──────────────────────────────────────
#  ПАРСЕР ОДНОГО ПОСТА
# ──────────────────────────────────────
def parse_post(text: str, msg_id: str, photo_url: str | None) -> dict | None:
    """
    Разбирает текст одного поста канала по регуляркам.
    Возвращает dict или None если пост — не объявление.
    """
    # Пост должен содержать цену — иначе пропускаем
    if "💰" not in text and "$" not in text:
        return None
    if "#Rent" not in text and "#Sale" not in text and "#Commercial" not in text:
        return None

    listing = {
        "id":          msg_id,
        "msg_id":      msg_id,
        "tg_url":      f"https://t.me/rent_tbilisi_ge/{msg_id}",
        "photo":       photo_url or "",
        "parsed_at":   datetime.now(timezone.utc).isoformat(),
        "is_new":      True,
        "is_exclusive": "#Exclusive" in text or "Exclusive" in text,
    }

    # ── ТИП СДЕЛКИ ──
    if "#Commercial" in text:
        listing["type"] = "commercial"
    elif "#Sale" in text and "#Rent" not in text:
        listing["type"] = "sale"
    else:
        listing["type"] = "rent"

    # ── КОМНАТЫ ──
    room_map = {"#Studio": 0, "#1Bed": 1, "#2Bed": 2, "#3Bed": 3, "#4Bed": 4, "#5Bed": 5}
    listing["rooms"] = next((v for k, v in room_map.items() if k in text), None)

    # ── АДРЕС ──
    addr_m = re.search(r"📍\s*\[?([^\]\n\[]+)\]?", text)
    listing["address"] = addr_m.group(1).strip() if addr_m else ""

    # ── РАЙОН и МЕТРО ──
    # Хештеги вида #Vake #Saburtalo стоят в начале поста
    district_tags = re.findall(r"#([A-Z][a-zA-Z]+)", text[:200])
    metro_keywords = list(DISTRICT_COORDS.keys())
    listing["district"] = ""
    listing["metro"]    = ""
    listing["lat"]      = ""
    listing["lng"]      = ""

    for tag in district_tags:
        low = tag.lower()
        if low in DISTRICT_COORDS:
            listing["district"] = tag
            coords = DISTRICT_COORDS[low]
            # Лёгкий jitter чтобы маркеры не сливались
            import random
            listing["lat"] = round(coords[0] + random.uniform(-0.006, 0.006), 6)
            listing["lng"] = round(coords[1] + random.uniform(-0.006, 0.006), 6)
            break

    # Метро — второй хештег после района
    metro_m = re.search(r"🚇\s*#?([A-Za-z ]+)", text)
    if metro_m:
        listing["metro"] = metro_m.group(1).strip().rstrip()

    # ── ПЛОЩАДЬ ──
    sqm_m = re.search(r"(\d+(?:\.\d+)?)\s*[Ss]q\.?m", text)
    listing["sqm"] = float(sqm_m.group(1)) if sqm_m else None

    # ── ЭТАЖ ──
    floor_m = re.search(r"(\d+)\s*/\s*(\d+)\s*[Ff]loor", text)
    if floor_m:
        listing["floor"]  = int(floor_m.group(1))
        listing["floors"] = int(floor_m.group(2))
    else:
        # формат "5/11 Floor"
        floor_m2 = re.search(r"(\d+)/(\d+)\s+Floor", text)
        if floor_m2:
            listing["floor"]  = int(floor_m2.group(1))
            listing["floors"] = int(floor_m2.group(2))
        else:
            listing["floor"]  = None
            listing["floors"] = None

    # ── ОТОПЛЕНИЕ ──
    if "#CentralHeating" in text:
        listing["heating"] = "Central"
    elif "#GasHeating" in text:
        listing["heating"] = "Gas"
    elif "#ElectricHeating" in text:
        listing["heating"] = "Electric"
    else:
        listing["heating"] = ""

    # ── ТИП ЗДАНИЯ ──
    if "#NewBuilding" in text:
        listing["building"] = "New"
    elif "#OldBuilding" in text:
        listing["building"] = "Old"
    else:
        listing["building"] = ""

    # ── ЦЕНА ──
    # Форматы: "💰 550$" / "💰 1800$ + Deposit 1800$" / "1400$ + 1400$ Deposit"
    price_m = re.search(r"💰\s*(?:Each\s*)?(\d[\d,]+)\$", text)
    if not price_m:
        price_m = re.search(r"(\d[\d,]+)\s*\$(?:\s*/month)?", text)
    listing["price"] = int(price_m.group(1).replace(",", "")) if price_m else None

    # ── ДЕПОЗИТ ──
    dep_m = re.search(r"Deposit\s+(\d[\d,]+)\$|(\d[\d,]+)\$\s+Deposit", text)
    if dep_m:
        val = dep_m.group(1) or dep_m.group(2)
        listing["deposit"] = int(val.replace(",", ""))
    else:
        listing["deposit"] = None

    # ── КОММИССИЯ ──
    listing["commission"] = 0 if "0% Commission" in text or "0% commission" in text else None

    # ── УДОБСТВА (булевые) ──
    am = {
        "wifi":          "#WiFi" in text,
        "stove":         "#Stove" in text,
        "balcony":       "#Balcony" in text,
        "tv":            "#TV" in text,
        "conditioner":   "#Conditioner" in text,
        "dishwasher":    "#Dishwasher" in text,
        "elevator":      "#Elevator" in text,
        "washing_machine": "#WashingMachine" in text,
        "microwave":     "#Microwave" in text,
        "parking":       "#ParkingPlace" in text,
    }
    listing["amenities"] = json.dumps(am)

    # ── ПИТОМЦЫ ──
    if "#NotAllowed" in text and "Pets" in text:
        listing["pets"] = False
    elif "#ByAgreement" in text and "Pets" in text:
        listing["pets"] = "byagreement"
    elif "🐕" in text and "Allowed" in text:
        listing["pets"] = True
    else:
        listing["pets"] = False

    # ── ЖИЛЬЦЫ ──
    tenants_m = re.search(r"👬\s*Tenants:\s*([0-9\-]+)", text)
    listing["tenants"] = tenants_m.group(1) if tenants_m else ""

    # ── СРОК АРЕНДЫ ──
    terms = re.findall(r"#(\d+Month)", text)
    listing["term"] = ",".join(terms)

    # ── АГЕНТ ──
    agent_m = re.search(r"#([A-Z][a-z]+)\s*$", text.strip().split("\n")[-2] if "\n" in text else "")
    if not agent_m:
        agent_m = re.search(r"\|\s*#([A-Z][a-z]+)", text)
    listing["agent"] = agent_m.group(1) if agent_m else "David"
    listing["phone"] = "+995 599 20 67 16"
    listing["contact"] = "@David_Tibelashvili"

    # ── ЗАГОЛОВОК (строим из данных) ──
    rooms_label = {None: "", 0: "Студия", 1: "1-комн.", 2: "2-комн.", 3: "3-комн.", 4: "4-комн.", 5: "5-комн."}
    r = rooms_label.get(listing["rooms"], "")
    listing["title"] = f"{r} • {listing['building'] or 'Апартаменты'} • {listing['district']}".strip(" •")

    return listing


# ──────────────────────────────────────
#  FETCH СТРАНИЦ КАНАЛА
# ──────────────────────────────────────
def fetch_page(url: str) -> tuple[list[dict], str | None]:
    """
    Загружает страницу канала. Возвращает (список постов, url следующей страницы).
    Каждый пост = {id, text, photo_url}.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; RentBot/1.0)",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        r = requests.get(url, headers=headers, timeout=15)
        r.raise_for_status()
    except Exception as e:
        log.error(f"Fetch failed: {e}")
        return [], None

    soup = BeautifulSoup(r.text, "html.parser")
    posts = []

    for msg_div in soup.select(".tgme_widget_message"):
        # ID поста
        data_post = msg_div.get("data-post", "")
        msg_id = data_post.split("/")[-1] if "/" in data_post else ""

        # Текст
        text_div = msg_div.select_one(".tgme_widget_message_text")
        text = text_div.get_text("\n") if text_div else ""

        # Фото (первое изображение поста)
        photo_url = None
        img = msg_div.select_one(".tgme_widget_message_photo_wrap")
        if img:
            style = img.get("style", "")
            m = re.search(r"url\('([^']+)'\)", style)
            if m:
                photo_url = m.group(1)

        if msg_id and text:
            posts.append({"id": msg_id, "text": text, "photo": photo_url})

    # Следующая страница (pagination)
    prev_link = soup.select_one('a[href*="?before="]')
    next_url = "https://t.me" + prev_link["href"] if prev_link else None

    return posts, next_url


# ──────────────────────────────────────
#  STATE (последний обработанный ID)
# ──────────────────────────────────────
def load_state() -> dict:
    if Path(STATE_FILE).exists():
        return json.loads(Path(STATE_FILE).read_text())
    return {"last_id": 0}

def save_state(state: dict):
    Path(STATE_FILE).write_text(json.dumps(state))


# ──────────────────────────────────────
#  GOOGLE SHEETS
# ──────────────────────────────────────
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

SHEET_HEADERS = [
    "id", "msg_id", "tg_url", "photo", "parsed_at",
    "is_new", "is_exclusive", "type", "rooms",
    "title", "address", "district", "metro",
    "lat", "lng", "sqm", "floor", "floors",
    "heating", "building", "price", "deposit", "commission",
    "amenities", "pets", "tenants", "term",
    "agent", "phone", "contact",
]

def get_sheet():
    creds = Credentials.from_service_account_file(CREDS_FILE, scopes=SCOPES)
    gc    = gspread.authorize(creds)
    try:
        sh = gc.open(SHEET_NAME)
    except gspread.SpreadsheetNotFound:
        sh = gc.create(SHEET_NAME)
        sh.share("", perm_type="anyone", role="reader")  # публичный доступ на чтение
        log.info(f"Создан новый документ: {sh.url}")
    try:
        ws = sh.worksheet(WORKSHEET)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(WORKSHEET, rows=2000, cols=len(SHEET_HEADERS))
        ws.append_row(SHEET_HEADERS)
        log.info("Создан лист listings с заголовками")
    return ws


def get_existing_ids(ws) -> set:
    """Читаем колонку id чтобы не дублировать"""
    try:
        ids = ws.col_values(1)[1:]  # пропускаем заголовок
        return set(ids)
    except Exception:
        return set()


def write_listings(ws, listings: list[dict]):
    """Добавляем новые строки в начало (после заголовка)"""
    if not listings:
        return
    rows = []
    for l in listings:
        row = [str(l.get(h, "")) for h in SHEET_HEADERS]
        rows.append(row)
    # Вставляем строки после заголовка (row index 2)
    ws.insert_rows(rows, row=2)
    log.info(f"Записано {len(rows)} объявлений в Sheets")


# ──────────────────────────────────────
#  MAIN
# ──────────────────────────────────────
def main():
    log.info("=== Запуск парсера @rent_tbilisi_ge ===")
    state = load_state()
    last_id = state.get("last_id", 0)
    log.info(f"Последний обработанный ID: {last_id}")

    # Подключаемся к Sheets
    try:
        ws = get_sheet()
        existing_ids = get_existing_ids(ws)
        log.info(f"В таблице уже {len(existing_ids)} объявлений")
    except Exception as e:
        log.error(f"Ошибка подключения к Google Sheets: {e}")
        return

    new_listings = []
    max_seen_id  = last_id
    url = CHANNEL_URL

    for page_num in range(MAX_PAGES):
        log.info(f"Страница {page_num + 1}: {url}")
        posts, next_url = fetch_page(url)

        if not posts:
            log.warning("Нет постов на странице, останавливаемся")
            break

        stop_early = False
        for p in posts:
            msg_id_int = int(p["id"]) if p["id"].isdigit() else 0

            # Уже обрабатывали — стоп
            if msg_id_int <= last_id or p["id"] in existing_ids:
                log.info(f"ID {p['id']} уже в базе, останавливаем пагинацию")
                stop_early = True
                break

            listing = parse_post(p["text"], p["id"], p["photo"])
            if listing:
                new_listings.append(listing)
                log.info(f"  ✓ [{p['id']}] {listing.get('district','')} {listing.get('type','')} ${listing.get('price','?')}")
            else:
                log.debug(f"  – [{p['id']}] пропущен (не объявление)")

            max_seen_id = max(max_seen_id, msg_id_int)

        if stop_early or not next_url:
            break

        url = next_url
        time.sleep(SLEEP_BETWEEN)

    # Записываем в Sheets
    if new_listings:
        write_listings(ws, new_listings)
        state["last_id"] = max_seen_id
        save_state(state)
        log.info(f"Готово. Добавлено {len(new_listings)} новых объявлений. max_id={max_seen_id}")
    else:
        log.info("Новых объявлений нет")

    log.info("=== Парсер завершён ===\n")


if __name__ == "__main__":
    main()
