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

// A music bed lifts watch time, but WhatsApp and Instagram both autoplay muted,
// so the reel has to read without it. Drop a track at assets/reel-music.m4a (or
// point DEAL_VIDEO_MUSIC at one) and every reel picks it up; with no file the
// reel renders silent exactly as before.
// The beds rotate so a dealer's listings don't all sound like the same advert.
// Rotation is by car id rather than at random, so a given car keeps its track
// across re-renders — re-rendering a listing should not change how it sounds.
const TRACKS = ['morning-parcel', 'midnight-drive', 'velvet-torque', 'velvet-lock'];

function pickTrack(carId) {
  let h = 0;
  for (const ch of String(carId || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TRACKS[h % TRACKS.length];
}

/**
 * Resolve the bed for a listing.
 * opts.music / DEAL_VIDEO_MUSIC pin one track for everything (a bare name or a
 * path); otherwise the listing gets its own from the rotation. A file left at
 * assets/reel-music.m4a still overrides the lot, and no files at all means the
 * reel renders silent.
 */
function resolveMusic(explicit, carId) {
  const dir = path.join(__dirname, '..', 'assets', 'music');
  const named = v => {
    if (!v) return null;
    if (fs.existsSync(v)) return v;                       // a real path
    const byName = path.join(dir, `${v}.m4a`);            // or just "midnight-drive"
    return fs.existsSync(byName) ? byName : null;
  };
  const candidates = [
    named(explicit),
    named(process.env.DEAL_VIDEO_MUSIC),
    path.join(__dirname, '..', 'assets', 'reel-music.m4a'),
    path.join(__dirname, '..', 'assets', 'reel-music.mp3'),
    named(pickTrack(carId))
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return null;
}

const W = 1080, H = 1920, FPS = 30;
const MAX_PHOTOS = 6;
const SEG = 2.6;          // seconds each photo holds
const XF = 0.5;           // legacy crossfade width, kept for duration maths
const FADE = 0.3;         // dip in/out baked into each segment
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
  // The dip in and out is baked in here, on a single input, so the segments can
  // later be joined by stream copy. Doing it as an xfade across the finished
  // clips instead is what blew the 512MB container apart.
  const fade = `fade=t=in:st=0:d=${FADE},fade=t=out:st=${(SEG - FADE).toFixed(2)}:d=${FADE}`;
  return (
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
    `boxblur=24:1,eq=brightness=-0.10:saturation=0.85[bg];` +
    `[0:v]scale=${W}:-2:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[cmp];` +
    // zoompan emits d frames for EVERY input frame, so the photo is fed as a
    // single still (no -loop) — looping it here multiplies the clip length.
    `[cmp]zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `d=${frames}:s=${W}x${H}:fps=${FPS},setsar=1,${fade},scale=out_range=tv,format=yuv420p[vout]`
  );
}

function cardFilter() {
  return (
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
    `boxblur=32:1,eq=brightness=-0.22:saturation=0.7[cbg];` +
    `[0:v]scale=${W}:-2:flags=lanczos[cfg];` +
    `[cbg][cfg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${FPS},` +
    `fade=t=in:st=0:d=${FADE},scale=out_range=tv,format=yuv420p[vout]`
  );
}

// Join the pre-rendered segments by stream copy. Each already carries its own
// dip in and out, so nothing has to be re-encoded and no filter holds two
// decoded streams at once — that is what keeps this inside 512MB.
function concatDuration(n, hasCard) {
  return (hasCard ? (n - 1) * SEG + CARD : n * SEG);
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
        '-y', '-hide_banner', '-loglevel', 'error', '-threads', '1',
        '-i', photos[i],
        '-filter_complex', segmentFilter(i), '-map', '[vout]', '-an',
        // -threads 1 is the difference between fitting and not: libx264's
        // per-thread buffers take one 1080x1920 pass from 417MB to 217MB, and on
        // a half CPU there is no speed to lose anyway.
        '-threads', '1',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-r', String(FPS), seg
      ], 180000);
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
        '-y', '-hide_banner', '-loglevel', 'error', '-threads', '1',
        '-loop', '1', '-t', String(CARD), '-i', cardPath,
        '-filter_complex', cardFilter(), '-map', '[vout]', '-an',
        '-threads', '1',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-r', String(FPS), seg
      ], 180000);
      try { fs.unlinkSync(cardPath); } catch (e) {}
      if (r.ok && fs.existsSync(seg)) segs.push(seg);
    }
    const hasCard = segs.length > photos.length;

    // ---- final pass: join by stream copy ----
    // Each segment already dips in and out, so this only rewrites the container.
    const listFile = path.join(tmp, 'list.txt');
    fs.writeFileSync(listFile, segs.map(sg => `file '${sg.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const seconds = concatDuration(segs.length, hasCard);

    const args = ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile];
    const music = resolveMusic(opts.music, car.id);
    if (music) {
      // Levelled, and faded out over the closing card so it lands rather than cuts.
      const fadeStart = Math.max(0, seconds - 1.2).toFixed(2);
      // -stream_loop repeats a bed shorter than the reel, and -t alone bounds the
      // result. With -shortest a 10s track would have cut the VIDEO down to 10s.
      args.push('-stream_loop', '-1', '-i', music, '-map', '0:v', '-map', '1:a',
        '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=${fadeStart}:d=1.2`,
        '-t', String(seconds),
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k');
    } else {
      args.push('-an', '-c', 'copy');
    }
    args.push('-movflags', '+faststart', outPath);

    log('rendering', car.id, photos.length, 'photos, card:', hasCard);
    const r = await run(FFMPEG, args, 300000);
    if (!r.ok || !fs.existsSync(outPath)) {
      cleanup();
      return { ok: false, error: (r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ') || 'ffmpeg failed' };
    }
    const bytes = fs.statSync(outPath).size;
    log('done in', Math.round((Date.now() - t0) / 1000) + 's', Math.round(bytes / 1024) + 'KB');
    cleanup();
    return { ok: true, path: outPath, url: urlFor(car.id), seconds: Math.round(seconds * 10) / 10, bytes, photos: photos.length, card: hasCard, music: music ? path.basename(music, '.m4a') : null };
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
