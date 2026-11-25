#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FEED_PATH = path.resolve(process.cwd(), 'release_feed.json');
const TMDB_KEY = process.env.TMDB_API_KEY || '8476a7ab80ad76f0936744df0430e67c';
const CINESRC_API = 'https://cinesrc.st/api/stream';
const CINESRC_KEY = '392948';
const EVENT_NAME = process.env.GITHUB_EVENT_NAME || '';

function isoOffsetDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function base64Url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function fetchJson(url, headers = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    const data = await res.json().catch(() => null);
    return { ok: true, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(t);
  }
}

async function getFcmAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const sig = base64Url(signer.sign(sa.private_key));
  const assertion = `${unsigned}.${sig}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`OAuth token HTTP ${res.status}`);
  }
  const tok = await res.json();
  return tok.access_token;
}

async function sendFcmTopicData(projectId, accessToken, topic, dataPayload, ttlSeconds = 86400) {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const stringData = {};
  for (const [k, v] of Object.entries(dataPayload)) {
    if (v !== undefined && v !== null) stringData[k] = String(v);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        topic,
        data: stringData,
        android: {
          priority: 'HIGH',
          ttl: `${ttlSeconds}s`,
        },
      },
    }),
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    throw new Error(`FCM HTTP ${res.status}: ${errTxt}`);
  }
  return res.json();
}

async function fetchCandidateMovies() {
  const minDate = isoOffsetDays(-45);
  const maxDate = isoOffsetDays(35);
  const endpoints = [
    `https://api.themoviedb.org/3/movie/upcoming?api_key=${TMDB_KEY}&language=id-ID&region=ID&page=1`,
    `https://api.themoviedb.org/3/movie/upcoming?api_key=${TMDB_KEY}&language=en-US&region=US&page=1`,
    `https://api.themoviedb.org/3/movie/now_playing?api_key=${TMDB_KEY}&language=id-ID&region=ID&page=1`,
    `https://api.themoviedb.org/3/movie/now_playing?api_key=${TMDB_KEY}&language=en-US&region=US&page=1`,
    `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&language=id-ID&sort_by=popularity.desc&primary_release_date.gte=${minDate}&primary_release_date.lte=${maxDate}&include_adult=false&page=1`,
    `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_KEY}&language=id-ID&sort_by=popularity.desc&primary_release_date.gte=${minDate}&primary_release_date.lte=${maxDate}&include_adult=false&page=2`,
  ];

  const map = new Map();
  const responses = await Promise.all(endpoints.map((u) => fetchJson(u, {}, 8000)));
  for (const r of responses) {
    const list = r.data?.results;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const id = Number(item?.id || 0);
      if (!id || !item?.poster_path) continue;
      const title = String(item.title || item.original_title || '').trim();
      if (!title) continue;
      const existing = map.get(id);
      if (!existing || (item.popularity || 0) > (existing.popularity || 0)) {
        map.set(id, {
          id,
          title,
          releaseDate: String(item.release_date || '').slice(0, 10),
          popularity: Number(item.popularity || 0),
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.popularity - a.popularity);
}

async function probeMovieStream(movieId) {
  const url = `${CINESRC_API}?apiKey=${CINESRC_KEY}&id=${movieId}&type=movie`;
  const r = await fetchJson(
    url,
    {
      Referer: 'https://cinesrc.st/',
      Origin: 'https://cinesrc.st',
      'User-Agent': 'NyenderReleaseMonitor/1.3',
    },
    7000
  );
  if (r.status === 0) {
    // Network timeout: jangan ubah status pending supaya tidak salah anggap
    return { status: 'transient_error', quality: null };
  }
  if (!r.ok || !r.data || !Array.isArray(r.data.url)) {
    return { status: 'unavailable', quality: null };
  }
  const camRe = /\b(cam|hdcam|camrip|telesync|hdts|ts)\b/i;
  let validCount = 0;
  let camCount = 0;
  for (const u of r.data.url) {
    const raw = String(u?.url || '').trim();
    if (!raw || raw.toLowerCase().includes('lightspeed.st')) continue;
    validCount++;
    const meta = `${u?.quality || ''} ${u?.label || ''} ${u?.name || ''} ${u?.source || ''}`;
    if (camRe.test(meta)) camCount++;
  }
  if (validCount === 0) {
    return { status: 'unavailable', quality: null };
  }
  return {
    status: 'available',
    quality: camCount === validCount ? 'cam' : 'unknown',
  };
}

/**
 * Cek tipe rilis resmi di TMDB (/movie/{id}/release_dates):
 * type 1/2/3 = Premiere / Bioskop saja -> kalau sudah ada stream, berarti rekaman bioskop (CAM/HDCAM/TS).
 * type 4/5/6 = Digital (WEB-DL) / Blu-ray / TV sudah rilis -> kualitas HD jernih.
 */
async function resolveReleaseQuality(movieId, releaseDate, streamHint) {
  if (streamHint === 'cam') return 'cam';
  const today = isoOffsetDays(0);
  if (releaseDate && releaseDate > today) {
    // Belum lewat tanggal rilis resmi sama sekali tapi sudah bocor stream -> pasti CAM / leak awal
    return 'cam';
  }
  const r = await fetchJson(
    `https://api.themoviedb.org/3/movie/${movieId}/release_dates?api_key=${TMDB_KEY}`,
    {},
    6500
  );
  if (!r.ok || !Array.isArray(r.data?.results)) {
    return 'hd';
  }
  let hasAnyPastRelease = false;
  let hasDigitalOrPhysical = false;
  for (const country of r.data.results) {
    for (const rel of country.release_dates || []) {
      const dt = String(rel?.release_date || '').slice(0, 10);
      if (!dt || dt > today) continue;
      hasAnyPastRelease = true;
      if (rel.type === 4 || rel.type === 5 || rel.type === 6) {
        hasDigitalOrPhysical = true;
        break;
      }
    }
    if (hasDigitalOrPhysical) break;
  }
  if (hasDigitalOrPhysical) return 'hd';
  if (hasAnyPastRelease) return 'cam';
  return 'cam';
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
  return results;
}

async function main() {
  const rawSa = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  const sa = rawSa ? JSON.parse(rawSa) : null;
  let accessToken = null;
  if (sa?.project_id && sa?.private_key) {
    accessToken = await getFcmAccessToken(sa);
  }

  // Jika dipicu oleh rilis APK baru di GitHub Releases, langsung dorong sinyal update ke semua HP
  if (EVENT_NAME === 'release' && sa && accessToken) {
    await sendFcmTopicData(sa.project_id, accessToken, 'nyender_app_updates', {
      kind: 'app_update',
      ts: Date.now(),
    });
    console.log('Sent FCM app_update push.');
    return;
  }

  let feed = {
    bootstrapped: false,
    updatedAt: 0,
    lastWakeupAt: 0,
    knownStreamableIds: [],
    pendingMovies: {},
    recentDrops: [],
  };

  if (fs.existsSync(FEED_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(FEED_PATH, 'utf8'));
      feed = { ...feed, ...parsed };
    } catch {}
  }

  const knownSet = new Set((feed.knownStreamableIds || []).map(Number).filter(Boolean));
  const pendingMap = { ...(feed.pendingMovies || {}) };
  const candidates = await fetchCandidateMovies();

  // Gabungkan film yang sebelumnya pending (belum ada stream) agar tetap dipantau sampai videonya masuk
  const byId = new Map();
  for (const c of candidates) {
    byId.set(c.id, c);
  }
  for (const [idStr, meta] of Object.entries(pendingMap)) {
    const id = Number(idStr);
    if (id && !knownSet.has(id) && !byId.has(id)) {
      byId.set(id, {
        id,
        title: meta.title || `Movie ${id}`,
        releaseDate: meta.releaseDate || '',
        popularity: meta.popularity || 0,
      });
    }
  }

  const toProbe = [...byId.values()].filter((m) => !knownSet.has(m.id)).slice(0, 95);
  console.log(`Candidates=${candidates.length}, probing=${toProbe.length}, bootstrapped=${feed.bootstrapped}`);

  const probeResults = await runPool(toProbe, 6, async (movie) => {
    const res = await probeMovieStream(movie.id);
    return { movie, ...res };
  });

  const now = Date.now();
  const recentCutoff = isoOffsetDays(-7);
  const newlyDropped = [];

  for (const item of probeResults) {
    const { movie, status, quality } = item;
    const idKey = String(movie.id);
    if (status === 'available') {
      const wasPending = Boolean(pendingMap[idKey]);
      delete pendingMap[idKey];
      knownSet.add(movie.id);

      if (feed.bootstrapped) {
        const isFreshReleaseOrUpcoming = Boolean(movie.releaseDate && movie.releaseDate >= recentCutoff);
        if (wasPending || isFreshReleaseOrUpcoming) {
          const detectedQuality = await resolveReleaseQuality(movie.id, movie.releaseDate, quality);
          newlyDropped.push({
            id: idKey,
            title: movie.title,
            releaseDate: movie.releaseDate,
            quality: detectedQuality,
            detectedAt: now,
          });
        }
      }
    } else if (status === 'unavailable') {
      pendingMap[idKey] = {
        title: movie.title,
        releaseDate: movie.releaseDate,
        popularity: movie.popularity,
        firstSeenAt: pendingMap[idKey]?.firstSeenAt || now,
      };
    }
  }

  // Batasi pendingMovies maks 120 judul terbaru agar tetap ringan
  const pendingEntries = Object.entries(pendingMap);
  if (pendingEntries.length > 120) {
    pendingEntries
      .sort((a, b) => (b[1]?.popularity || 0) - (a[1]?.popularity || 0))
      .slice(120)
      .forEach(([k]) => delete pendingMap[k]);
  }

  // Kirim push FCM untuk film yang baru saja tembus bisa diputar (maks 2 per jam supaya tidak beruntun)
  if (feed.bootstrapped && newlyDropped.length > 0) {
    feed.recentDrops = [...newlyDropped, ...(feed.recentDrops || [])].slice(0, 30);
    if (sa && accessToken) {
      for (const drop of newlyDropped.slice(0, 2)) {
        await sendFcmTopicData(sa.project_id, accessToken, 'nyender_releases', {
          kind: 'movie_drop',
          id: drop.id,
          mediaType: 'movie',
          title: drop.title,
          quality: drop.quality,
        });
        console.log(`Sent FCM movie_drop for: ${drop.title} (${drop.quality})`);
      }
    }
  }

  // Kirim sinyal wakeup tiap ~3 jam supaya HP yang menutup aplikasi tetap mengecek daftar personal "Ingatkan Saya"
  if (sa && accessToken && now - (feed.lastWakeupAt || 0) >= 2.8 * 3600 * 1000) {
    await sendFcmTopicData(
      sa.project_id,
      accessToken,
      'nyender_wakeup',
      { kind: 'wakeup', ts: now },
      14400
    );
    feed.lastWakeupAt = now;
    console.log('Sent periodic nyender_wakeup ping.');
  }

  feed.bootstrapped = true;
  feed.updatedAt = now;
  feed.knownStreamableIds = [...knownSet].slice(-600);
  feed.pendingMovies = pendingMap;

  fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2) + '\n', 'utf8');
  console.log(
    `Done. knownStreamable=${feed.knownStreamableIds.length}, pending=${Object.keys(pendingMap).length}, newDrops=${newlyDropped.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
