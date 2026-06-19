// ============================================================
//  Rent in Tbilisi — Google Apps Script Parser
//  Парсит @rent_tbilisi_ge → Google Sheets → JSON для сайта
//  Запускается автоматически каждые 30 минут
// ============================================================

// ── КОНФИГ ──────────────────────────────────────────────────
const CHANNEL_URL  = 'https://t.me/s/rent_tbilisi_ge';
const SHEET_NAME   = 'listings';
const MAX_PAGES    = 4;   // страниц за один запуск (~80 постов)

// ── КООРДИНАТЫ РАЙОНОВ ──────────────────────────────────────
const COORDS = {
  'vake':          [41.7151, 44.7640],
  'saburtalo':     [41.7237, 44.7852],
  'didube':        [41.7370, 44.7730],
  'isani':         [41.6891, 44.8289],
  'gldani':        [41.7627, 44.7989],
  'nadzaladevi':   [41.7198, 44.8124],
  'mtatsminda':    [41.6940, 44.7934],
  'chugureti':     [41.6973, 44.8180],
  'vera':          [41.7020, 44.7870],
  'tsereteli':     [41.7100, 44.7780],
  'rustaveli':     [41.6960, 44.8000],
  'dighomi':       [41.7490, 44.7630],
  'marjanishvili': [41.6930, 44.8120],
  'krtsanisi':     [41.6820, 44.8050],
  'avlabari':      [41.6880, 44.8240],
  'ortachala':     [41.6810, 44.8390],
  'varketili':     [41.7040, 44.8640],
  'samgori':       [41.6880, 44.8480],
  'digomi':        [41.7490, 44.7630],
  'temqa':         [41.7380, 44.8280],
  'lilo':          [41.7100, 44.8900],
};

// ════════════════════════════════════════════════════════════
//  ГЛАВНАЯ ФУНКЦИЯ — запускается по триггеру каждые 30 минут
// ════════════════════════════════════════════════════════════
function parseChannel() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss);
  
  // Читаем уже существующие ID чтобы не дублировать
  const existingIds = getExistingIds(sheet);
  Logger.log('Существующих объявлений: ' + existingIds.size);
  
  // Последний обработанный ID
  const propStore  = PropertiesService.getScriptProperties();
  const lastIdStr  = propStore.getProperty('LAST_MSG_ID') || '0';
  const lastId     = parseInt(lastIdStr);
  
  const newRows    = [];
  let maxSeenId    = lastId;
  let url          = CHANNEL_URL;
  let stopParsing  = false;

  for (let page = 0; page < MAX_PAGES && !stopParsing; page++) {
    Logger.log('Страница ' + (page + 1) + ': ' + url);
    
    const html = fetchPage(url);
    if (!html) break;
    
    const posts = extractPosts(html);
    Logger.log('Постов на странице: ' + posts.length);
    
    for (const post of posts) {
      const msgId = parseInt(post.id);
      
      if (msgId <= lastId || existingIds.has(post.id)) {
        Logger.log('ID ' + post.id + ' уже в базе — стоп');
        stopParsing = true;
        break;
      }
      
      const listing = parsePost(post);
      if (listing) {
        newRows.push(listing);
        Logger.log('✓ [' + post.id + '] ' + listing.district + ' ' + listing.type + ' $' + listing.price);
      }
      
      maxSeenId = Math.max(maxSeenId, msgId);
    }
    
    // Следующая страница
    const nextUrl = extractNextUrl(html);
    if (!nextUrl) break;
    url = nextUrl;
    Utilities.sleep(1500); // пауза между запросами
  }
  
  // Записываем новые строки в начало таблицы (после заголовка)
  if (newRows.length > 0) {
    const rows2d = newRows.map(rowToArray);
    sheet.insertRowsAfter(1, rows2d.length);
    const range = sheet.getRange(2, 1, rows2d.length, HEADERS.length);
    range.setValues(rows2d);
    Logger.log('Записано: ' + newRows.length + ' объявлений');
    
    // Обновляем последний ID
    propStore.setProperty('LAST_MSG_ID', maxSeenId.toString());
  } else {
    Logger.log('Новых объявлений нет');
  }
  
  // Записываем время последнего обновления
  propStore.setProperty('LAST_RUN', new Date().toISOString());
}


// ════════════════════════════════════════════════════════════
//  FETCH СТРАНИЦЫ
// ════════════════════════════════════════════════════════════
function fetchPage(url) {
  try {
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RentParser/1.0)' }
    });
    if (resp.getResponseCode() !== 200) return null;
    return resp.getContentText();
  } catch(e) {
    Logger.log('Ошибка fetch: ' + e);
    return null;
  }
}


// ════════════════════════════════════════════════════════════
//  ИЗВЛЕЧЕНИЕ ПОСТОВ ИЗ HTML
// ════════════════════════════════════════════════════════════
function extractPosts(html) {
  const posts = [];
  
  // Каждый пост в t.me/s/ имеет data-post="channel/ID"
  const postRegex = /data-post="rent_tbilisi_ge\/(\d+)"[\s\S]*?class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  
  // Простой подход — разбиваем по блокам постов
  const blocks = html.split('data-post="rent_tbilisi_ge/');
  
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    
    // ID поста
    const idMatch = block.match(/^(\d+)"/);
    if (!idMatch) continue;
    const id = idMatch[1];
    
    // Текст поста — между классом message_text и следующим закрывающим блоком
    const textMatch = block.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
    if (!textMatch) continue;
    
    // Очищаем HTML теги, оставляем текст и эмодзи
    let text = textMatch[1]
      .replace(/<br\/?>/gi, '\n')
      .replace(/<a[^>]*href="[^"]*"[^>]*>(#[^<]+)<\/a>/g, '$1') // хештеги
      .replace(/<a[^>]*>([\s\S]*?)<\/a>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#39;/g, "'")
      .trim();
    
    // Фото — ищем background-image в стиле
    let photoUrl = '';
    const photoMatch = block.match(/tgme_widget_message_photo_wrap[^>]*style="[^"]*background-image:url\('([^']+)'\)/);
    if (photoMatch) photoUrl = photoMatch[1];
    
    if (text) {
      posts.push({ id, text, photo: photoUrl });
    }
  }
  
  return posts;
}


// ════════════════════════════════════════════════════════════
//  ИЗВЛЕЧЕНИЕ URL СЛЕДУЮЩЕЙ СТРАНИЦЫ
// ════════════════════════════════════════════════════════════
function extractNextUrl(html) {
  const match = html.match(/href="(\/s\/rent_tbilisi_ge\?before=\d+)"/);
  if (match) return 'https://t.me' + match[1];
  return null;
}


// ════════════════════════════════════════════════════════════
//  ПАРСЕР ОДНОГО ПОСТА
// ════════════════════════════════════════════════════════════
function parsePost(post) {
  const text = post.text;
  
  // Пост должен быть объявлением
  if (!text.includes('$') && !text.includes('💰')) return null;
  if (!text.includes('#Rent') && !text.includes('#Sale') && !text.includes('#Commercial')) return null;
  
  const l = {
    id:          post.id,
    tg_url:      'https://t.me/rent_tbilisi_ge/' + post.id,
    photo:       post.photo || '',
    parsed_at:   new Date().toISOString(),
    is_new:      'TRUE',
    is_exclusive: (text.includes('#Exclusive') || text.toLowerCase().includes('exclusive listing')) ? 'TRUE' : 'FALSE',
  };
  
  // ── ТИП СДЕЛКИ ──
  if (text.includes('#Commercial')) l.type = 'commercial';
  else if (text.includes('#Sale') && !text.includes('#Rent')) l.type = 'sale';
  else l.type = 'rent';
  
  // ── КОМНАТЫ ──
  const roomMap = {'#Studio':0,'#1Bed':1,'#2Bed':2,'#3Bed':3,'#4Bed':4,'#5Bed':5};
  l.rooms = '';
  for (const [tag, val] of Object.entries(roomMap)) {
    if (text.includes(tag)) { l.rooms = val; break; }
  }
  
  // ── РАЙОН ──
  l.district = '';
  l.metro    = '';
  l.lat      = '';
  l.lng      = '';
  
  // Первые 3 строки поста содержат район как хештег
  const firstLines = text.split('\n').slice(0, 4).join('\n');
  const hashTags = firstLines.match(/#([A-Z][a-zA-Z]+)/g) || [];
  
  for (const tag of hashTags) {
    const name = tag.slice(1); // убираем #
    const low  = name.toLowerCase();
    if (COORDS[low]) {
      l.district = name;
      const c = COORDS[low];
      // небольшой jitter чтобы маркеры не сливались
      l.lat = (c[0] + (Math.random() - 0.5) * 0.01).toFixed(6);
      l.lng = (c[1] + (Math.random() - 0.5) * 0.01).toFixed(6);
      break;
    }
  }
  
  // Метро
  const metroMatch = text.match(/🚇\s*#?([A-Za-z][A-Za-z ]+)/);
  if (metroMatch) l.metro = metroMatch[1].trim();
  
  // ── АДРЕС ──
  const addrMatch = text.match(/📍\s*([^\n]+)/);
  l.address = addrMatch ? addrMatch[1].replace(/\[|\]/g, '').trim() : '';
  
  // ── ПЛОЩАДЬ ──
  const sqmMatch = text.match(/(\d+(?:\.\d+)?)\s*[Ss]q\.?m/);
  l.sqm = sqmMatch ? parseFloat(sqmMatch[1]) : '';
  
  // ── ЭТАЖ ──
  const floorMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*[Ff]loor/);
  if (floorMatch) {
    l.floor  = parseInt(floorMatch[1]);
    l.floors = parseInt(floorMatch[2]);
  } else {
    l.floor  = '';
    l.floors = '';
  }
  
  // ── ОТОПЛЕНИЕ ──
  if (text.includes('#CentralHeating'))  l.heating = 'Central';
  else if (text.includes('#GasHeating')) l.heating = 'Gas';
  else if (text.includes('#ElectricHeating')) l.heating = 'Electric';
  else l.heating = '';
  
  // ── ЗДАНИЕ ──
  if (text.includes('#NewBuilding'))      l.building = 'New';
  else if (text.includes('#OldBuilding')) l.building = 'Old';
  else l.building = '';
  
  // ── ЦЕНА ──
  // Форматы: 💰 550$ / 💰 1800$ + Deposit / Each 1400$
  const priceMatch = text.match(/💰\s*(?:Each\s*)?(\d[\d,]+)\s*\$/) ||
                     text.match(/(\d[\d,]+)\s*\$\s*\+\s*Deposit/);
  l.price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : '';
  
  // ── ДЕПОЗИТ ──
  const depMatch = text.match(/Deposit\s+(\d[\d,]+)\s*\$/) ||
                   text.match(/\+\s*(\d[\d,]+)\s*\$\s*Deposit/) ||
                   text.match(/(\d[\d,]+)\s*\$\s*Deposit/);
  l.deposit = depMatch ? parseInt(depMatch[1].replace(/,/g, '')) : '';
  
  // ── КОМИССИЯ ──
  l.commission = (text.includes('0% Commission') || text.includes('0% commission')) ? 0 : '';
  
  // ── УДОБСТВА ──
  l.wifi           = text.includes('#WiFi')           ? 'TRUE' : 'FALSE';
  l.stove          = text.includes('#Stove')          ? 'TRUE' : 'FALSE';
  l.balcony        = text.includes('#Balcony')        ? 'TRUE' : 'FALSE';
  l.tv             = text.includes('#TV')             ? 'TRUE' : 'FALSE';
  l.conditioner    = text.includes('#Conditioner')    ? 'TRUE' : 'FALSE';
  l.dishwasher     = text.includes('#Dishwasher')     ? 'TRUE' : 'FALSE';
  l.elevator       = text.includes('#Elevator')       ? 'TRUE' : 'FALSE';
  l.washing_machine= text.includes('#WashingMachine') ? 'TRUE' : 'FALSE';
  l.microwave      = text.includes('#Microwave')      ? 'TRUE' : 'FALSE';
  l.parking        = text.includes('#ParkingPlace')   ? 'TRUE' : 'FALSE';
  
  // ── ПИТОМЦЫ ──
  if (text.includes('Pets: #NotAllowed') || text.includes('Pets:#NotAllowed')) l.pets = 'FALSE';
  else if (text.includes('#ByAgreement') && text.includes('Pets')) l.pets = 'byagreement';
  else if (text.includes('Pets') && text.includes('Allowed')) l.pets = 'TRUE';
  else l.pets = 'FALSE';
  
  // ── ЖИЛЬЦЫ ──
  const tenantsMatch = text.match(/👬\s*Tenants:\s*([0-9\-]+)/);
  l.tenants = tenantsMatch ? tenantsMatch[1] : '';
  
  // ── СРОК ──
  const terms = (text.match(/#\d+Month/g) || []).join(',');
  l.term = terms;
  
  // ── АГЕНТ ──
  const agentMatch = text.match(/\|\s*#([A-Z][a-z]+)\s*$/) ||
                     text.match(/#([A-Z][a-z]+)\s*\n?\s*🌟/);
  l.agent   = agentMatch ? agentMatch[1] : 'David';
  l.phone   = '+995 599 20 67 16';
  l.contact = '@David_Tibelashvili';
  
  // ── ЗАГОЛОВОК ──
  const roomLabels = {0:'Студия', 1:'1-комн.', 2:'2-комн.', 3:'3-комн.', 4:'4-комн.', 5:'5-комн.'};
  const rLabel = roomLabels[l.rooms] || '';
  const bLabel = {New:'Новостройка', Old:'Старый фонд'}[l.building] || '';
  l.title = [rLabel, bLabel, l.district].filter(Boolean).join(' • ');
  
  return l.price ? l : null; // пропускаем без цены
}


// ════════════════════════════════════════════════════════════
//  GOOGLE SHEETS HELPERS
// ════════════════════════════════════════════════════════════
const HEADERS = [
  'id','tg_url','photo','parsed_at','is_new','is_exclusive',
  'type','rooms','title','address','district','metro',
  'lat','lng','sqm','floor','floors','heating','building',
  'price','deposit','commission',
  'wifi','stove','balcony','tv','conditioner','dishwasher',
  'elevator','washing_machine','microwave','parking',
  'pets','tenants','term','agent','phone','contact',
];

function rowToArray(l) {
  return HEADERS.map(h => l[h] !== undefined ? l[h] : '');
}

function getOrCreateSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    // Заголовки жирным
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    Logger.log('Создан лист: ' + SHEET_NAME);
  }
  return sheet;
}

function getExistingIds(sheet) {
  const ids = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return ids;
  const vals = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  vals.forEach(row => { if (row[0]) ids.add(String(row[0])); });
  return ids;
}


// ════════════════════════════════════════════════════════════
//  WEB APP — отдаёт JSON для сайта
//  Деплоить как Web App: Execute as Me, Anyone can access
// ════════════════════════════════════════════════════════════
function doGet(e) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(SHEET_NAME);
  const props   = PropertiesService.getScriptProperties();
  
  if (!sheet) {
    return jsonResponse({ listings: [], updated_at: '', total: 0 });
  }
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ listings: [], updated_at: props.getProperty('LAST_RUN') || '', total: 0 });
  }
  
  // Читаем все данные
  const data = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  
  const listings = data
    .filter(row => row[0] && row[19]) // id и price не пустые
    .slice(0, 200) // максимум 200 объявлений
    .map(row => {
      const obj = {};
      HEADERS.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
  
  return jsonResponse({
    listings:   listings,
    total:      listings.length,
    updated_at: props.getProperty('LAST_RUN') || new Date().toISOString(),
  });
}

function jsonResponse(data) {
  const output = ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}


// ════════════════════════════════════════════════════════════
//  SETUP — запустить один раз вручную
//  Создаёт триггер на каждые 30 минут
// ════════════════════════════════════════════════════════════
function setup() {
  // Удаляем старые триггеры
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'parseChannel') {
      ScriptApp.deleteTrigger(t);
    }
  });
  
  // Создаём новый триггер каждые 30 минут
  ScriptApp.newTrigger('parseChannel')
    .timeBased()
    .everyMinutes(30)
    .create();
  
  Logger.log('✅ Триггер создан — парсер запускается каждые 30 минут');
  
  // Первый запуск сразу
  parseChannel();
}


// ════════════════════════════════════════════════════════════
//  RESET — очистить таблицу и начать заново
// ════════════════════════════════════════════════════════════
function reset() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.deleteRows(2, sheet.getLastRow() - 1);
  }
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log('База очищена');
}
