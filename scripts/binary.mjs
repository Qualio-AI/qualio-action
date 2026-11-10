// Binary files of the tests folder (a committed .xlsx, a PDF, an image). They are never sent to Qualio as
// they are: the snapshot carries a text description in their place, starting with BINARY_FILE_MARKER (the
// same marker as @qualio/shared's in qualio-webapp: keep them in step), so the agents know the file is
// there and what a spreadsheet holds, and Qualio never writes over them. Node 20, no dependencies.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const BINARY_FILE_MARKER = '[qualio:binary]';

const SAMPLE_ROWS = 5;
const MAX_SHEETS = 3;
const MAX_CELL = 40;

/** Whether a file's bytes aren't text: a NUL byte near the start, or not valid UTF-8. */
export function isBinary(buffer) {
  if (buffer.subarray(0, 8000).includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

/** What kind of file it is, from its first bytes and its name. */
function kindOf(rel, buffer) {
  const ext = path.extname(rel).toLowerCase();
  const head = buffer.subarray(0, 8).toString('latin1');
  if (head.startsWith('%PDF')) return 'PDF document';
  if (head.startsWith('\x89PNG')) return 'PNG image';
  if (head.startsWith('\xff\xd8\xff')) return 'JPEG image';
  if (head.startsWith('GIF8')) return 'GIF image';
  if (head.startsWith('PK\x03\x04')) {
    if (ext === '.xlsx' || ext === '.xlsm') return 'Excel workbook';
    if (ext === '.docx') return 'Word document';
    return 'Zip archive';
  }
  if (ext === '.xls') return 'Excel 97-2003 workbook';
  return `Binary file${ext ? ` (${ext})` : ''}`;
}

/** The text Qualio gets in a binary file's place: what it is, its size and hash, and a workbook's sheets. */
export function describeBinary(rel, buffer) {
  const lines = [
    `${BINARY_FILE_MARKER} ${kindOf(rel, buffer)}, ${buffer.length} bytes, sha256 ${createHash('sha256').update(buffer).digest('hex')}`,
    `Not sent to Qualio. Tests read it with fixtureFile('${rel}') from support/files; Qualio never changes it.`,
  ];
  if (buffer.subarray(0, 4).toString('latin1') === 'PK\x03\x04' && /\.xls[xm]$/i.test(rel)) {
    try {
      const sheets = Object.entries(readXlsx(buffer));
      for (const [name, rows] of sheets.slice(0, MAX_SHEETS)) {
        lines.push(`Sheet "${name}": ${rows.length} row${rows.length === 1 ? '' : 's'}`);
        rows.slice(0, SAMPLE_ROWS).forEach((row, i) => lines.push(`  ${i + 1}: ${row.map((cell) => (cell.length > MAX_CELL ? `${cell.slice(0, MAX_CELL)}…` : cell)).join(' | ')}`));
      }
      if (sheets.length > MAX_SHEETS) lines.push(`(${sheets.length - MAX_SHEETS} more sheets)`);
    } catch {
      lines.push('(The workbook could not be read.)');
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------- A minimal .xlsx reader (zip of XML parts), like support/files.ts's readXlsx ----------

function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  const files = new Map();
  let at = buffer.readUInt32LE(end + 16);
  for (let i = 0, count = buffer.readUInt16LE(end + 10); i < count; i++) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const skip = nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const local = buffer.readUInt32LE(at + 42);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    at += 46 + skip;
  }
  return files;
}

const unescapeXml = (value) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()],
  );
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
const runs = (inner) => unescapeXml([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const columnIndex = (ref) => [...ref.replace(/\d+$/, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export function readXlsx(buffer) {
  const files = unzip(buffer);
  const part = (name) => files.get(name)?.toString('utf8') ?? '';
  const shared = [...part('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1]));
  const targets = new Map([...part('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target').replace(/^\/?(xl\/)?/, 'xl/')]));
  const out = {};
  for (const sheet of part('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const target = targets.get(attr(sheet[0], 'r:id'));
    if (!target) continue;
    const rows = [];
    for (const row of part(target).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells = [];
      for (const c of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attr(c[0], 't');
        const inner = c[2] ?? '';
        const raw = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
        const value = type === 's' ? (shared[Number(raw)] ?? '') : type === 'inlineStr' ? runs(inner) : type === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE') : raw;
        const ref = attr(c[0], 'r');
        const index = ref ? columnIndex(ref) : cells.length;
        while (cells.length < index) cells.push('');
        cells[index] = value;
      }
      // Rows with nothing in them (formatting only) aren't rows of data.
      if (cells.some((cell) => cell !== '')) rows.push(cells);
    }
    out[unescapeXml(attr(sheet[0], 'name'))] = rows;
  }
  return out;
}
