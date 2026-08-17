// ==================================================
// DEAL VIDEO — auto 9:16 reel from a listing's photos + its VehYra deal card
// ==================================================
// Works for new and pre-owned listings alike. Every word on screen arrives as a
// pre-rendered PNG (the deal card from next/og): this box's ffmpeg is built
// without libfreetype, so drawtext does not exist and text must be an overlay.
//
//   const dealVideo = require('./lib/dealVideo.cjs');
//   dealVideo.init({ MEDIA_ROOT, SITE_URL, DEBUG });
//   await dealVideo.build(car);            // -> { ok, path, url, seconds }
//
// Output lands next to the photos as reel.mp4, so the existing /media_store
// static mount and the site's media proxy serve it with no new plumbing.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

let _config = {};
function init(config) { _config = config || {}; }

// Render's Node runtime has no ffmpeg on PATH (the Docker image installs it via
// apk). Fall back to the npm-shipped static binary so the reel still renders
// there; FFMPEG_PATH overrides both.
function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const stat = require('ffmpeg-static');
    if (stat && fs.existsSync(stat)) return stat;
  } catch (e) { /* not installed — fall through to PATH */ }
  return 'ffmpeg';
}
const FFMPEG = resolveFfmpeg();

// OFF unless explicitly enabled. Rendering six 1080x1920 inputs in one graph
// exhausted the container on Render and took the whole bot down with it — and
// because photo upload triggers a build, that was reachable without anyone
// asking for a video. Enable per-environment only where the box can take it.
const ENABLED = process.env.DEAL_VIDEO_ENABLED === '1';

// One render at a time, whatever else asks. Two concurrent ffmpeg passes were
// enough to push the container over on their own.
let rendering = false;

const W = 1080, H = 1920, FPS = 30;
const MAX_PHOTOS = 6;
const SEG = 2.6;          // seconds each photo holds
const XF = 0.5;           // crossfade
const CARD = 3.6;         // end card hold

const log = (...a) => { if (_config.DEBUG) console.log('[dealVideo]', ...a); };

function run(bin, args, timeoutMs = 240000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

async function haveFfmpeg() {
  const r = await run(FFMPEG, ['-version'], 15000);
  return r.ok;
}

// ---- photo selection -------------------------------------------------------
// Cover first (the AI-picked hero), then the rest in order. Keeps the strongest
// frame at the front, which is the one that survives a 2-second watch.
function pickPhotos(car, mediaRoot) {
  const dir = path.join(mediaRoot, car.id);
  if (!fs.existsSync(dir)) return [];
  const onDisk = new Set(fs.readdirSync(dir).filter(f => /\.(jpe?g|png|webp)$/i.test(f)));
  const ordered = [];
  const listed = Array.isArray(car.photos) ? car.photos.slice() : [];
  listed.sort((a, b) => (b.cover ? 1 : 0) - (a.cover ? 1 : 0));
  for (const p of listed) {
    if (p && p.file && onDisk.has(p.file)) { ordered.push(p.file); onDisk.delete(p.file); }
  }
  for (const f of onDisk) ordered.push(f);
  return ordered.slice(0, MAX_PHOTOS).map(f => path.join(dir, f));
}

// ---- the filter graph ------------------------------------------------------
// Per photo: a blurred cover-fill backdrop (no letterbox pillars) with the photo
// centred on top, then a slow Ken Burns push. The composite is built at 2x and
// scaled down so zoompan's integer stepping stops showing as jitter.
// One photo, one pass. Compositing at 1080x1920 rather than a 2x intermediate
// cuts the frame buffer roughly fourfold, and rendering segments one at a time
// keeps peak memory at a single clip instead of the whole reel.
function segmentFilter(index) {
  const frames = Math.round(SEG * FPS);
  const z = index % 2 === 0
    ? `min(1.0009^on,1.14)`                          // slow push in
    : `if(lte(on,1),1.14,max(1.14/1.0009^on,1.0))`;  // and back out
  return (
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
    `boxblur=24:1,eq=brightness=-0.10:saturation=0.85[bg];` +
    `[0:v]scale=${W}:-2:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[cmp];` +
    // zoompan emits d frames for EVERY input frame, so the photo is fed as a
    // single still (no -loop) — looping it here multiplies the clip length.
    `[cmp]zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `d=${frames}:s=${W}x${H}:fps=${FPS},setsar=1,scale=out_range=tv,format=yuv420p[vout]`
  );
}

function cardFilter() {
  return (
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
    `boxblur=32:1,eq=brightness=-0.22:saturation=0.7[cbg];` +
    `[0:v]scale=${W}:-2:flags=lanczos[cfg];` +
    `[cbg][cfg]overlay=(W-w)/2:(H-h)/2,setsar=1,scale=out_range=tv,format=yuv420p,fps=${FPS}[vout]`
  );
}

// Stitch the pre-rendered segments. Decoding short mp4s is far cheaper than
// rebuilding every Ken Burns graph in one pass.
function concatFilter(n, hasCard) {
  const parts = [];
  let cur = '0:v', offset = SEG - XF;
  for (let i = 1; i < n; i++) {
    const out = i === n - 1 ? 'vout' : `x${i}`;
    const dur = (i === n - 1 && hasCard) ? CARD : SEG;
    parts.push(`[${cur}][${i}:v]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(3)}[${out}]`);
    cur = out;
    offset += dur - XF;
  }
  if (n === 1) parts.push(`[0:v]null[vout]`);
  return { filter: parts.join(';'), seconds: offset + XF };
}

// ---- deal card -------------------------------------------------------------
async function fetchCard(car) {
  const site = (typeof _config.SITE_URL === 'function' ? _config.SITE_URL() : _config.SITE_URL) || '';
  if (!site) return null;
  const url = `${String(site).replace(/\/+$/, '')}/api/vehyra/card/${car.id}`;
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) { log('card fetch failed', r.status); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000) return null;
    const tmp = path.join(os.tmpdir(), `vehyra-card-${car.id}-${process.pid}.png`);
    fs.writeFileSync(tmp, buf);
    return tmp;
  } catch (e) { log('card fetch error', e.message); return null; }
}

// ---- main ------------------------------------------------------------------
/**
 * Build (or rebuild) the shareable reel for a listing.
 * opts.force  — rebuild even if reel.mp4 is newer than the photos
 * opts.music  — path to an audio bed; muted-autoplay-safe to omit
 */
async function build(car, opts = {}) {
  if (!ENABLED) return { ok: false, error: 'deal video disabled (set DEAL_VIDEO_ENABLED=1)' };
  if (!car || !car.id) return { ok: false, error: 'no car' };
  const mediaRoot = _config.MEDIA_ROOT;
  if (!mediaRoot) return { ok: false, error: 'MEDIA_ROOT not configured' };
  if (rendering) return { ok: false, error: 'another reel is rendering — try again shortly' };
  if (!(await haveFfmpeg())) return { ok: false, error: 'ffmpeg not installed' };

  const photos = pickPhotos(car, mediaRoot);
  if (!photos.length) return { ok: false, error: 'no photos on disk' };

  const outPath = path.join(mediaRoot, car.id, 'reel.mp4');
  if (!opts.force && fs.existsSync(outPath)) {
    const outAge = fs.statSync(outPath).mtimeMs;
    const newest = Math.max(...photos.map(p => fs.statSync(p).mtimeMs));
    if (outAge > newest) return { ok: true, path: outPath, url: urlFor(car.id), cached: true };
  }

  rendering = true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `reel-${car.id}-`));
  const cleanup = () => {
    rendering = false;
    try { for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f)); fs.rmdirSync(tmp); } catch (e) {}
  };

  try {
    const cardPath = opts.skipCard ? null : await fetchCard(car);
    const segs = [];
    const t0 = Date.now();

    // ---- pass 1..N: one segment per photo, sequentially ----
    for (let i = 0; i < photos.length; i++) {
      const seg = path.join(tmp, `s${i}.mp4`);
      const r = await run(FFMPEG, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', photos[i],
        '-filter_complex', segmentFilter(i), '-map', '[vout]', '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-r', String(FPS), seg
      ], 120000);
      if (!r.ok || !fs.existsSync(seg)) {
        cleanup();
        return { ok: false, error: `segment ${i} failed: ` + (r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' | ') };
      }
      segs.push(seg);
    }

    // ---- the closing card, same treatment ----
    if (cardPath) {
      const seg = path.join(tmp, `card.mp4`);
      const r = await run(FFMPEG, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-loop', '1', '-t', String(CARD), '-i', cardPath,
        '-filter_complex', cardFilter(), '-map', '[vout]', '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-r', String(FPS), seg
      ], 120000);
      try { fs.unlinkSync(cardPath); } catch (e) {}
      if (r.ok && fs.existsSync(seg)) segs.push(seg);
    }
    const hasCard = segs.length > photos.length;

    // ---- final pass: crossfade the segments together ----
    const { filter, seconds } = concatFilter(segs.length, hasCard);
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    for (const s of segs) args.push('-i', s);
    if (opts.music && fs.existsSync(opts.music)) args.push('-i', opts.music);
    args.push('-filter_complex', filter, '-map', '[vout]');
    if (opts.music && fs.existsSync(opts.music)) {
      args.push('-map', `${segs.length}:a`, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-shortest', '-c:a', 'aac', '-b:a', '128k');
    } else {
      args.push('-an');
    }
    args.push(
      // capped so the file always clears WhatsApp's ~16MB ceiling on a slow phone
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '22',
      '-maxrate', '4M', '-bufsize', '8M', '-profile:v', 'high', '-level', '4.0',
      '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-movflags', '+faststart', outPath
    );

    log('rendering', car.id, photos.length, 'photos, card:', hasCard);
    const r = await run(FFMPEG, args, 300000);
    if (!r.ok || !fs.existsSync(outPath)) {
      cleanup();
      return { ok: false, error: (r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ') || 'ffmpeg failed' };
    }
    const bytes = fs.statSync(outPath).size;
    log('done in', Math.round((Date.now() - t0) / 1000) + 's', Math.round(bytes / 1024) + 'KB');
    cleanup();
    return { ok: true, path: outPath, url: urlFor(car.id), seconds: Math.round(seconds * 10) / 10, bytes, photos: photos.length, card: hasCard };
  } catch (e) {
    cleanup();
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function urlFor(carId) { return `/media_store/inventory/${carId}/reel.mp4`; }

function existsFor(carId) {
  if (!_config.MEDIA_ROOT) return false;
  return fs.existsSync(path.join(_config.MEDIA_ROOT, carId, 'reel.mp4'));
}

module.exports = { init, build, existsFor, urlFor, pickPhotos, enabled: () => ENABLED };
