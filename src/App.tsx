import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './index.css';

const DEFAULT_FOLDERS = [
  'kick', 'snare', 'hihat', 'clap', 'perc',
  'bass', 'nappe', 'lead', 'vocal', 'fx', 'loop',
];

type Phase = 'idle' | 'rec' | 'edit';
type LibRaw = Record<string, { name: string; size: number; mtime: number; dur: number }[]>;
type LibItem = { id: string; cat: string; name: string; file: string; dur: number; mtime: number };

export default function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);

  const [blob, setBlob] = useState<Blob | null>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [category, setCategory] = useState<string>('kick');
  const [name, setName] = useState('');
  const [editingRef, setEditingRef] = useState<{ cat: string; file: string } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [looping, setLooping] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);

  const [ffmpegOk, setFfmpegOk] = useState<boolean | null>(null);
  const [libraryRaw, setLibraryRaw] = useState<LibRaw>({});
  const [folders, setFolders] = useState<string[]>(DEFAULT_FOLDERS);

  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recCtxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const playSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const playStartedAtRef = useRef<number>(0);

  const duration = buffer?.duration ?? 0;
  const startFrac = duration > 0 ? start / duration : 0;
  const endFrac = duration > 0 ? end / duration : 1;
  const playheadFrac = duration > 0 && playhead != null ? playhead / duration : null;

  const refreshLibrary = useCallback(async () => {
    try {
      const r = await fetch('/api/library');
      const j = await r.json();
      const lib: LibRaw = j.library || {};
      setLibraryRaw(lib);
      setFolders(prev => {
        const set = new Set<string>(prev);
        Object.keys(lib).forEach(c => set.add(c));
        return Array.from(set);
      });
    } catch {}
  }, []);

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(d => setFfmpegOk(!!d.ffmpeg)).catch(() => setFfmpegOk(false));
    refreshLibrary();
  }, [refreshLibrary]);

  const stopPlayback = useCallback(() => {
    try { playSrcRef.current?.stop(); } catch {}
    playSrcRef.current = null;
    setPlaying(false);
    setPlayhead(null);
  }, []);

  const playWith = useCallback((shouldLoop: boolean) => {
    if (!buffer) return;
    try { playSrcRef.current?.stop(); } catch {}
    playSrcRef.current = null;
    if (!playCtxRef.current || playCtxRef.current.state === 'closed') {
      playCtxRef.current = new AudioContext();
    }
    const ctx = playCtxRef.current;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const s = Math.max(0, start);
    const len = Math.max(0.01, end - start);
    src.onended = () => {
      if (playSrcRef.current === src) {
        playSrcRef.current = null;
        setPlaying(false);
        setPlayhead(null);
      }
    };
    if (shouldLoop) {
      src.loop = true;
      src.loopStart = s;
      src.loopEnd = end;
      src.start(0, s);
    } else {
      src.start(0, s, len);
    }
    playSrcRef.current = src;
    playStartedAtRef.current = ctx.currentTime;
    setPlaying(true);
  }, [buffer, start, end]);

  const playSelection = useCallback(() => playWith(looping), [playWith, looping]);

  useEffect(() => {
    if (!playing || !buffer) return;
    let raf = 0;
    const ctx = playCtxRef.current;
    if (!ctx) return;
    const tick = () => {
      const elapsedSec = ctx.currentTime - playStartedAtRef.current;
      const span = Math.max(0.001, end - start);
      let p: number;
      if (looping) p = start + (elapsedSec % span);
      else { p = start + elapsedSec; if (p >= end) p = end; }
      setPlayhead(p);
      if (!looping && elapsedSec >= span) return;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, looping, buffer, start, end]);

  useEffect(() => {
    if (phase !== 'edit') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      e.preventDefault();
      if (playing) stopPlayback(); else playSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, playing, playSelection, stopPlayback]);

  useEffect(() => {
    if (phase !== 'rec') return;
    const t0 = performance.now();
    timerRef.current = window.setInterval(() => setElapsed((performance.now() - t0) / 1000), 100);
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [phase]);

  useEffect(() => () => {
    try { recRef.current?.stop(); } catch {}
    streamRef.current?.getTracks().forEach(t => t.stop());
    recCtxRef.current?.close().catch(() => {});
    playCtxRef.current?.close().catch(() => {});
  }, []);

  // ── Actions ────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints,
      });
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach(t => t.stop());
        setAlertMsg('No audio track.\nPick a tab and tick "Share tab audio".');
        return;
      }
      streamRef.current = stream;
      const audioStream = new MediaStream(stream.getAudioTracks());
      const rec = new MediaRecorder(audioStream, { mimeType: 'audio/webm;codecs=opus' });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        const b = new Blob(chunksRef.current, { type: 'audio/webm' });
        setBlob(b);
        const ac = new AudioContext();
        const buf = await ac.decodeAudioData(await b.arrayBuffer());
        ac.close();
        setBuffer(buf);
        setStart(0); setEnd(buf.duration);
        setEditingRef(null); setName('');
        setPhase('edit');
        setPlaying(false); setPlayhead(null);
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        recCtxRef.current?.close().catch(() => {});
        recCtxRef.current = null;
        setAnalyser(null);
      };
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (rec.state === 'recording') rec.stop();
      });

      const ac = new AudioContext();
      const src = ac.createMediaStreamSource(audioStream);
      const an = ac.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      recCtxRef.current = ac;
      setAnalyser(an);

      rec.start();
      recRef.current = rec;
      setElapsed(0);
      setPhase('rec');
    } catch (e: any) {
      setAlertMsg(e?.message || 'Capture refusée');
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    recRef.current?.stop();
  }, []);

  const goIdle = useCallback(() => {
    stopPlayback();
    setBlob(null); setBuffer(null);
    setStart(0); setEnd(0);
    setName(''); setEditingRef(null);
    setElapsed(0);
    setPhase('idle');
  }, [stopPlayback]);

  const loadFromLibrary = useCallback(async (item: LibItem) => {
    try {
      stopPlayback();
      const url = `/samples/${encodeURIComponent(item.cat)}/${encodeURIComponent(item.file)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('File not found');
      const b = await r.blob();
      const ac = new AudioContext();
      const buf = await ac.decodeAudioData(await b.arrayBuffer());
      ac.close();
      setBlob(b); setBuffer(buf);
      setStart(0); setEnd(buf.duration);
      setCategory(item.cat); setName(item.name);
      setEditingRef({ cat: item.cat, file: item.file });
      setPhase('edit');
      setPlaying(false); setPlayhead(null);
    } catch (e: any) {
      setAlertMsg(e?.message || 'Could not load.');
    }
  }, [stopPlayback]);

  const cleanName = (s: string) =>
    s.trim().replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_');

  const save = useCallback(async () => {
    if (!blob) return;
    const finalName = cleanName(name) || `${category}_${String(Date.now()).slice(-4)}`;
    if (end - start < 0.01) { setAlertMsg('Empty selection.'); return; }
    const fd = new FormData();
    fd.append('audio', blob, 'rec.webm');
    fd.append('category', category);
    fd.append('name', finalName);
    fd.append('start', String(start));
    fd.append('end', String(end));
    if (editingRef) {
      fd.append('overwriteCat', editingRef.cat);
      fd.append('overwriteName', editingRef.file);
    }
    try {
      const r = await fetch('/api/save', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || 'Failed');
      const file = (j.file as string).replace(/\.wav$/, '');
      setAlertMsg(`${editingRef ? 'Updated' : 'Saved'}:\nsamples/${category}/${file}.wav`);
      stopPlayback();
      const savedFile = file + '.wav';
      const url = `/samples/${encodeURIComponent(category)}/${encodeURIComponent(savedFile)}?t=${Date.now()}`;
      try {
        const res = await fetch(url);
        if (res.ok) {
          const newBlob = await res.blob();
          const ac = new AudioContext();
          const newBuf = await ac.decodeAudioData(await newBlob.arrayBuffer());
          ac.close();
          setBlob(newBlob);
          setBuffer(newBuf);
          setStart(0);
          setEnd(newBuf.duration);
        }
      } catch {}
      setEditingRef({ cat: category, file: savedFile });
      refreshLibrary();
    } catch (e: any) {
      setAlertMsg(e?.message || 'Error');
    }
  }, [blob, name, category, start, end, editingRef, refreshLibrary, stopPlayback]);

  const addFolder = useCallback((raw: string) => {
    const f = cleanName(raw);
    if (!f || folders.includes(f)) return;
    setFolders(prev => [...prev, f]);
    setCategory(f);
  }, [folders]);

  const deleteFolder = useCallback(async (f: string) => {
    const items = libraryRaw[f] || [];
    for (const it of items) {
      try {
        await fetch('/api/sample', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: f, name: it.name }),
        });
      } catch {}
    }
    setFolders(prev => prev.filter(x => x !== f));
    if (category === f) setCategory(folders.find(x => x !== f) || 'kick');
    refreshLibrary();
  }, [libraryRaw, folders, category, refreshLibrary]);

  const libraryItems: LibItem[] = useMemo(() => {
    const out: LibItem[] = [];
    for (const [cat, list] of Object.entries(libraryRaw)) {
      for (const it of list) {
        out.push({
          id: `${cat}/${it.name}`,
          cat,
          file: it.name,
          name: it.name.replace(/\.wav$/, ''),
          dur: it.dur,
          mtime: it.mtime,
        });
      }
    }
    return out;
  }, [libraryRaw]);

  const titleForMain =
    phase === 'idle' ? 'COLLECTOR.APP' :
    phase === 'rec' ? '● RECORDING…' :
    editingRef ? `EDIT — ${name}.wav` : 'UNTITLED.WAV';

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <MenuBar count={libraryItems.length} ffmpegOk={ffmpegOk} />

      <div style={{
        flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden',
      }}>
        <Library
          items={libraryItems}
          folders={folders}
          setFolders={setFolders}
          onDeleteFolder={deleteFolder}
          currentId={editingRef ? `${editingRef.cat}/${editingRef.file}` : null}
          onOpen={loadFromLibrary}
          onNewRec={goIdle}
          style={{
            position: 'absolute',
            top: 72, left: 98,
            width: 460, height: 'min(873px, calc(100% - 60px))',
          }}
        />

        <div className="window" style={{
          position: 'absolute',
          top: 72, left: 650,
          width: 'min(1080px, calc(100% - 560px))',
          height: 'calc(100% - 150px)',
          display: 'flex', flexDirection: 'column',
        }}>
          <TitleBar title={titleForMain} onClose={phase !== 'idle' ? goIdle : undefined} />
          <div style={{ flex: 1, overflowY: 'auto', padding: '32px 40px', background: '#FFFFFF' }}>
            {phase === 'idle' && <IdleView onStart={startRecording} />}
            {phase === 'rec' && <RecView elapsed={elapsed} analyser={analyser} onStop={stopRecording} />}
            {phase === 'edit' && buffer && (
              <EditView
                buffer={buffer}
                start={start} end={end} duration={duration}
                startFrac={startFrac} endFrac={endFrac} playheadFrac={playheadFrac}
                onChangeFrac={(s, e) => { setStart(s * duration); setEnd(e * duration); }}
                playing={playing} looping={looping}
                onPlay={playSelection}
                onStop={stopPlayback}
                onToggleLoop={() => {
                  const next = !looping;
                  setLooping(next);
                  if (playing) playWith(next);
                }}
                folders={folders}
                onAddFolder={addFolder}
                category={category} setCategory={setCategory}
                name={name} setName={setName}
                onSave={save}
                isUpdate={!!editingRef}
              />
            )}
          </div>
        </div>
      </div>

      {alertMsg && <AlertBox msg={alertMsg} onOk={() => setAlertMsg(null)} />}
    </div>
  );
}

// ── MenuBar ────────────────────────────────────────────────────────

function MenuBar({ ffmpegOk }: { count: number; ffmpegOk: boolean | null }) {
  const connected = ffmpegOk === true;
  const lightColor =
    ffmpegOk == null ? '#888888' :
    connected ? '#22CC44' : '#BB0000';
  const label =
    ffmpegOk == null ? 'CONNECTING…' :
    connected ? 'CONNECTED' : 'DISCONNECTED';
  return (
    <div style={{
      height: 30, background: '#FFFFFF',
      borderBottom: '1px solid #000',
      display: 'flex', alignItems: 'center',
      padding: '0 8px',
      fontFamily: 'var(--chicago)', fontSize: 12,
      flexShrink: 0,
    }}>
      <RainbowApple />
      <span style={{ marginLeft: 10, fontWeight: 700 }}>COLLECTOR</span>
      <span style={{ marginLeft: 6, color: '#555' }}>v1.3</span>
      <div style={{ flex: 1 }} />
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, color: '#000',
      }}>
        <span style={{
          width: 9, height: 9,
          background: lightColor,
          border: '1px solid #000',
          boxShadow: connected
            ? `inset -1px -1px 0 rgba(0,0,0,.35), inset 1px 1px 0 rgba(255,255,255,.6), 0 0 3px ${lightColor}`
            : 'inset -1px -1px 0 rgba(0,0,0,.35), inset 1px 1px 0 rgba(255,255,255,.45)',
          display: 'inline-block',
        }} />
        <span style={{ fontSize: 12 }}>{label}</span>
      </span>
    </div>
  );
}

function RainbowApple() {
  return (
    <svg width="13" height="15" viewBox="0 0 13 15" style={{ display: 'block' }}>
      <defs>
        <clipPath id="apple-clip">
          <path d="
            M 8.2 3.2
            C 8.4 2.4 8.7 1.4 9.5 0.6
            C 8.5 0.6 7.7 1.2 7.2 2.0
            C 6.8 1.5 6.2 1.2 5.4 1.2
            C 6.0 1.0 6.6 0.4 6.8 0.0
            C 5.8 0.0 4.9 0.5 4.4 1.3
            C 3.9 1.0 3.3 0.9 2.6 1.1
            C 0.9 1.5 -0.1 3.2 0.3 5.5
            C 0.7 8.0 2.5 11.5 4.5 13.4
            C 5.3 14.2 6.1 14.2 6.7 13.6
            C 7.2 13.2 7.7 13.2 8.3 13.6
            C 8.9 14.0 9.7 14.0 10.5 13.2
            C 12.5 11.3 13.5 8.0 13.0 5.5
            C 12.6 3.2 11.0 1.8 9.0 2.0
            C 8.6 2.0 8.3 2.4 8.2 3.2 Z
            M 9.1 1.0
            C 9.4 0.4 10.1 -0.1 11.0 -0.1
            C 11.0 0.7 10.5 1.4 9.9 1.7
            C 9.5 1.9 9.0 1.7 9.1 1.0 Z
          " />
        </clipPath>
      </defs>
      <g clipPath="url(#apple-clip)">
        <rect x="0" y="0"     width="13" height="2.5" fill="#5DB44C"/>
        <rect x="0" y="2.5"   width="13" height="2.5" fill="#FCB827"/>
        <rect x="0" y="5"     width="13" height="2.5" fill="#F5821F"/>
        <rect x="0" y="7.5"   width="13" height="2.5" fill="#E03A3E"/>
        <rect x="0" y="10"    width="13" height="2.5" fill="#963D97"/>
        <rect x="0" y="12.5"  width="13" height="2.5" fill="#3072F1"/>
      </g>
    </svg>
  );
}

// ── Btn (3D bevel) ─────────────────────────────────────────────────

function Btn({
  children, onClick, primary, disabled, danger, small, style,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  danger?: boolean;
  small?: boolean;
  style?: React.CSSProperties;
}) {
  const [down, setDown] = useState(false);
  const cls = down && !disabled ? 'bevel-in' : 'bevel-out';
  return (
    <button
      onMouseDown={() => !disabled && setDown(true)}
      onMouseUp={() => setDown(false)}
      onMouseLeave={() => setDown(false)}
      onClick={() => !disabled && onClick && onClick()}
      disabled={disabled}
      className={cls}
      style={{
        padding: small ? '2px 10px' : '3px 14px',
        fontFamily: 'var(--chicago)',
        fontWeight: primary ? 700 : 400,
        fontSize: small ? 11 : 12,
        color: disabled ? '#888' : (danger ? '#BB0000' : '#000'),
        cursor: disabled ? 'default' : 'pointer',
        borderRadius: primary ? 7 : 3,
        outline: primary ? '2px solid #000' : 'none',
        outlineOffset: primary ? '1px' : '0',
        ...style,
      }}>
      {children}
    </button>
  );
}

// ── TitleBar ──────────────────────────────────────────────────────

function TitleBar({ title, active = true, onClose, right }: {
  title: string; active?: boolean; onClose?: () => void; right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      borderBottom: '1px solid #000',
      background: active ? '#FFFFFF' : '#DDDDDD',
      height: 18, position: 'relative', flexShrink: 0,
    }}>
      {active && (
        <div className="titlebar-stripes" style={{
          position: 'absolute', left: 0, top: 2, right: 0, bottom: 2,
        }} />
      )}
      {onClose && (
        <button onClick={onClose} title="Close" style={{
          position: 'relative', zIndex: 2, marginLeft: 4,
          width: 11, height: 11, border: '1px solid #000',
          background: '#FFFFFF', cursor: 'pointer', padding: 0,
          boxShadow: 'inset 1px 1px 0 #FFF, inset -1px -1px 0 #888',
        }} />
      )}
      {!onClose && <div style={{ width: 4 }} />}
      <div style={{
        position: 'relative', zIndex: 2, flex: 1, textAlign: 'center',
        background: active ? '#FFFFFF' : 'transparent',
        padding: '0 10px',
        fontWeight: 700, fontFamily: 'var(--chicago)', fontSize: 12,
        lineHeight: '16px',
      }}>
        {title}
      </div>
      {right ? (
        <div style={{
          position: 'relative', zIndex: 2,
          marginRight: 4, background: '#FFF', padding: '0 4px',
          fontSize: 10, fontFamily: 'var(--mono)',
        }}>
          {right}
        </div>
      ) : (
        <div style={{
          position: 'relative', zIndex: 2, marginRight: 4,
          width: 11, height: 11, border: '1px solid #000', background: '#FFFFFF',
          boxShadow: 'inset 1px 1px 0 #FFF, inset -1px -1px 0 #888',
        }} />
      )}
    </div>
  );
}

// ── Library ────────────────────────────────────────────────────────

function Library({
  items, folders, setFolders, onDeleteFolder, currentId, onOpen, onNewRec, style,
}: {
  items: LibItem[];
  folders: string[];
  setFolders: React.Dispatch<React.SetStateAction<string[]>>;
  onDeleteFolder: (f: string) => void;
  currentId: string | null;
  onOpen: (it: LibItem) => void;
  onNewRec: () => void;
  style?: React.CSSProperties;
}) {
  const [folderFilter, setFolderFilter] = useState<string>('ALL');
  const [groupBy, setGroupBy] = useState<'folder' | 'date'>('folder');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const folderFiltered = folderFilter === 'ALL' ? items : items.filter(i => i.cat === folderFilter);

  const groups: [string, LibItem[]][] = useMemo(() => {
    if (groupBy === 'date') {
      const g: Record<string, LibItem[]> = {};
      folderFiltered.forEach(it => {
        const d = new Date(it.mtime);
        const key = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        (g[key] = g[key] || []).push(it);
      });
      return Object.entries(g).sort((a, b) => {
        const ta = a[1][0]?.mtime ?? 0;
        const tb = b[1][0]?.mtime ?? 0;
        return tb - ta;
      });
    }
    const g: Record<string, LibItem[]> = {};
    folderFiltered.forEach(it => { (g[it.cat] = g[it.cat] || []).push(it); });
    return Object.entries(g);
  }, [folderFiltered, groupBy]);

  return (
    <div className="window" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, ...style }}>
      <TitleBar title="📁 SAMPLE LIBRARY" right={
        <span style={{ fontSize: 10, fontFamily: 'var(--mono)' }}>{items.length}</span>
      } />

      <div style={{
        padding: 30, borderBottom: '1px solid #000',
        background: '#DDDDDD',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      }}>
        <Btn onClick={onNewRec} primary style={{ color: '#BB0000', padding: '9px 14px', fontSize: 17 }}>
          ● NEW REC…
        </Btn>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700 }}>VIEW:</span>
          <div style={{ display: 'flex', gap: 0 }}>
            {(['folder', 'date'] as const).map(t => (
              <Btn key={t} small onClick={() => setGroupBy(t)} style={{
                background: groupBy === t ? '#000' : undefined,
                color: groupBy === t ? '#FFF' : '#000',
                fontWeight: groupBy === t ? 700 : 400,
              }}>
                {t === 'folder' ? '⊞ FOLDER' : '◷ DATE'}
              </Btn>
            ))}
          </div>
        </div>
      </div>

      {/* folder chips */}
      <div style={{
        padding: 30, borderBottom: '1px solid #000',
        background: '#FFFFFF',
        display: 'flex', flexWrap: 'wrap', gap: 10,
      }}>
        {(['ALL', ...folders]).map(c => {
          const active = folderFilter === c;
          const isConfirm = confirmDel === c;
          return (
            <span key={c} style={{
              display: 'inline-flex', alignItems: 'center',
              background: active ? '#000' : '#FFF',
              color: active ? '#FFF' : '#000',
              border: '1px solid #000',
              fontSize: 12,
            }}>
              <button onClick={() => setFolderFilter(c)} style={{
                background: 'transparent', border: 'none', color: 'inherit',
                padding: '9px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
                fontWeight: active ? 900 : 900,
              }}>{c.toUpperCase()}</button>
              {c !== 'ALL' && (
                <button onClick={() => {
                  if (isConfirm) {
                    if (folderFilter === c) setFolderFilter('ALL');
                    onDeleteFolder(c);
                    setConfirmDel(null);
                    return;
                  }
                  setConfirmDel(c);
                  setTimeout(() => setConfirmDel(prev => (prev === c ? null : prev)), 3000);
                }} style={{
                  background: isConfirm ? '#BB0000' : 'transparent',
                  border: 'none', borderLeft: '1px solid ' + (active ? '#FFF' : '#000'),
                  color: isConfirm ? '#FFF' : '#BB0000',
                  padding: '4px 7px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
                }}>×</button>
              )}
            </span>
          );
        })}
        <button onClick={() => {
          const fname = prompt('Folder name:');
          if (!fname) return;
          const f = fname.trim().toLowerCase().replace(/[^a-z0-9_\- ]/g, '').replace(/\s+/g, '_');
          if (f && !folders.includes(f)) {
            setFolders(prev => [...prev, f]);
            setFolderFilter(f);
          }
        }} style={{
          background: '#FFF', border: '1px dashed #000',
          padding: '4px 10px', fontSize: 12, cursor: 'pointer',
          fontFamily: 'inherit',
        }}>+</button>
      </div>

      {/* sample list */}
      <div style={{ flex: 1, overflowY: 'auto', background: '#FFF' }}>
        {groups.length === 0 && (
          <div style={{ padding: 36, textAlign: 'center', color: '#888', fontSize: 12 }}>
            — no samples —
          </div>
        )}
        {groups.map(([group, list]) => (
          <div key={group}>
            <div style={{
              padding: '6px 14px', background: '#DDDDDD',
              borderTop: '1px solid #000', borderBottom: '1px solid #000',
              fontWeight: 700, fontSize: 12,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>▼ {group}</span>
              <span style={{ fontFamily: 'var(--mono)', color: '#555' }}>{list.length}</span>
            </div>
            {list.map(it => {
              const active = currentId === it.id;
              return (
                <div key={it.id} onClick={() => onOpen(it)} style={{
                  padding: '6px 14px',
                  background: active ? 'var(--accent)' : 'transparent',
                  color: active ? '#FFF' : '#000',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 10,
                  fontSize: 13, fontFamily: 'var(--chicago)',
                }}>
                  <span style={{ fontSize: 13 }}>♪</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.name}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: active ? '#FFF' : '#666' }}>
                    {it.dur > 0 ? `${it.dur.toFixed(2)}s` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── IdleView ──────────────────────────────────────────────────────

function IdleView({ onStart }: { onStart: () => void }) {
  return (
    <div style={{
      minHeight: '100%', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 36, padding: 32,
    }}>
      <svg width="200" height="200" viewBox="0 0 64 64" style={{ imageRendering: 'pixelated' }}>
        <rect x="8" y="6" width="48" height="44" fill="#FFF" stroke="#000" strokeWidth="2"/>
        <rect x="12" y="10" width="40" height="28" fill="#000"/>
        <g fill="#FFF">
          {[14,18,22,26,30,34,38,42,46,50].map((x,i)=>{
            const h = [4,8,16,12,20,14,22,10,6,8][i];
            return <rect key={i} x={x} y={24 - (h ?? 0)/2} width="2" height={h}/>;
          })}
        </g>
        <rect x="20" y="50" width="24" height="6" fill="#FFF" stroke="#000" strokeWidth="2"/>
        <rect x="14" y="56" width="36" height="4" fill="#FFF" stroke="#000" strokeWidth="2"/>
      </svg>
      <div style={{ textAlign: 'center', fontFamily: 'var(--chicago)' }}>
        <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 14, letterSpacing: 1 }}>
          Welcome to Collector
        </div>
        <div style={{ fontSize: 14, color: '#444', maxWidth: 520, lineHeight: 1.5 }}>
          Collect a sound from any tab. Pick a Chrome tab,
          tick "Share tab audio", and stop when you hear what you want.
        </div>
      </div>
      <Btn onClick={onStart} primary style={{ padding: '10px 30px', color: '#BB0000', fontSize: 15 }}>
        ● RECORD TAB…
      </Btn>
      <div style={{ fontSize: 12, color: '#666', fontFamily: 'var(--mono)' }}>
        — OR CLICK A SAMPLE IN THE LIBRARY —
      </div>
    </div>
  );
}

// ── RecView ───────────────────────────────────────────────────────

function RecView({ elapsed, analyser, onStop }: {
  elapsed: number; analyser: AnalyserNode | null; onStop: () => void;
}) {
  const N = 36;
  const [bars, setBars] = useState<number[]>(Array(N).fill(0));
  useEffect(() => {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const bins = data.length;
      const out: number[] = [];
      for (let i = 0; i < N; i++) {
        const i0 = Math.floor((i / N) * bins);
        const i1 = Math.max(i0 + 1, Math.floor(((i + 1) / N) * bins));
        let sum = 0;
        for (let j = i0; j < i1; j++) sum += data[j] ?? 0;
        out.push(sum / Math.max(1, i1 - i0) / 255);
      }
      setBars(out);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return (
    <div style={{
      minHeight: '100%', display: 'flex', flexDirection: 'column', gap: 22,
      maxWidth: 1080, margin: '0 auto', width: '100%',
      alignItems: 'center', justifyContent: 'center', padding: '24px 0',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <span style={{
          width: 22, height: 22, background: '#BB0000',
          border: '1px solid #000', animation: 'recPulse 1s infinite',
        }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 56, fontWeight: 700 }}>
          {formatT(elapsed)}
        </span>
      </div>
      <div className="input-box" style={{
        padding: 12, background: '#FFF',
        display: 'flex', alignItems: 'flex-end', gap: 3, height: 280, width: '100%',
      }}>
        {bars.map((v, i) => (
          <span key={i} style={{
            flex: 1, height: `${Math.max(4, v * 100)}%`,
            background: '#000',
          }} />
        ))}
      </div>
      <div style={{ fontSize: 13, color: '#444' }}>RECORDING TAB AUDIO…</div>
      <Btn onClick={onStop} primary style={{ padding: '10px 28px', fontSize: 15 }}>
        ■ STOP &amp; EDIT
      </Btn>
    </div>
  );
}

// ── EditView ───────────────────────────────────────────────────────

function EditView({
  buffer, start, end, duration,
  startFrac, endFrac, playheadFrac, onChangeFrac,
  playing, looping, onPlay, onStop, onToggleLoop,
  folders, onAddFolder,
  category, setCategory, name, setName,
  onSave, isUpdate,
}: {
  buffer: AudioBuffer;
  start: number; end: number; duration: number;
  startFrac: number; endFrac: number; playheadFrac: number | null;
  onChangeFrac: (s: number, e: number) => void;
  playing: boolean; looping: boolean;
  onPlay: () => void; onStop: () => void; onToggleLoop: () => void;
  folders: string[];
  onAddFolder: (raw: string) => void;
  category: string; setCategory: (c: string) => void;
  name: string; setName: (n: string) => void;
  onSave: () => void;
  isUpdate: boolean;
}) {
  const cropSec = end - start;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 1080, margin: '0 auto', width: '100%' }}>
      <div>
        <Waveform
          buffer={buffer}
          startFrac={startFrac}
          endFrac={endFrac}
          onChangeFrac={onChangeFrac}
          playheadFrac={playheadFrac}
        />
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          padding: '8px 14px', fontFamily: 'var(--mono)', fontSize: 13,
          background: '#DDDDDD', border: '1px solid #000', borderTop: 'none',
        }}>
          <span>In: <b>{formatT(start)}</b></span>
          <span>Out: <b>{formatT(end)}</b></span>
          <span>Crop: <b>{formatT(cropSec)}</b></span>
          <span style={{ color: '#666' }}>Total: {formatT(duration)}</span>
        </div>
      </div>

      {/* transport */}
      <div className="bevel-out" style={{
        padding: 14, display: 'flex', alignItems: 'center',
        justifyContent: 'center', gap: 12,
      }}>
        <Btn onClick={onPlay} disabled={playing} style={{ padding: '6px 26px', fontSize: 13 }}>▶ PLAY</Btn>
        <Btn onClick={onStop} disabled={!playing} style={{ padding: '6px 26px', fontSize: 13 }}>■ STOP</Btn>
        <Btn onClick={onToggleLoop} style={{
          padding: '6px 26px', fontSize: 13,
          background: looping ? '#000' : undefined,
          color: looping ? '#FFF' : '#000',
          fontWeight: looping ? 700 : 400,
        }}>↻ LOOP {looping ? 'ON' : 'OFF'}</Btn>
        <span style={{ marginLeft: 14, fontFamily: 'var(--mono)', fontSize: 12, color: '#666' }}>
          ⌨ SPACE = PLAY/STOP
        </span>
      </div>

      {/* save panel */}
      <fieldset style={{
        border: '1px solid #000', padding: 22,
        background: '#DDDDDD',
        margin: 0,
      }}>
        <legend style={{
          padding: '0 10px', fontWeight: 700, fontSize: 13,
          background: '#FFF', border: '1px solid #000',
        }}>
          SAVE SAMPLE
        </legend>

        <div style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ width: 90, fontWeight: 700, fontSize: 13 }}>FOLDER:</span>
          </div>
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 4,
            paddingLeft: 102,
          }}>
            {folders.map(f => {
              const active = category === f;
              return (
                <button key={f} onClick={() => setCategory(f)} style={{
                  background: active ? '#000' : '#FFF',
                  color: active ? '#FFF' : '#000',
                  border: '1px solid #000',
                  padding: '4px 12px',
                  cursor: 'pointer',
                  fontFamily: 'var(--chicago)',
                  fontSize: 12,
                  fontWeight: active ? 700 : 400,
                  textTransform: 'uppercase',
                }}>
                  {f}
                </button>
              );
            })}
            <button onClick={() => {
              const fname = prompt('New folder name:');
              if (fname) onAddFolder(fname);
            }} style={{
              background: '#FFF', border: '1px dashed #000',
              padding: '4px 10px', fontSize: 12, cursor: 'pointer',
              fontFamily: 'inherit',
            }}>+</button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <span style={{ width: 90, fontWeight: 700, fontSize: 13 }}>NAME:</span>
          <input value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onSave(); }}
            placeholder={`${category}_01`}
            className="input-box"
            style={{ flex: 1, fontSize: 13, padding: '6px 10px' }} />
        </div>

        <div style={{
          padding: '8px 12px', background: '#FFF',
          border: '1px solid #000', fontFamily: 'var(--mono)', fontSize: 12,
          marginBottom: 18,
        }}>
          → samples/{category}/{cleanNamePreview(name) || category + '_xx'}.wav
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <Btn onClick={onSave} primary>{isUpdate ? 'UPDATE' : 'SAVE'}</Btn>
        </div>
      </fieldset>
    </div>
  );
}

// ── AlertBox modal ─────────────────────────────────────────────────

function AlertBox({ msg, onOk }: { msg: string; onOk: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,.2)', zIndex: 100,
    }}>
      <div className="window" style={{ minWidth: 280, background: '#FFF' }}>
        <TitleBar title="Collector" />
        <div style={{ padding: 16, display: 'flex', gap: 12 }}>
          <div style={{ fontSize: 28 }}>💾</div>
          <div style={{ flex: 1, whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5 }}>{msg}</div>
        </div>
        <div style={{ padding: '0 12px 12px', display: 'flex', justifyContent: 'flex-end' }}>
          <Btn onClick={onOk} primary>OK</Btn>
        </div>
      </div>
    </div>
  );
}

// ── Waveform (B&W pixelated) ───────────────────────────────────────

function Waveform({
  buffer, startFrac, endFrac, playheadFrac, onChangeFrac,
}: {
  buffer: AudioBuffer;
  startFrac: number; endFrac: number; playheadFrac: number | null;
  onChangeFrac: (s: number, e: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(700);
  const height = 280;
  const drag = useRef<{ kind: 'start' | 'end' | 'move' | null; grab?: number }>({ kind: null });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const peaks = useMemo(() => computePeaksAbs(buffer, 220), [buffer]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = w; cv.height = height;
    cv.style.width = w + 'px';
    cv.style.height = height + 'px';
    const ctx = cv.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, height);

    const xs = Math.floor(startFrac * w);
    const xe = Math.floor(endFrac * w);

    // Baseline
    ctx.fillStyle = '#000';
    ctx.fillRect(0, Math.floor(height / 2), w, 1);

    // Wave bars
    const n = peaks.length;
    const step = w / n;
    for (let i = 0; i < n; i++) {
      const v = peaks[i] ?? 0;
      const bh = Math.max(1, Math.floor(v * (height * 0.85)));
      const bx = Math.floor(i * step);
      const inSel = bx >= xs && bx <= xe;
      ctx.fillStyle = inSel ? '#000000' : '#888888';
      ctx.fillRect(bx, Math.floor((height - bh) / 2), Math.max(1, Math.floor(step)), bh);
    }

    // Selection borders (dashed)
    ctx.fillStyle = '#000';
    for (let y = 0; y < height; y += 3) {
      ctx.fillRect(xs, y, 1, 2);
      ctx.fillRect(xe, y, 1, 2);
    }
    // Handles
    ctx.fillRect(xs - 4, 0, 9, 8);
    ctx.fillRect(xs - 4, height - 8, 9, 8);
    ctx.fillRect(xe - 4, 0, 9, 8);
    ctx.fillRect(xe - 4, height - 8, 9, 8);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(xs - 1, 2, 1, 1);
    ctx.fillRect(xe - 1, 2, 1, 1);

    if (playheadFrac != null && playheadFrac >= startFrac && playheadFrac <= endFrac) {
      const px = Math.floor(playheadFrac * w);
      ctx.fillStyle = '#000';
      ctx.fillRect(px, 0, 1, height);
      ctx.fillRect(px - 3, 0, 7, 1);
      ctx.fillRect(px - 2, 1, 5, 1);
      ctx.fillRect(px - 1, 2, 3, 1);
    }
  }, [peaks, w, height, startFrac, endFrac, playheadFrac]);

  const onDown = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = (e.clientX - rect.left) / rect.width;
    if (Math.abs(t - startFrac) < 0.018) drag.current = { kind: 'start' };
    else if (Math.abs(t - endFrac) < 0.018) drag.current = { kind: 'end' };
    else if (t > startFrac && t < endFrac) drag.current = { kind: 'move', grab: t };
    else { drag.current = { kind: 'end' }; onChangeFrac(t, Math.max(t + 0.01, endFrac)); }
  };
  const onMove = (e: React.MouseEvent) => {
    if (!drag.current.kind) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (drag.current.kind === 'start') onChangeFrac(Math.min(t, endFrac - 0.01), endFrac);
    else if (drag.current.kind === 'end') onChangeFrac(startFrac, Math.max(t, startFrac + 0.01));
    else if (drag.current.kind === 'move' && drag.current.grab != null) {
      const d = t - drag.current.grab;
      let ns = startFrac + d, ne = endFrac + d;
      if (ns < 0) { ne -= ns; ns = 0; }
      if (ne > 1) { ns -= ne - 1; ne = 1; }
      onChangeFrac(ns, ne);
      drag.current.grab = t;
    }
  };
  const onUp = () => { drag.current = { kind: null }; };

  return (
    <div ref={wrapRef} className="input-box" style={{ padding: 0, background: '#fff' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: 'ew-resize', imageRendering: 'pixelated' }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
      />
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function computePeaksAbs(buf: AudioBuffer, n: number): number[] {
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / n));
  const out: number[] = [];
  for (let x = 0; x < n; x++) {
    let m = 0;
    const i0 = x * step, i1 = Math.min(data.length, i0 + step);
    for (let i = i0; i < i1; i++) {
      const v = Math.abs(data[i] as number);
      if (v > m) m = v;
    }
    out.push(m);
  }
  return out;
}

function cleanNamePreview(s: string) {
  return s.trim().replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_');
}

function formatT(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
}
