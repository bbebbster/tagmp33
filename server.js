require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const multer = require('multer');
const sanitize = require('sanitize-filename');
const NodeID3 = require('node-id3');
const { parseFile } = require('music-metadata');

const app = express();
const PORT = process.env.PORT || 3000;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const MAX_UPLOAD_MB = Number.parseInt(process.env.MAX_UPLOAD_MB || '50', 10);
const SITE_USERNAME = process.env.SITE_USERNAME || 'admin';
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const CLEANUP_AFTER_HOURS = Number.parseInt(process.env.CLEANUP_AFTER_HOURS || '6', 10);

async function ensureDirs() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const id = crypto.randomUUID();
      const ext = path.extname(file.originalname || '').toLowerCase() || '.mp3';
      cb(null, `${id}${ext}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.mp3' && file.mimetype !== 'audio/mpeg') {
      cb(new Error('Please upload an MP3 file.'));
      return;
    }
    cb(null, true);
  }
});


function basicAuth(req, res, next) {
  if (!SITE_PASSWORD) return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    if (username === SITE_USERNAME && password === SITE_PASSWORD) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="MP3 Tagger"');
  res.status(401).send('Authentication required.');
}

async function cleanupDirectory(dir, maxAgeMs) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const fullPath = path.join(dir, entry.name);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (stat && now - stat.mtimeMs > maxAgeMs) {
      await fs.unlink(fullPath).catch(() => {});
    }
  }));
}

async function cleanupOldFiles() {
  const maxAgeMs = Math.max(1, CLEANUP_AFTER_HOURS) * 60 * 60 * 1000;
  await cleanupDirectory(UPLOAD_DIR, maxAgeMs);
  await cleanupDirectory(TMP_DIR, maxAgeMs);
}

app.use(express.json({ limit: '1mb' }));
app.use(basicAuth);
app.use(express.static(path.join(ROOT, 'public')));

function fileIdFromStoredName(filename) {
  return path.basename(filename, path.extname(filename));
}

function uploadPathFromFileId(fileId) {
  if (!/^[a-f0-9-]{36}$/i.test(fileId)) {
    throw new Error('Invalid file id. Upload the MP3 again.');
  }
  return path.join(UPLOAD_DIR, `${fileId}.mp3`);
}

function parseFilename(originalName = '') {
  const base = path.basename(originalName, path.extname(originalName));
  const cleaned = base
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const dashParts = cleaned.split(/\s+-\s+|\s+–\s+|\s+—\s+/);
  if (dashParts.length >= 2) {
    return {
      artist: dashParts[0].trim(),
      title: dashParts.slice(1).join(' - ').trim()
    };
  }

  return { artist: '', title: cleaned };
}

function firstText(value) {
  if (!value) return '';
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value).trim();
}

function yearFromDate(value) {
  if (!value) return '';
  const match = String(value).match(/(19|20)\d{2}/);
  return match ? match[0] : '';
}

function eraFromYear(yearValue) {
  const year = Number.parseInt(yearValue, 10);
  if (!Number.isFinite(year) || year < 1900) return '';
  if (year < 1950) return 'pre-50s';
  const decade = Math.floor(year / 10) * 10;
  if (decade >= 2000) return `${String(decade).slice(2)}s`;
  return `${String(decade).slice(2)}s`;
}

function normaliseTag(tag = '') {
  return String(tag)
    .toLowerCase()
    .replace(/[^a-z0-9&+\-/ ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulTag(tag = '') {
  const bad = new Set(['seen live', 'favorites', 'favourite', 'favorite', 'beautiful', 'awesome', 'love', 'spotify']);
  return tag && !bad.has(tag) && tag.length <= 32;
}

function imageFromLastFmImages(images = []) {
  if (!Array.isArray(images)) return '';
  const sizes = ['mega', 'extralarge', 'large', 'medium', 'small'];
  for (const size of sizes) {
    const hit = images.find((img) => img && img.size === size && img['#text']);
    if (hit) return hit['#text'];
  }
  const any = images.find((img) => img && img['#text']);
  return any ? any['#text'] : '';
}

function addCover(covers, url, label, source) {
  if (!url || typeof url !== 'string') return;
  if (!/^https?:\/\//i.test(url)) return;
  const clean = url.trim();
  if (!clean || covers.some((item) => item.url === clean)) return;
  covers.push({ url: clean, label, source });
}

function upgradeAppleArtwork(url) {
  if (!url) return '';
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/i, '/1200x1200bb.$1');
}

async function lastFm(method, params = {}) {
  if (!LASTFM_API_KEY) {
    const err = new Error('Missing LASTFM_API_KEY in .env');
    err.status = 400;
    throw err;
  }

  const query = new URLSearchParams({
    method,
    api_key: LASTFM_API_KEY,
    format: 'json',
    ...params
  });

  const response = await fetch(`https://ws.audioscrobbler.com/2.0/?${query.toString()}`);
  const json = await response.json().catch(() => ({}));

  if (!response.ok || json.error) {
    const err = new Error(json.message || `Last.fm request failed for ${method}`);
    err.status = response.status || 502;
    err.lastfm = json;
    throw err;
  }

  return json;
}

async function appleSearch(artist, title) {
  const query = new URLSearchParams({
    term: `${artist} ${title}`.trim(),
    media: 'music',
    entity: 'song',
    limit: '8'
  });

  const response = await fetch(`https://itunes.apple.com/search?${query.toString()}`);
  if (!response.ok) return [];
  const json = await response.json().catch(() => ({}));
  return Array.isArray(json.results) ? json.results : [];
}

function pickYear(...values) {
  for (const value of values) {
    const year = yearFromDate(value);
    if (year) return year;
  }
  return '';
}

function bestGenre(tags = [], appleGenre = '') {
  const genreish = tags.find((tag) => /rock|pop|rap|hip hop|r&b|soul|dance|house|garage|drum|bass|jazz|blues|metal|punk|folk|country|indie|electronic|alternative|reggae|grime|afro|latin|classical/i.test(tag));
  return firstText(genreish || appleGenre || tags[0] || '');
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasLastFmKey: Boolean(LASTFM_API_KEY), maxUploadMb: MAX_UPLOAD_MB });
});

app.post('/api/inspect', upload.single('mp3'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No MP3 uploaded.' });
      return;
    }

    // Multer preserves the original extension. Normalise to .mp3 for later file-id lookup.
    const fileId = fileIdFromStoredName(req.file.filename);
    const targetPath = uploadPathFromFileId(fileId);
    if (req.file.path !== targetPath) {
      await fs.rename(req.file.path, targetPath);
    }

    const parsed = await parseFile(targetPath, { duration: false }).catch(() => ({ common: {} }));
    const common = parsed.common || {};
    const fromName = parseFilename(req.file.originalname);

    const title = firstText(common.title) || fromName.title;
    const artist = firstText(common.artist || common.albumartist) || fromName.artist;
    const album = firstText(common.album);
    const year = firstText(common.year) || yearFromDate(common.date);
    const genre = firstText(common.genre);

    res.json({
      fileId,
      originalName: req.file.originalname,
      existing: {
        title,
        artist,
        album,
        year,
        era: eraFromYear(year),
        genre,
        trackNumber: common.track && common.track.no ? String(common.track.no) : '',
        hasEmbeddedCover: Array.isArray(common.picture) && common.picture.length > 0
      }
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/lookup', async (req, res, next) => {
  try {
    const title = firstText(req.body.title);
    const artist = firstText(req.body.artist);
    if (!title || !artist) {
      res.status(400).json({ error: 'Artist and title are needed for lookup.' });
      return;
    }

    const covers = [];
    let trackInfo = null;
    let albumInfo = null;
    let topAlbums = [];
    let topTags = [];
    let appleResults = [];
    const warnings = [];

    try {
      const trackJson = await lastFm('track.getInfo', { artist, track: title, autocorrect: '1' });
      trackInfo = trackJson.track || null;
    } catch (err) {
      warnings.push(`Last.fm track lookup: ${err.message}`);
    }

    const resolvedArtist = firstText(trackInfo?.artist?.name || trackInfo?.artist?.['#text'] || artist);
    const resolvedTitle = firstText(trackInfo?.name || title);
    const resolvedAlbum = firstText(trackInfo?.album?.title || req.body.album);

    addCover(
      covers,
      imageFromLastFmImages(trackInfo?.album?.image),
      resolvedAlbum || `${resolvedArtist} — ${resolvedTitle}`,
      'Last.fm track'
    );

    try {
      const tagsJson = await lastFm('track.getTopTags', { artist: resolvedArtist, track: resolvedTitle, autocorrect: '1' });
      const raw = tagsJson.toptags?.tag;
      topTags = (Array.isArray(raw) ? raw : raw ? [raw] : [])
        .map((tag) => normaliseTag(tag.name))
        .filter(isUsefulTag)
        .slice(0, 8);
    } catch (err) {
      warnings.push(`Last.fm tag lookup: ${err.message}`);
    }

    if (resolvedAlbum) {
      try {
        const albumJson = await lastFm('album.getInfo', { artist: resolvedArtist, album: resolvedAlbum, autocorrect: '1' });
        albumInfo = albumJson.album || null;
        addCover(covers, imageFromLastFmImages(albumInfo?.image), albumInfo?.name || resolvedAlbum, 'Last.fm album');
      } catch (err) {
        warnings.push(`Last.fm album lookup: ${err.message}`);
      }
    }

    try {
      const albumsJson = await lastFm('artist.getTopAlbums', { artist: resolvedArtist, autocorrect: '1', limit: '12' });
      const rawAlbums = albumsJson.topalbums?.album;
      topAlbums = Array.isArray(rawAlbums) ? rawAlbums : rawAlbums ? [rawAlbums] : [];
      for (const album of topAlbums) {
        addCover(covers, imageFromLastFmImages(album.image), album.name || 'Artist album', 'Last.fm top album');
      }
    } catch (err) {
      warnings.push(`Last.fm top albums: ${err.message}`);
    }

    try {
      appleResults = await appleSearch(resolvedArtist, resolvedTitle);
      for (const result of appleResults) {
        addCover(
          covers,
          upgradeAppleArtwork(result.artworkUrl100),
          result.collectionName || result.trackName || 'Apple artwork',
          'Apple fallback'
        );
      }
    } catch (err) {
      warnings.push(`Apple fallback search: ${err.message}`);
    }

    const bestApple = appleResults.find((item) => {
      const artistOk = String(item.artistName || '').toLowerCase().includes(resolvedArtist.toLowerCase().slice(0, 8));
      const titleOk = String(item.trackName || '').toLowerCase().includes(resolvedTitle.toLowerCase().slice(0, 8));
      return artistOk || titleOk;
    }) || appleResults[0] || {};

    const year = pickYear(
      req.body.year,
      trackInfo?.wiki?.published,
      albumInfo?.wiki?.published,
      bestApple.releaseDate
    );

    const genre = bestGenre(topTags, bestApple.primaryGenreName);

    res.json({
      metadata: {
        title: resolvedTitle,
        artist: resolvedArtist,
        album: firstText(albumInfo?.name || resolvedAlbum || bestApple.collectionName),
        year,
        era: eraFromYear(year),
        genre,
        tags: topTags,
        lastfmUrl: trackInfo?.url || '',
        listeners: trackInfo?.listeners || '',
        playcount: trackInfo?.playcount || ''
      },
      covers: covers.slice(0, 18),
      warnings
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/tag', async (req, res, next) => {
  let outputPath = '';
  try {
    const fileId = firstText(req.body.fileId);
    const inputPath = uploadPathFromFileId(fileId);
    await fs.access(inputPath);

    const title = firstText(req.body.title);
    const artist = firstText(req.body.artist);
    if (!title || !artist) {
      res.status(400).json({ error: 'Title and artist are required before tagging.' });
      return;
    }

    const album = firstText(req.body.album);
    const year = firstText(req.body.year);
    const era = firstText(req.body.era) || eraFromYear(year);
    const genre = firstText(req.body.genre);
    const trackNumber = firstText(req.body.trackNumber);
    const coverUrl = firstText(req.body.coverUrl);

    const outNameBase = sanitize(`${artist} - ${title}`) || 'tagged-track';
    outputPath = path.join(TMP_DIR, `${crypto.randomUUID()}-${outNameBase}.mp3`);
    await fs.copyFile(inputPath, outputPath);

    const tags = {
      title,
      artist,
      album,
      year,
      genre,
      trackNumber,
      comment: {
        language: 'eng',
        text: era ? `Era: ${era}` : ''
      },
      userDefinedText: era ? [{ description: 'Era', value: era }] : undefined
    };

    Object.keys(tags).forEach((key) => {
      if (tags[key] === undefined || tags[key] === '') delete tags[key];
    });

    if (coverUrl) {
      const coverResponse = await fetch(coverUrl);
      if (coverResponse.ok) {
        const mime = coverResponse.headers.get('content-type') || 'image/jpeg';
        const arrayBuffer = await coverResponse.arrayBuffer();
        tags.image = {
          mime,
          type: { id: 3, name: 'front cover' },
          description: 'Cover',
          imageBuffer: Buffer.from(arrayBuffer)
        };
      }
    }

    const ok = NodeID3.write(tags, outputPath);
    if (!ok) {
      throw new Error('Could not write ID3 tags to this MP3.');
    }

    res.download(outputPath, `${outNameBase}.mp3`, async () => {
      if (outputPath) await fs.unlink(outputPath).catch(() => {});
    });
  } catch (err) {
    if (outputPath) await fs.unlink(outputPath).catch(() => {});
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

ensureDirs().then(async () => {
  await cleanupOldFiles();
  setInterval(cleanupOldFiles, 60 * 60 * 1000).unref();

  app.listen(PORT, () => {
    console.log(`MP3 Last.fm Tagger running at http://localhost:${PORT}`);
    console.log(`Using data directory: ${DATA_DIR}`);
    if (SITE_PASSWORD) console.log(`Basic auth enabled for user: ${SITE_USERNAME}`);
  });
});
