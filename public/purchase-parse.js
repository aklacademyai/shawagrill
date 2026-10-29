// Invoice line parser for the purchase-scan flow.
// Pure functions with no DOM access, so tests can import them directly.
// Everything produced here is a DRAFT: OCR makes mistakes and the manager
// must review every line before the purchase document is posted.

const UNIT_DEFS = {
  lb: ['lbs', 'pound', 'pounds', 'фунтов', 'фунта', 'фунт', 'lb'],
  kg: ['kg', 'кг'],
  'г': ['грамм', 'грамма', 'граммов', 'гр', 'g', 'г'],
  oz: ['oz', 'унций', 'унция', 'унц'],
  'шт': ['pcs', 'pc', 'ea', 'штук', 'штуки', 'шт'],
  'л': ['литр', 'литра', 'литров', 'liter', 'liters', 'litre', 'l', 'л'],
  case: ['ящиков', 'ящика', 'ящик', 'cases', 'case', 'cs'],
  bag: ['мешков', 'мешка', 'мешок', 'bags', 'bag'],
  box: ['коробок', 'коробки', 'коробка', 'короб', 'boxes', 'box']
};
const UNIT_ALIASES = Object.entries(UNIT_DEFS)
  .flatMap(([unit, aliases]) => aliases.map(alias => ({ alias, unit })))
  .sort((a, b) => b.alias.length - a.alias.length);

const SKIP_LINE = /итого|всего к|к оплате|total|subtotal|tax|ндс|vat|amount due|balance due|скидк|discount/i;
const NUMBER_GLOBAL = /(\d[\d ]*(?:[.,]\d+)?|\d+)/g;

// "1 250.00" / "1,250.00" / "24,90" / "950" -> number
export function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[\s  ]/g, '').replace(/[$₽€%]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma) s = s.replace(/,/g, '');
  else if (lastComma >= 0) s = s.replace(',', '.');
  const value = Number(s);
  return Number.isFinite(value) ? value : null;
}

function escapeRe(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function findUnit(line) {
  for (const { alias, unit } of UNIT_ALIASES) {
    const re = new RegExp(`(^|[\\s,;:(])${escapeRe(alias)}(?=$|[\\s,;:)\\]])`, 'i');
    const match = re.exec(line);
    if (match) {
      const start = match.index + match[1].length;
      return { unit, alias, start, end: start + alias.length };
    }
  }
  return null;
}

function numbersIn(text, baseOffset = 0) {
  const found = [];
  for (const match of text.matchAll(NUMBER_GLOBAL)) {
    found.push({ raw: match[0], value: parseAmount(match[0]), start: baseOffset + match.index, end: baseOffset + match.index + match[0].length });
  }
  return found.filter(n => n.value != null);
}

function blankSpans(line, spans) {
  const chars = [...line];
  for (const [start, end] of spans) {
    for (let i = start; i < end && i < chars.length; i += 1) chars[i] = ' ';
  }
  return chars.join('');
}

function cleanName(text) {
  return text
    .replace(/[$₽€]/g, ' ')
    .replace(/^[\s#№]*\d{3,}[\s\-–—]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:\-–—]+|[\s.,;:\-–—]+$/g, '')
    .trim();
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9 ]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Fuzzy ingredient match: exact / substring first, then token overlap.
export function matchIngredient(name, ingredients) {
  const target = normalizeName(name);
  if (!target) return null;
  let best = null;
  let bestScore = 0;
  for (const ingredient of ingredients || []) {
    const candidate = normalizeName(ingredient.name);
    if (!candidate) continue;
    let score = 0;
    if (candidate === target) score = 1;
    else if (target.includes(candidate) || candidate.includes(target)) score = 0.9;
    else {
      const a = new Set(target.split(' ').filter(w => w.length >= 2));
      const b = new Set(candidate.split(' ').filter(w => w.length >= 2));
      if (a.size && b.size) {
        let shared = 0;
        for (const word of a) if (b.has(word)) shared += 1;
        score = shared / Math.max(a.size, b.size);
      }
    }
    if (score > bestScore) { bestScore = score; best = ingredient; }
  }
  return bestScore >= 0.5 && best ? { ingredientId: best.id, score: bestScore } : null;
}

export function parseInvoiceLine(rawLine) {
  const line = String(rawLine || '').trim();
  if (line.length < 3 || !/\d/.test(line) || SKIP_LINE.test(line)) return null;
  const spans = [];
  let qty = null;
  let total = null;
  let unit = '';

  // "10 x 2.49" pattern: qty times unit price.
  const times = /(^|\s)(\d+(?:[.,]\d+)?)\s*[xх×]\s*\$?\s*(\d+(?:[.,]\d+)?)/.exec(line);
  if (times) {
    qty = parseAmount(times[2]);
    const unitPrice = parseAmount(times[3]);
    if (qty != null && unitPrice != null) total = Math.round(qty * unitPrice * 100) / 100;
    spans.push([times.index + times[1].length, times.index + times[0].length]);
  }

  const unitHit = findUnit(line);
  if (unitHit) {
    unit = unitHit.unit;
    spans.push([unitHit.start, unitHit.end]);
    if (qty == null) {
      const before = line.slice(0, unitHit.start);
      const tail = /(\d[\d ]*(?:[.,]\d+)?|\d+)\s*$/.exec(before);
      if (tail) {
        qty = parseAmount(tail[1]);
        spans.push([tail.index, tail.index + tail[1].length]);
      }
    }
  }

  if (total == null) {
    const rest = blankSpans(line, spans);
    const numbers = numbersIn(rest);
    if (numbers.length) {
      const last = numbers[numbers.length - 1];
      total = last.value;
      spans.push([last.start, last.end]);
    }
  }

  if (qty == null && !unitHit && total != null) {
    // No unit on the line: fall back to "first number = qty, last = amount".
    const numbers = numbersIn(line);
    if (numbers.length >= 2) {
      qty = numbers[0].value;
      spans.push([numbers[0].start, numbers[0].end]);
    }
  }

  if (qty == null || !(qty > 0)) return null;
  if (total == null) {
    if (!unitHit) return null;
    total = 0; // amount unreadable; the manager fills it in the draft
  }

  const name = cleanName(blankSpans(line, spans));
  if (name.replace(/[^a-zа-яё]/gi, '').length < 2) return null;
  return { raw: line, name, qty, unit, totalCost: total };
}

export function parseInvoiceText(text, ingredients = []) {
  const lines = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const parsed = parseInvoiceLine(rawLine);
    if (!parsed) continue;
    const match = matchIngredient(parsed.name, ingredients);
    lines.push({ ...parsed, ingredientId: match ? match.ingredientId : null });
  }
  return lines;
}
