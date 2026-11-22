import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ManagementError } from './managementErrors.js';

// Read bounded ISO-BMFF boxes; never execute a converter on the shared host.
export function inspectVideo(buffer) {
  const invalid = () => {
    throw new ManagementError(
      'Choose a valid MP4 video (H.264), up to 60 seconds and 30 MB.',
    );
  };
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 32 ||
    buffer.length > 30 * 1024 * 1024
  )
    invalid();
  let visited = 0;
  function boxes(start, end) {
    const items = [];
    for (let offset = start; offset < end;) {
      if (++visited > 20000 || end - offset < 8) invalid();
      let size = buffer.readUInt32BE(offset),
        header = 8;
      if (size === 1) {
        if (end - offset < 16) invalid();
        const n = buffer.readBigUInt64BE(offset + 8);
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
        size = Number(n);
        header = 16;
      }
      if (size === 0) size = end - offset;
      if (size < header || offset + size > end) invalid();
      items.push({
        type: buffer.toString('latin1', offset + 4, offset + 8),
        offset,
        start: offset + header,
        end: offset + size,
      });
      offset += size;
    }
    return items;
  }
  const top = boxes(0, buffer.length),
    ftyp = top.find((b) => b.type === 'ftyp'),
    moov = top.find((b) => b.type === 'moov');
  if (
    !ftyp ||
    ftyp.end - ftyp.start < 8 ||
    !moov ||
    !top.some((b) => b.type === 'mdat')
  )
    invalid();
  const brand = buffer.toString('ascii', ftyp.start, ftyp.start + 4);
  if (!/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)$/.test(brand)) invalid();
  const metadata = [];
  const children = (b) => boxes(b.start, b.end);
  const movie = children(moov),
    mvhd = movie.find((b) => b.type === 'mvhd');
  if (!mvhd || mvhd.end - mvhd.start < 20) invalid();
  const version = buffer[mvhd.start];
  if (version !== 0 && version !== 1) invalid();
  if (version === 1 && mvhd.end - mvhd.start < 32) invalid();
  const timescale = buffer.readUInt32BE(mvhd.start + (version === 1 ? 20 : 12));
  const duration =
    version === 1
      ? Number(buffer.readBigUInt64BE(mvhd.start + 24))
      : buffer.readUInt32BE(mvhd.start + 16);
  const durationSec = duration / timescale;
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 60)
    invalid();
  let video;
  for (const track of movie.filter((b) => b.type === 'trak')) {
    const mdia = children(track).find((b) => b.type === 'mdia');
    if (!mdia) invalid();
    const parts = children(mdia),
      hdlr = parts.find((b) => b.type === 'hdlr');
    if (!hdlr || hdlr.end - hdlr.start < 12) invalid();
    if (buffer.toString('ascii', hdlr.start + 8, hdlr.start + 12) !== 'vide')
      continue;
    if (video) invalid();
    const minf = parts.find((b) => b.type === 'minf');
    if (!minf) invalid();
    const stbl = children(minf).find((b) => b.type === 'stbl');
    if (!stbl) invalid();
    const stsd = children(stbl).find((b) => b.type === 'stsd');
    if (!stsd || stsd.end - stsd.start < 8) invalid();
    const entries = boxes(stsd.start + 8, stsd.end);
    if (entries.length !== 1 || !['avc1', 'avc3'].includes(entries[0].type))
      invalid();
    const entry = entries[0];
    if (entry.end - entry.start < 78) invalid();
    const avc = boxes(entry.start + 78, entry.end).find(
      (b) => b.type === 'avcC',
    );
    if (!avc || avc.end - avc.start < 7 || buffer[avc.start] !== 1) invalid();
    const width = buffer.readUInt16BE(entry.start + 24),
      height = buffer.readUInt16BE(entry.start + 26);
    if (!width || !height || width > 1920 || height > 1920)
      throw new ManagementError(
        'Use a video up to 1080p (1920 pixels on its longest side).',
      );
    video = { width, height, durationSec };
  }
  if (!video) invalid();
  // Discard descriptive/location metadata while preserving byte offsets.
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  function collect(items) {
    for (const b of items) {
      if (['udta', 'meta', 'uuid'].includes(b.type))
        metadata.push({ typeOffset: b.offset + 4, start: b.start, end: b.end });
      else if (containers.has(b.type)) collect(children(b));
    }
  }
  collect(top);
  return { ...video, metadata };
}

export async function prepareCatalogVideo(buffer, uploadDir) {
  const info = inspectVideo(buffer),
    clean = Buffer.from(buffer);
  for (const box of info.metadata) {
    clean.write('free', box.typeOffset, 4, 'ascii');
    clean.fill(0, box.start, box.end);
  }
  const directory = join(uploadDir, 'videos'),
    name = randomUUID() + '.mp4',
    file = join(directory, name);
  await mkdir(directory, { recursive: true });
  await writeFile(file, clean, { flag: 'wx' });
  return {
    src: '/media/videos/' + name,
    width: info.width,
    height: info.height,
    durationSec: info.durationSec,
    cleanup: () => unlink(file).catch(() => {}),
  };
}
