// Inbound supplier invoices: email (Cloudflare Email Worker) and webhook
// (POST /api/invoice-inbound) both land here. Every message becomes a DRAFT
// in invoice_drafts — never a posted purchase. A manager reviews the parsed
// lines in the panel and confirms manually; only then does the normal
// purchase-document posting run (see confirm handler in api.js).
import { parseInvoiceText } from '../public/purchase-parse.js';

const MAX_PDF_BYTES = 3 * 1024 * 1024;       // extract text from PDFs up to 3 MB
const MAX_PHOTO_BASE64 = 950000;             // same cap as scan-flow photos in D1
const MAX_RAW_TEXT = 60000;                  // stored text snapshot per draft

async function all(env, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...params).all();
  return result.results || [];
}
async function run(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(text) {
  const clean = String(text || '').replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function extractPdfText(bytes) {
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : String(text || '');
  } catch (error) {
    console.error('invoice pdf extract failed', error);
    return '';
  }
}

function guessDocDate(text, fallback) {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(text);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return fallback;
}

// attachments: [{ filename, mimeType, bytes: Uint8Array }]
export async function storeInboundInvoice(env, { sender = '', subject = '', bodyText = '', attachments = [], todayKey = '' }) {
  const textParts = [];
  if (bodyText) textParts.push(String(bodyText));
  let photoJpeg = null;
  let attachmentName = '';
  let attachmentKind = '';
  for (const att of attachments || []) {
    const name = String(att.filename || '');
    const mime = String(att.mimeType || '').toLowerCase();
    const bytes = att.bytes instanceof Uint8Array ? att.bytes : new Uint8Array(att.bytes || []);
    const isPdf = mime.includes('pdf') || /\.pdf$/i.test(name);
    const isImage = mime.startsWith('image/') || /\.(jpe?g|png)$/i.test(name);
    if (!attachmentName && name) { attachmentName = name; attachmentKind = isPdf ? 'pdf' : isImage ? 'image' : 'file'; }
    if (isPdf && bytes.length && bytes.length <= MAX_PDF_BYTES) {
      const pdfText = await extractPdfText(bytes);
      if (pdfText) textParts.push(pdfText);
    } else if (mime.includes('jpeg') || mime.includes('jpg') || /\.jpe?g$/i.test(name)) {
      // Image attachments keep the scan-flow path open: the photo is stored
      // on the draft and the panel can run the usual browser OCR on it.
      if (!photoJpeg && bytes.length) {
        const b64 = bytesToBase64(bytes);
        if (b64.length <= MAX_PHOTO_BASE64) photoJpeg = b64;
      }
    }
  }
  const rawText = textParts.join('\n').slice(0, MAX_RAW_TEXT);
  const ingredients = await all(env, 'SELECT id, name FROM ingredients WHERE active = 1');
  const parsed = parseInvoiceText(rawText, ingredients);
  const lines = parsed.map(p => ({
    name: p.name, qty: p.qty, unit: p.unit || '', totalCost: p.totalCost,
    ingredientId: p.ingredientId ?? null, raw: p.raw || ''
  }));
  const totalCents = lines.reduce((sum, line) => sum + Math.round(Number(line.totalCost || 0) * 100), 0);
  // Prefill the supplier when the sender display name matches a supplier
  // card exactly; the manager still confirms/edits it in the panel.
  let supplier = '';
  try {
    const displayName = String(sender || '').replace(/<[^>]*>/g, '').trim();
    if (displayName && !displayName.includes('@')) {
      const cards = await all(env, 'SELECT name FROM suppliers WHERE lower(name) = lower(?)', displayName);
      if (cards.length) supplier = cards[0].name;
    }
  } catch { /* suppliers registry is optional for the inbound channel */ }
  const result = await run(env, `INSERT INTO invoice_drafts(sender, subject, supplier, doc_date, photo_jpeg,
      attachment_name, attachment_kind, raw_text, lines_json, total_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    String(sender || '').slice(0, 300), String(subject || '').slice(0, 300), supplier,
    guessDocDate(rawText, todayKey), photoJpeg, attachmentName, attachmentKind,
    rawText, JSON.stringify(lines), totalCents);
  return { id: result.meta?.last_row_id, lines: lines.length, totalCents };
}

// Cloudflare Email Worker entry: message is the ForwardableEmailMessage.
export async function handleInboundEmail(message, env, todayKey = '') {
  const to = String(message.to || '').toLowerCase();
  if (to && !to.includes('invoices@shawa.work')) return { skipped: true };
  try {
    const { default: PostalMime } = await import('postal-mime');
    const parsed = await PostalMime.parse(message.raw);
    const attachments = (parsed.attachments || []).map(att => ({
      filename: att.filename || '',
      mimeType: att.mimeType || '',
      bytes: att.content instanceof Uint8Array ? att.content : new Uint8Array(att.content || [])
    }));
    const sender = parsed.from?.address
      ? (parsed.from.name ? `${parsed.from.name} <${parsed.from.address}>` : parsed.from.address)
      : String(message.from || '');
    return storeInboundInvoice(env, {
      sender,
      subject: parsed.subject || message.headers?.get?.('subject') || '',
      bodyText: parsed.text || '',
      attachments,
      todayKey
    });
  } catch (error) {
    console.error('inbound email failed', error);
    // Never lose the message silently: keep a bare draft for manual handling.
    try {
      const result = await run(env, `INSERT INTO invoice_drafts(sender, subject, doc_date) VALUES (?, ?, ?)`,
        String(message.from || '').slice(0, 300), String(message.headers?.get?.('subject') || '').slice(0, 300), todayKey);
      return { id: result.meta?.last_row_id, lines: 0, totalCents: 0, parseFailed: true };
    } catch { return { error: true }; }
  }
}

// Webhook payload: { from, subject, text, html?, attachments: [{ filename,
// contentType, contentBase64 }] } — for forwarders (e.g. a mailbox rule or an
// Apps Script) while Email Routing is being enabled on the zone.
export function normalizeWebhookPayload(data) {
  const attachments = (Array.isArray(data?.attachments) ? data.attachments : []).slice(0, 5).map(att => {
    let bytes = new Uint8Array();
    try { bytes = base64ToBytes(att.contentBase64 || att.content || ''); } catch { bytes = new Uint8Array(); }
    return { filename: String(att.filename || ''), mimeType: String(att.contentType || att.mimeType || ''), bytes };
  });
  return {
    sender: String(data?.from || data?.sender || '').slice(0, 300),
    subject: String(data?.subject || '').slice(0, 300),
    bodyText: String(data?.text || data?.plain || ''),
    attachments
  };
}
