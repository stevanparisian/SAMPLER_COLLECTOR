import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '../../samples');

const DEFAULT_CATEGORIES = [
  'kick', 'snare', 'hihat', 'clap', 'perc',
  'bass', 'nappe', 'lead', 'vocal', 'fx', 'loop',
] as const;

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

fs.mkdirSync(SAMPLES_DIR, { recursive: true });
app.use('/samples', express.static(SAMPLES_DIR));

app.get('/api/health', (_req, res) => {
  let ffmpeg = false;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' }); ffmpeg = true; } catch {}
  res.json({ ok: true, ffmpeg, samplesDir: SAMPLES_DIR, categories: DEFAULT_CATEGORIES });
});

app.get('/api/library', (_req, res) => {
  const library: Record<string, { name: string; size: number; mtime: number; dur: number }[]> = {};
  for (const entry of fs.readdirSync(SAMPLES_DIR)) {
    const catPath = path.join(SAMPLES_DIR, entry);
    if (!fs.statSync(catPath).isDirectory()) continue;
    const files = fs.readdirSync(catPath)
      .filter(f => f.endsWith('.wav') && !f.startsWith('.'))
      .map(f => {
        const full = path.join(catPath, f);
        const st = fs.statSync(full);
        return { name: f, size: st.size, mtime: st.mtimeMs, dur: wavDurationSec(full) };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length) library[entry] = files;
  }
  res.json({ library, categories: DEFAULT_CATEGORIES });
});

app.post('/api/save', upload.single('audio'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'NO_FILE' });

    const category = safe(String(req.body.category || ''));
    const rawName = safe(String(req.body.name || ''));
    const start = Math.max(0, Number(req.body.start) || 0);
    const end = Number(req.body.end) || 0;

    if (!category) return res.status(400).json({ error: 'BAD_CATEGORY' });
    if (!rawName) return res.status(400).json({ error: 'BAD_NAME' });
    if (end <= start) return res.status(400).json({ error: 'BAD_RANGE' });

    // Optional overwrite of an existing file (used when updating from library)
    const overwriteCat = String(req.body.overwriteCat || '');
    const overwriteName = String(req.body.overwriteName || '');
    if (overwriteCat && overwriteName && safe(overwriteCat)
      && !overwriteName.includes('/') && !overwriteName.includes('\\')) {
      const oldPath = path.join(SAMPLES_DIR, overwriteCat, overwriteName);
      if (fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch {}
        try {
          const remaining = fs.readdirSync(path.join(SAMPLES_DIR, overwriteCat)).filter(f => !f.startsWith('.'));
          if (remaining.length === 0) fs.rmdirSync(path.join(SAMPLES_DIR, overwriteCat));
        } catch {}
      }
    }

    const categoryDir = path.join(SAMPLES_DIR, category);
    fs.mkdirSync(categoryDir, { recursive: true });

    const ts = Date.now();
    const tmpIn = path.join(categoryDir, `.tmp-${ts}`);
    fs.writeFileSync(tmpIn, req.file.buffer);

    const outPath = uniquePath(path.join(categoryDir, `${rawName}.wav`));
    try {
      execFileSync('ffmpeg', [
        '-y',
        '-i', tmpIn,
        '-ss', start.toFixed(3),
        '-t', (end - start).toFixed(3),
        '-ar', '44100',
        '-ac', '2',
        '-c:a', 'pcm_s16le',
        outPath,
        '-loglevel', 'error',
      ], { stdio: 'pipe' });
    } finally {
      if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
    }
    res.json({ ok: true, file: path.basename(outPath), category, path: outPath });
  } catch (e: any) {
    res.status(500).json({ error: 'SAVE_FAILED', message: e?.message || String(e) });
  }
});

app.patch('/api/sample', (req, res) => {
  const category = safe(String(req.body.category || ''));
  const oldName = String(req.body.name || '');
  const rawNew = safe(String(req.body.newName || '').replace(/\.wav$/i, ''));
  if (!category || !oldName || !rawNew) return res.status(400).json({ error: 'BAD_INPUT' });
  if (oldName.includes('/') || oldName.includes('\\')) return res.status(400).json({ error: 'BAD_INPUT' });
  const oldPath = path.join(SAMPLES_DIR, category, oldName);
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'NOT_FOUND' });
  const newPath = uniquePath(path.join(SAMPLES_DIR, category, `${rawNew}.wav`));
  fs.renameSync(oldPath, newPath);
  res.json({ ok: true, file: path.basename(newPath) });
});

app.delete('/api/sample', (req, res) => {
  const category = safe(String(req.body.category || ''));
  const name = String(req.body.name || '');
  if (!category || !name) return res.status(400).json({ error: 'BAD_INPUT' });
  if (name.includes('/') || name.includes('\\') || name.startsWith('.')) return res.status(400).json({ error: 'BAD_INPUT' });
  const p = path.join(SAMPLES_DIR, category, name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'NOT_FOUND' });
  fs.unlinkSync(p);
  try {
    const remaining = fs.readdirSync(path.join(SAMPLES_DIR, category)).filter(f => !f.startsWith('.'));
    if (remaining.length === 0) fs.rmdirSync(path.join(SAMPLES_DIR, category));
  } catch {}
  res.json({ ok: true });
});

function safe(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (t === '.' || t === '..') return null;
  if (!/^[\w\- .]+$/.test(t)) return null;
  if (t.startsWith('.')) return null;
  return t;
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  let i = 2;
  while (fs.existsSync(path.join(dir, `${name}-${i}${ext}`))) i++;
  return path.join(dir, `${name}-${i}${ext}`);
}

// Reads PCM WAV header to get duration without decoding the whole file.
// Assumes a standard 16-byte fmt chunk (which our ffmpeg output produces).
function wavDurationSec(filepath: string): number {
  try {
    const fd = fs.openSync(filepath, 'r');
    const buf = Buffer.alloc(44);
    fs.readSync(fd, buf, 0, 44, 0);
    fs.closeSync(fd);
    const byteRate = buf.readUInt32LE(28);
    const dataSize = buf.readUInt32LE(40);
    if (byteRate <= 0) return 0;
    return dataSize / byteRate;
  } catch { return 0; }
}

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n  ⚙️  COLLECTOR Backend on http://localhost:${PORT}`);
  console.log(`  📁 Samples: ${SAMPLES_DIR}`);
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' }); console.log('  ✅ ffmpeg found\n'); }
  catch { console.log('  ❌ ffmpeg not found — brew install ffmpeg\n'); }
});
