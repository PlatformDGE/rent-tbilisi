// ============================================================
//  Rent in Tbilisi — Google Apps Script Parser
//  Парсит @rent_tbilisi_ge → Google Sheets → JSON для сайта
//  Запускается автоматически каждые 30 минут
// ============================================================

const CHANNEL_URL = 'https://t.me/s/rent_tbilisi_ge';
const SHEET_NAME  = 'listings';
const MAX_PAGES   = 10;

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
  'digomi':        [41.7490, 44.7630],
  'marjanishvili': [41.6930, 44.8120],
  'krtsanisi':     [41.6820, 44.8050],
  'avlabari':      [41.6880, 44.8240],
  'ortachala':     [41.6810, 44.8390],
  'varketili':     [41.7040, 44.8640],
  'samgori':       [41.6880, 44.8480],
  'temqa':         [41.7380, 44.8280],
  'lilo':          [41.7100, 44.8900],
};

// ════════════════════════════════════════════════════════════
//  GOOGLE DRIVE — для хранения фото
// ════════════════════════════════════════════════════════════
var DRIVE_FOLDER_NAME = 'RentTbilisi_Photos';
var _folder = null;

function getDriveFolder() {
  if (_folder) return _folder;
  var it = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  _folder = it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME);
  _folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return _folder;
}

function savePhoto(url, msgId) {
  if (!url || !url.startsWith('http')) return '';
  try {
    var folder = getDriveFolder();
    var name   = 'p_' + msgId + '.jpg';
    var ex     = folder.getFilesByName(name);
    if (ex.hasNext()) {
      return 'https://drive.google.com/uc?export=view&id=' + ex.next().getId();
    }
    var resp = UrlFetchApp.fetch(url, {muteHttpExceptions:true});
    if (resp.getResponseCode() !== 200) return '';
    var f = folder.createFile(resp.getBlob().setName(name));
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return 'https://drive.google.com/uc?export=view&id=' + f.getId();
  } catch(e) {
    Logger.log('savePhoto error: ' + e);
    return '';
  }
}


// ════════════════════════════════════════════════════════════
//  ГЛАВНАЯ ФУНКЦИЯ
// ════════════════════════════════════════════════════════════
function parseChannel() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss);

  const existingIds = getExistingIds(sheet);
  Logger.log('Существующих: ' + existingIds.size);

  const props   = PropertiesService.getScriptProperties();
  const lastId  = parseInt(props.getProperty('LAST_MSG_ID') || '0');

  const newRows = [];
  let maxSeenId = lastId;
  let url       = CHANNEL_URL;
  let stop      = false;

  for (let page = 0; page < MAX_PAGES && !stop; page++) {
    Logger.log('Страница ' + (page+1) + ': ' + url);

    const html = fetchPage(url);
    if (!html) break;

    const posts = extractPosts(html);
    Logger.log('Найдено постов: ' + posts.length);

    for (const post of posts) {
      const msgId = parseInt(post.id);

      if (msgId <= lastId || existingIds.has(post.id)) {
        Logger.log('ID ' + post.id + ' уже есть — стоп');
        stop = true;
        break;
      }

      const listing = parsePost(post);
      if (listing) {

        newRows.push(listing);
        Logger.log('✓ [' + post.id + '] ' + listing.district + ' ' + listing.type + ' $' + listing.price);
      } else {
        Logger.log('– [' + post.id + '] не объявление');
      }

      maxSeenId = Math.max(maxSeenId, msgId);
    }

    const nextUrl = extractNextUrl(html);
    if (!nextUrl) break;
    url = nextUrl;
    Utilities.sleep(1500);
  }

  if (newRows.length > 0) {
    const rows2d = newRows.map(rowToArray);
    sheet.insertRowsAfter(1, rows2d.length);
    sheet.getRange(2, 1, rows2d.length, HEADERS.length).setValues(rows2d);
    props.setProperty('LAST_MSG_ID', maxSeenId.toString());
    Logger.log('Записано: ' + newRows.length);
  } else {
    Logger.log('Новых нет');
  }

  props.setProperty('LAST_RUN', new Date().toISOString());
}

// ════════════════════════════════════════════════════════════
//  FETCH
// ════════════════════════════════════════════════════════════
function fetchPage(url) {
  try {
    const r = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' }
    });
    return r.getResponseCode() === 200 ? r.getContentText() : null;
  } catch(e) {
    Logger.log('Fetch error: ' + e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  ИЗВЛЕЧЕНИЕ ПОСТОВ
// ════════════════════════════════════════════════════════════
function extractPosts(html) {
  const posts = [];
  const seen  = new Set();

  // Разбиваем по data-post — каждый уникален
  const parts = html.split('data-post="rent_tbilisi_ge/');

  for (var i = 1; i < parts.length; i++) {
    var part = parts[i];

    // ID
    var idEnd = part.indexOf('"');
    if (idEnd === -1) continue;
    var id = part.substring(0, idEnd);
    if (seen.has(id)) continue;
    seen.add(id);

    // Текст — ищем tgme_widget_message_text
    var text = '';
    var ti = part.indexOf('tgme_widget_message_text');
    if (ti !== -1) {
      var open = part.indexOf('>', ti);
      if (open !== -1) {
        var depth = 1;
        var p = open + 1;
        var buf = '';
        while (p < part.length && depth > 0) {
          // br → newline
          if (part.substring(p, p+4).toLowerCase() === '<br>') {
            buf += '\n'; p += 4; continue;
          }
          if (part.substring(p, p+5).toLowerCase() === '<br/>') {
            buf += '\n'; p += 5; continue;
          }
          if (part[p] === '<') {
            if (part[p+1] === '/') {
              depth--;
            } else if (part[p+1] !== '!' && part[p+1] !== '?') {
              depth++;
            }
            // Пропускаем тег
            while (p < part.length && part[p] !== '>') p++;
          } else if (depth > 0) {
            buf += part[p];
          }
          p++;
        }
        text = buf
          .replace(/&amp;/g,'&').replace(/&lt;/g,'<')
          .replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
          .replace(/&#39;/g,"'").replace(/&quot;/g,'"')
          .replace(/\n{3,}/g,'\n\n')
          .trim();
      }
    }

    // Собираем фото и превью видео
    var photos = [];
    var searchPos = 0;
    while (searchPos < part.length) {
      var bgi = part.indexOf("background-image:url('https://cdn4.telesco.pe/file/", searchPos);
      if (bgi === -1) break;
      var ps = bgi + 22;
      var pe = part.indexOf("')", ps);
      if (pe !== -1) {
        var mediaUrl = part.substring(ps, pe);
        // Проверяем — видео или фото
        var beforeBgi = part.substring(Math.max(0, bgi - 200), bgi);
        var isVideoThumb = beforeBgi.indexOf('video_thumb') !== -1 || beforeBgi.indexOf('video_player') !== -1;
        // Добавляем с пометкой для видео
        var entry = isVideoThumb ? 'video:' + mediaUrl : mediaUrl;
        if (photos.indexOf(entry) === -1) photos.push(entry);
      }
      searchPos = bgi + 1;
    }
    var photo = photos.length > 0 ? photos[0].replace('video:','') : '';
    var photos_json = photos.length > 0 ? JSON.stringify(photos) : '';

    if (text.length > 30) {
      posts.push({ id: id, text: text, photo: photo, photos_json: photos_json });
    }
  }

  return posts;
}

// ════════════════════════════════════════════════════════════
//  СЛЕДУЮЩАЯ СТРАНИЦА
// ════════════════════════════════════════════════════════════
function extractNextUrl(html) {
  var m = html.match(/href="(\/s\/rent_tbilisi_ge\?before=\d+)"/);
  return m ? 'https://t.me' + m[1] : null;
}

// ════════════════════════════════════════════════════════════
//  ПАРСЕР ПОСТА
// ════════════════════════════════════════════════════════════
function parsePost(post) {
  var text = post.text;

  if (!text.includes('$') && !text.includes('💰')) return null;
  if (!text.includes('#Rent') && !text.includes('#Sale') && !text.includes('#Commercial')) return null;

  var l = {
    id:           post.id,
    tg_url:       'https://t.me/rent_tbilisi_ge/' + post.id,
    photo:        post.photo || '',
    photos:       post.photos_json || '',
    parsed_at:    new Date().toISOString(),
    is_new:       'TRUE',
    is_exclusive: (text.includes('#Exclusive') || text.toLowerCase().includes('exclusive listing')) ? 'TRUE' : 'FALSE',
  };

  // Тип
  if (text.includes('#Commercial'))                             l.type = 'commercial';
  else if (text.includes('#Sale') && !text.includes('#Rent'))   l.type = 'sale';
  else                                                          l.type = 'rent';

  // Комнаты
  var roomMap = {'#Studio':0,'#1Bed':1,'#2Bed':2,'#3Bed':3,'#4Bed':4,'#5Bed':5};
  l.rooms = '';
  for (var tag in roomMap) {
    if (text.includes(tag)) { l.rooms = roomMap[tag]; break; }
  }

  // Район — ищем хештеги в первых строках
  l.district = '';
  l.metro    = '';
  l.lat      = '';
  l.lng      = '';

  var firstLines = text.split('\n').slice(0, 5).join(' ');
  var tags = firstLines.match(/#([A-Z][a-zA-Z]+)/g) || [];

  for (var t = 0; t < tags.length; t++) {
    var name = tags[t].slice(1);
    var low  = name.toLowerCase();
    if (COORDS[low]) {
      l.district = name;
      var c = COORDS[low];
      l.lat = (c[0] + (Math.random()-0.5)*0.01).toFixed(6);
      l.lng = (c[1] + (Math.random()-0.5)*0.01).toFixed(6);
      break;
    }
  }

  // Метро
  var metroM = text.match(/🚇\s*#?([A-Za-z][A-Za-z ]+)/);
  l.metro = metroM ? metroM[1].trim() : '';

  // Адрес
  var addrM = text.match(/📍\s*([^\n]+)/);
  l.address = addrM ? addrM[1].replace(/[\[\]]/g,'').trim() : '';

  // Площадь
  var sqmM = text.match(/(\d+(?:\.\d+)?)\s*[Ss]q\.?m/);
  l.sqm = sqmM ? parseFloat(sqmM[1]) : '';

  // Этаж
  var floorM = text.match(/(\d+)\s*\/\s*(\d+)\s*[Ff]loor/);
  if (floorM) { l.floor = parseInt(floorM[1]); l.floors = parseInt(floorM[2]); }
  else        { l.floor = ''; l.floors = ''; }

  // Отопление
  if      (text.includes('#CentralHeating'))  l.heating = 'Central';
  else if (text.includes('#GasHeating'))      l.heating = 'Gas';
  else if (text.includes('#ElectricHeating')) l.heating = 'Electric';
  else                                        l.heating = '';

  // Здание
  if      (text.includes('#NewBuilding'))  l.building = 'New';
  else if (text.includes('#OldBuilding'))  l.building = 'Old';
  else                                     l.building = '';

  // Цена
  var priceM = text.match(/💰\s*(?:Each\s*)?(\d[\d,]*)\s*\$/) ||
               text.match(/(\d[\d,]*)\s*\$\s*\+\s*Deposit/) ||
               text.match(/💰\s*(\d[\d,]*)/);
  l.price = priceM ? parseInt(priceM[1].replace(/,/g,'')) : '';

  // Депозит
  var depM = text.match(/Deposit\s+(\d[\d,]*)\s*\$/) ||
             text.match(/\+\s*(\d[\d,]*)\s*\$\s*Deposit/) ||
             text.match(/(\d[\d,]*)\s*\$\s*Deposit/);
  l.deposit = depM ? parseInt(depM[1].replace(/,/g,'')) : '';

  // Комиссия
  l.commission = (text.includes('0% Commission') || text.includes('0% commission')) ? 0 : '';

  // Удобства
  l.wifi            = text.includes('#WiFi')            ? 'TRUE':'FALSE';
  l.stove           = text.includes('#Stove')           ? 'TRUE':'FALSE';
  l.balcony         = text.includes('#Balcony')         ? 'TRUE':'FALSE';
  l.tv              = text.includes('#TV')              ? 'TRUE':'FALSE';
  l.conditioner     = text.includes('#Conditioner')     ? 'TRUE':'FALSE';
  l.dishwasher      = text.includes('#Dishwasher')      ? 'TRUE':'FALSE';
  l.elevator        = text.includes('#Elevator')        ? 'TRUE':'FALSE';
  l.washing_machine = text.includes('#WashingMachine')  ? 'TRUE':'FALSE';
  l.microwave       = text.includes('#Microwave')       ? 'TRUE':'FALSE';
  l.parking         = text.includes('#ParkingPlace')    ? 'TRUE':'FALSE';

  // Питомцы
  if      (text.includes('Pets: #NotAllowed'))  l.pets = 'FALSE';
  else if (text.includes('#ByAgreement'))        l.pets = 'byagreement';
  else if (text.includes('Pets') && text.includes('Allowed')) l.pets = 'TRUE';
  else                                           l.pets = 'FALSE';

  // Жильцы
  var tenM = text.match(/👬\s*Tenants:\s*([0-9\-]+)/);
  l.tenants = tenM ? tenM[1] : '';

  // Срок
  var terms = (text.match(/#\d+Month/g) || []).join(',');
  l.term = terms;

  // Агент
  var agentM = text.match(/\|\s*#([A-Z][a-z]+)\s*$/) ||
               text.match(/#([A-Z][a-z]+)\s*\n?\s*🌟/) ||
               text.match(/📲[^#]*#([A-Z][a-z]+)/);
  l.agent   = agentM ? agentM[1] : 'David';
  l.phone   = '+995 599 20 67 16';
  l.contact = '@David_Tibelashvili';

  // Заголовок
  var rLabel = {0:'Студия',1:'1-комн.',2:'2-комн.',3:'3-комн.',4:'4-комн.',5:'5-комн.'}[l.rooms] || '';
  var bLabel = {New:'Новостройка',Old:'Старый фонд'}[l.building] || '';
  l.title = [rLabel, bLabel, l.district].filter(Boolean).join(' • ');

  return l.price ? l : null;
}

// ════════════════════════════════════════════════════════════
//  SHEETS HELPERS
// ════════════════════════════════════════════════════════════
var HEADERS = [
  'id','tg_url','photo','photos','parsed_at','is_new','is_exclusive',
  'type','rooms','title','address','district','metro',
  'lat','lng','sqm','floor','floors','heating','building',
  'price','deposit','commission',
  'wifi','stove','balcony','tv','conditioner','dishwasher',
  'elevator','washing_machine','microwave','parking',
  'pets','tenants','term','agent','phone','contact',
];

function rowToArray(l) {
  return HEADERS.map(function(h){ return l[h] !== undefined ? l[h] : ''; });
}

function getOrCreateSheet(ss) {
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1,1,1,HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

function getExistingIds(sheet) {
  var ids = new Set();
  var last = sheet.getLastRow();
  if (last < 2) return ids;
  sheet.getRange(2,1,last-1,1).getValues()
       .forEach(function(r){ if(r[0]) ids.add(String(r[0])); });
  return ids;
}

// ════════════════════════════════════════════════════════════
//  WEB APP — JSON для сайта
// ════════════════════════════════════════════════════════════
function doGet(e) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  var props = PropertiesService.getScriptProperties();

  var result;
  if (!sheet || sheet.getLastRow() < 2) {
    result = { listings:[], total:0, updated_at:'' };
  } else {
    var data = sheet.getRange(2,1,sheet.getLastRow()-1,HEADERS.length).getValues();
    var listings = data
      .filter(function(r){ return r[0] && r[19]; })
      .slice(0, 300)
      .map(function(r){
        var o = {};
        HEADERS.forEach(function(h,i){ o[h]=r[i]; });
        return o;
      });
    result = {
      listings:   listings,
      total:      listings.length,
      updated_at: props.getProperty('LAST_RUN') || '',
    };
  }

  // Support callback param for CORS bypass
  var cb = e && e.parameter && e.parameter.cb ? e.parameter.cb : null;
  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify(result) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════════════════════
//  SETUP — запустить один раз
// ════════════════════════════════════════════════════════════
function setup() {
  ScriptApp.getProjectTriggers().forEach(function(t){
    if (t.getHandlerFunction() === 'parseChannel') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('parseChannel').timeBased().everyMinutes(30).create();
  Logger.log('✅ Триггер создан — парсер запускается каждые 30 минут');
  parseChannel();
}

// ════════════════════════════════════════════════════════════
//  RESET — очистить и начать заново
// ════════════════════════════════════════════════════════════
function reset() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.deleteRows(2, sheet.getLastRow()-1);
  }
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log('✅ База очищена');
}

// ════════════════════════════════════════════════════════════
//  DEBUG — для диагностики
// ════════════════════════════════════════════════════════════
function debugHtml() {
  var html = fetchPage(CHANNEL_URL);
  Logger.log('Размер: ' + html.length);
  var posts = extractPosts(html);
  Logger.log('Постов: ' + posts.length);
  posts.forEach(function(p){
    Logger.log('--- ID:' + p.id + ' ---');
    Logger.log(p.text.substring(0,300));
  });
}

function parseAll() {
  for (var i = 0; i < 3; i++) {
    parseChannel();
    Utilities.sleep(2000);
  }
}
