import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './index.css';

const DEFAULT_FOLDERS = [
  'kick', 'snare', 'hihat', 'clap', 'perc',
  'bass', 'nappe', 'lead', 'vocal', 'fx', 'loop',
];

// Editorial palette — mirrored in index.css
const ED_BG = '#f3eee3';
const ED_PAPER = '#fbf7ec';
const ED_INK = '#181613';
const ED_DIM = '#8d8475';
const ED_RULE = '#cfc6b3';
const ED_ACC = '#d44a1f';
const ED_SOFT = '#fff7e6';

const SERIF = "'EB Garamond', 'Cormorant Garamond', Georgia, serif";
const SANS = "'Inter', ui-sans-serif, system-ui, sans-serif";

type Phase = 'idle' | 'rec' | 'edit';
type LibRaw = Record<string, { name: string; size: number; mtime: number; dur: number }[]>;
type LibItem = { id: string; cat: string; name: string; file: string; dur: number; mtime: number };

export default function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);

  const [blob, setBlob] = useState<Blob | null>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [history, setHistory] = useState<{
    start: number; end: number;
    buffer: AudioBuffer; blob: Blob | null;
  }[]>([]);
  const [redoStack, setRedoStack] = useState<{
    start: number; end: number;
    buffer: AudioBuffer; blob: Blob | null;
  }[]>([]);
  const historyTimerRef = useRef<number | null>(null);
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
    const src = playSrcRef.current;
    if (!src || !playing || !looping) return;
    try {
      src.loopStart = start;
      src.loopEnd = end;
    } catch {}
  }, [start, end, playing, looping]);

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
        setHistory([]); setRedoStack([]);
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
      setAlertMsg(e?.message || 'Capture refused');
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    recRef.current?.stop();
  }, []);

  const cancelRecording = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { recRef.current?.stop(); } catch {}
    recRef.current = null;
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    recCtxRef.current?.close().catch(() => {});
    recCtxRef.current = null;
    setAnalyser(null);
    setElapsed(0);
    setPhase(buffer ? 'edit' : 'idle');
  }, [buffer]);

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
      setHistory([]);
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
    const prevBuffer = buffer;
    const prevBlob = blob;
    const prevStart = start;
    const prevEnd = end;
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
          if (prevBuffer) {
            setHistory(prev => [...prev, { start: prevStart, end: prevEnd, buffer: prevBuffer, blob: prevBlob }]);
            setRedoStack([]);
          }
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
  }, [blob, name, category, start, end, editingRef, buffer, refreshLibrary, stopPlayback]);

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

  const currentId = editingRef ? `${editingRef.cat}/${editingRef.file}` : null;
  const trackIndex = useMemo(() => {
    if (!currentId) return null;
    const idx = libraryItems.findIndex(i => i.id === currentId);
    return idx >= 0 ? idx + 1 : null;
  }, [currentId, libraryItems]);

  return (
    <div style={{
      width: '100%', height: '100%',
      background: ED_BG, color: ED_INK,
      fontFamily: SERIF,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <StatusBar ffmpegOk={ffmpegOk} count={libraryItems.length} />

      <div style={{
        flex: 1, padding: 22, display: 'flex', gap: 22, minHeight: 0,
      }}>
        <Library
          items={libraryItems}
          folders={folders}
          libraryRaw={libraryRaw}
          phase={phase}
          currentId={currentId}
          onOpen={loadFromLibrary}
          onNewRec={() => phase === 'rec' ? cancelRecording() : startRecording()}
          onDeleteFolder={deleteFolder}
          onRequestNewFolder={() => setPromptOpen(true)}
        />

        {phase === 'rec' ? (
          <Recording
            elapsed={elapsed}
            analyser={analyser}
            onStop={stopRecording}
            onCancel={cancelRecording}
          />
        ) : phase === 'edit' && buffer ? (
          <Editor
            buffer={buffer}
            name={name}
            displayName={editingRef ? name : (name || 'untitled')}
            trackIndex={trackIndex}
            duration={duration}
            start={start} end={end}
            startFrac={startFrac} endFrac={endFrac} playheadFrac={playheadFrac}
            onChangeFrac={(s, e) => {
              if (historyTimerRef.current === null && buffer) {
                setHistory(prev => [...prev, { start, end, buffer, blob }]);
                setRedoStack([]);
              } else if (historyTimerRef.current !== null) {
                clearTimeout(historyTimerRef.current);
              }
              historyTimerRef.current = window.setTimeout(() => {
                historyTimerRef.current = null;
              }, 500);
              setStart(s * duration); setEnd(e * duration);
            }}
            playing={playing}
            looping={looping}
            onPlay={playSelection}
            onStop={stopPlayback}
            onToggleLoop={() => {
              const next = !looping;
              setLooping(next);
              if (playing) playWith(next);
            }}
            canUndo={history.length > 0}
            onUndo={() => {
              if (history.length === 0) return;
              const last = history[history.length - 1];
              if (last && buffer) {
                stopPlayback();
                setRedoStack(prev => [...prev, { start, end, buffer, blob }]);
                setBuffer(last.buffer);
                setBlob(last.blob);
                setStart(last.start);
                setEnd(last.end);
              }
              setHistory(prev => prev.slice(0, -1));
            }}
            canRedo={redoStack.length > 0}
            onRedo={() => {
              if (redoStack.length === 0) return;
              const next = redoStack[redoStack.length - 1];
              if (next && buffer) {
                stopPlayback();
                setHistory(prev => [...prev, { start, end, buffer, blob }]);
                setBuffer(next.buffer);
                setBlob(next.blob);
                setStart(next.start);
                setEnd(next.end);
              }
              setRedoStack(prev => prev.slice(0, -1));
            }}
            folders={folders}
            onRequestNewFolder={() => setPromptOpen(true)}
            category={category} setCategory={setCategory}
            setName={setName}
            onSave={save}
            onCancel={goIdle}
            isUpdate={!!editingRef}
          />
        ) : (
          <IdleEditor onStart={startRecording} hasItems={libraryItems.length > 0} />
        )}
      </div>

      {alertMsg && <AlertBox msg={alertMsg} onOk={() => setAlertMsg(null)} />}
      {promptOpen && (
        <PromptBox
          msg="Name your new folder"
          onConfirm={(v) => { addFolder(v); setPromptOpen(false); }}
          onCancel={() => setPromptOpen(false)}
        />
      )}
    </div>
  );
}

// ── StatusBar ──────────────────────────────────────────────────────

function StatusBar({ ffmpegOk, count }: { ffmpegOk: boolean | null; count: number }) {
  const connected = ffmpegOk === true;
  const label =
    ffmpegOk == null ? 'connecting…' :
    connected ? 'connected · ffmpeg ok · 44.1 kHz' : 'disconnected · ffmpeg missing';
  return (
    <div style={{
      height: 30, padding: '0 22px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      fontFamily: SANS, fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: ED_DIM,
      borderBottom: `1px solid ${ED_RULE}`, background: ED_BG, flexShrink: 0,
    }}>
      <span>collector &nbsp;·&nbsp; <span style={{ color: ED_INK }}>vol. i / iss. {String(count).padStart(2, '0')}</span></span>
      <span><span style={{ color: connected ? ED_ACC : ED_DIM }}>●</span> {label}</span>
    </div>
  );
}

// ── Panel (cream card) ────────────────────────────────────────────

function Panel({
  kicker, title, right, children, style,
}: {
  kicker: string;
  title: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{
      background: ED_PAPER,
      border: `1px solid ${ED_RULE}`,
      display: 'flex', flexDirection: 'column',
      minHeight: 0, minWidth: 0,
      ...style,
    }}>
      <div style={{
        padding: '14px 22px 12px',
        borderBottom: `1px solid ${ED_RULE}`,
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
        flexShrink: 0,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase', color: ED_DIM }}>{kicker}</div>
          <div style={{
            fontFamily: SERIF, fontSize: 22, lineHeight: 1.1, marginTop: 2, color: ED_INK,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</div>
        </div>
        {right != null && (
          <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: ED_DIM, textAlign: 'right' }}>{right}</div>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  );
}

// ── FolderChip ────────────────────────────────────────────────────

function FolderChip({
  label, active, count, onClick, onDelete, dashed,
}: {
  label: string;
  active?: boolean;
  count?: number | null;
  onClick?: () => void;
  onDelete?: () => void;
  dashed?: boolean;
}) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      border: dashed ? `1px dashed ${ED_RULE}` : (active ? `1px solid ${ED_INK}` : `1px solid ${ED_RULE}`),
      background: active ? ED_INK : 'transparent',
      color: active ? ED_PAPER : ED_INK,
    }}>
      <button onClick={onClick} style={{
        fontFamily: SANS, fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase',
        padding: '5px 12px',
        background: 'transparent', border: 'none', color: 'inherit',
        cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>
        <span>{label}</span>
        {count != null && <span style={{ color: active ? ED_PAPER : ED_DIM, fontSize: 10 }}>{count}</span>}
      </button>
      {onDelete && (
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete folder" style={{
          background: 'transparent', border: 'none', borderLeft: `1px solid ${active ? ED_PAPER : ED_RULE}`,
          color: active ? ED_PAPER : ED_DIM,
          padding: '4px 8px', cursor: 'pointer', fontFamily: SANS, fontSize: 10,
        }}>×</button>
      )}
    </span>
  );
}

// ── Library ────────────────────────────────────────────────────────

function Library({
  items, folders, libraryRaw, phase, currentId, onOpen, onNewRec, onDeleteFolder, onRequestNewFolder,
}: {
  items: LibItem[];
  folders: string[];
  libraryRaw: LibRaw;
  phase: Phase;
  currentId: string | null;
  onOpen: (it: LibItem) => void;
  onNewRec: () => void;
  onDeleteFolder: (f: string) => void;
  onRequestNewFolder: () => void;
}) {
  const [folderFilter, setFolderFilter] = useState<string>('all');
  const [groupBy, setGroupBy] = useState<'folder' | 'date'>('folder');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const folderFiltered = folderFilter === 'all' ? items : items.filter(i => i.cat === folderFilter);

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
    <Panel
      kicker="catalogue"
      title="Sample Library"
      right={<>{items.length} {items.length === 1 ? 'piece' : 'pieces'}</>}
      style={{ width: 380, flex: 'none' }}
    >
      {/* Top: Record button + view toggle */}
      <div style={{
        padding: '18px 22px 14px',
        display: 'flex', gap: 12, alignItems: 'center',
        borderBottom: `1px solid ${ED_RULE}`,
      }}>
        <button onClick={onNewRec} style={{
          flex: 1,
          padding: '12px 14px',
          background: phase === 'rec' ? ED_INK : ED_ACC,
          color: ED_PAPER, border: 'none', cursor: 'pointer',
          fontFamily: SANS, fontSize: 11, letterSpacing: 2.5, textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: 99, background: ED_PAPER, display: 'inline-block',
            animation: phase === 'rec' ? 'recPulse 1s infinite' : undefined,
          }} />
          {phase === 'rec' ? 'recording…' : 'record a tab'}
        </button>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['folder', 'date'] as const).map(t => {
            const active = groupBy === t;
            return (
              <button key={t} onClick={() => setGroupBy(t)} style={{
                padding: '6px 10px', fontFamily: SANS, fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase',
                border: active ? `1px solid ${ED_INK}` : `1px solid ${ED_RULE}`,
                background: active ? ED_INK : 'transparent',
                color: active ? ED_PAPER : ED_INK,
                cursor: 'pointer',
              }}>{t}</button>
            );
          })}
        </div>
      </div>

      {/* Folder chips */}
      <div style={{ padding: '14px 22px', borderBottom: `1px solid ${ED_RULE}` }}>
        <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase', color: ED_DIM, marginBottom: 10 }}>filter</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <FolderChip label="all" active={folderFilter === 'all'} count={items.length} onClick={() => setFolderFilter('all')} />
          {folders.map(f => {
            const cnt = (libraryRaw[f] || []).length;
            const isConfirm = confirmDel === f;
            return (
              <FolderChip
                key={f}
                label={isConfirm ? `${f}?` : f}
                active={folderFilter === f}
                count={cnt > 0 ? cnt : null}
                onClick={() => setFolderFilter(f)}
                onDelete={() => {
                  if (isConfirm) {
                    if (folderFilter === f) setFolderFilter('all');
                    onDeleteFolder(f);
                    setConfirmDel(null);
                    return;
                  }
                  setConfirmDel(f);
                  setTimeout(() => setConfirmDel(prev => (prev === f ? null : prev)), 3000);
                }}
              />
            );
          })}
          <FolderChip label="+ new" dashed onClick={onRequestNewFolder} />
        </div>
      </div>

      {/* Sample list, grouped */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {groups.length === 0 && (
          <div style={{
            padding: '40px 22px', textAlign: 'center', color: ED_DIM,
            fontFamily: SERIF, fontStyle: 'italic', fontSize: 16,
          }}>
            — no samples yet —
          </div>
        )}
        {groups.map(([group, list]) => (
          <div key={group}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              padding: '14px 22px 6px',
              fontFamily: SANS, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase', color: ED_DIM,
              borderTop: `1px solid ${ED_RULE}`,
              background: ED_BG,
            }}>
              <span style={{ color: ED_INK }}>{group}</span>
              <span>{list.length} {list.length === 1 ? 'piece' : 'pieces'}</span>
            </div>
            {list.map((it, i) => {
              const active = currentId === it.id;
              return (
                <div key={it.id} onClick={() => onOpen(it)} style={{
                  display: 'grid', gridTemplateColumns: '24px 1fr 56px',
                  alignItems: 'baseline', padding: '11px 22px',
                  borderBottom: `1px solid ${ED_RULE}`,
                  background: active ? ED_SOFT : 'transparent',
                  cursor: 'pointer',
                  gap: 10,
                }}>
                  <span style={{ fontFamily: SANS, fontSize: 10, color: ED_DIM, letterSpacing: 1 }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontFamily: SERIF, fontSize: 18, color: active ? ED_ACC : ED_INK, lineHeight: 1.1,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{it.name.replace(/_/g, ' ')}</div>
                    <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase', color: ED_DIM, marginTop: 2 }}>
                      {it.cat}
                    </div>
                  </div>
                  <span style={{ fontFamily: SANS, fontSize: 11, color: ED_DIM, textAlign: 'right', letterSpacing: 0.5 }}>
                    {it.dur > 0 ? formatT(it.dur) : ''}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ── IdleEditor (no sample loaded) ─────────────────────────────────

function IdleEditor({ onStart, hasItems }: { onStart: () => void; hasItems: boolean }) {
  return (
    <Panel kicker="edit" title="Untitled" right={<>no track</>} style={{ flex: 1, minWidth: 0 }}>
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 24, padding: 40, textAlign: 'center',
      }}>
        <div style={{ fontFamily: SERIF, fontSize: 44, lineHeight: 1.1, color: ED_INK, maxWidth: 560 }}>
          Capture, trim, save.
        </div>
        <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: 17, color: ED_DIM, maxWidth: 460, lineHeight: 1.45 }}>
          Pick a Chrome tab, tick "Share tab audio", and stop when you hear something worth keeping.
        </div>
        <button onClick={onStart} style={{
          marginTop: 8,
          padding: '14px 28px', background: ED_ACC, color: ED_PAPER, border: 'none', cursor: 'pointer',
          fontFamily: SANS, fontSize: 11, letterSpacing: 2.5, textTransform: 'uppercase',
          display: 'inline-flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: ED_PAPER }} />
          record a tab
        </button>
        {hasItems && (
          <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: 14, color: ED_DIM, marginTop: 6 }}>
            — or pick a piece from the catalogue —
          </div>
        )}
      </div>
    </Panel>
  );
}

// ── Editor ────────────────────────────────────────────────────────

function Editor({
  buffer, name, displayName, trackIndex, duration,
  start, end, startFrac, endFrac, playheadFrac, onChangeFrac,
  playing, looping, onPlay, onStop, onToggleLoop,
  canUndo, onUndo, canRedo, onRedo,
  folders, onRequestNewFolder,
  category, setCategory, setName,
  onSave, onCancel, isUpdate,
}: {
  buffer: AudioBuffer;
  name: string;
  displayName: string;
  trackIndex: number | null;
  duration: number;
  start: number; end: number;
  startFrac: number; endFrac: number; playheadFrac: number | null;
  onChangeFrac: (s: number, e: number) => void;
  playing: boolean; looping: boolean;
  onPlay: () => void; onStop: () => void; onToggleLoop: () => void;
  canUndo: boolean; onUndo: () => void;
  canRedo: boolean; onRedo: () => void;
  folders: string[]; onRequestNewFolder: () => void;
  category: string; setCategory: (c: string) => void;
  setName: (n: string) => void;
  onSave: () => void; onCancel: () => void; isUpdate: boolean;
}) {
  const cropSec = end - start;
  const titleText = displayName.replace(/_/g, ' ') || 'untitled';
  const trackLabel = trackIndex != null
    ? `track ${String(trackIndex).padStart(2, '0')} · ${formatT(duration)}`
    : `untitled · ${formatT(duration)}`;

  return (
    <Panel kicker="edit" title={titleText} right={<>{trackLabel}</>} style={{ flex: 1, minWidth: 0 }}>
      <div style={{
        padding: 24, display: 'flex', flexDirection: 'column', gap: 22, flex: 1,
        minHeight: 0, overflow: 'auto',
      }}>
        {/* Waveform */}
        <Waveform
          buffer={buffer}
          startFrac={startFrac} endFrac={endFrac}
          playheadFrac={playheadFrac}
          onChangeFrac={onChangeFrac}
          duration={duration}
        />

        {/* Range readout */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24,
          padding: '20px 0 0', borderTop: `1px solid ${ED_RULE}`,
        }}>
          {([
            ['in', formatT(start), false],
            ['out', formatT(end), false],
            ['crop', formatT(cropSec), true],
            ['total', formatT(duration), false],
          ] as const).map(([k, v, accent]) => (
            <div key={k}>
              <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase', color: ED_DIM }}>{k}</div>
              <div style={{
                fontFamily: SERIF, fontSize: 30, color: accent ? ED_ACC : ED_INK,
                lineHeight: 1, marginTop: 4,
              }}>{v}</div>
            </div>
          ))}
        </div>

        {/* Transport */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          fontFamily: SANS, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
        }}>
          <TransportButton primary onClick={onPlay} disabled={playing}>▶ play</TransportButton>
          <TransportButton onClick={onStop} disabled={!playing}>■ stop</TransportButton>
          <TransportButton onClick={onToggleLoop} active={looping}>↻ loop {looping ? 'on' : 'off'}</TransportButton>
          <span style={{ width: 1, height: 22, background: ED_RULE }} />
          <TransportButton ghost onClick={onUndo} disabled={!canUndo}>↺ undo</TransportButton>
          <TransportButton ghost onClick={onRedo} disabled={!canRedo}>↻ redo</TransportButton>
          <div style={{ flex: 1 }} />
          <span style={{ color: ED_DIM, fontStyle: 'italic', fontFamily: SERIF, fontSize: 14, textTransform: 'none', letterSpacing: 0 }}>
            space = play · stop
          </span>
        </div>

        {/* Save panel */}
        <div style={{ paddingTop: 22, borderTop: `1px solid ${ED_RULE}` }}>
          <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase', color: ED_DIM, marginBottom: 10 }}>
            save sample
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 18, alignItems: 'end' }}>
            <div>
              <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: ED_DIM, marginBottom: 6 }}>folder</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {folders.map(f => (
                  <FolderChip key={f} label={f} active={category === f} onClick={() => setCategory(f)} />
                ))}
                <FolderChip label="+ new" dashed onClick={onRequestNewFolder} />
              </div>

              <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: ED_DIM, marginBottom: 6 }}>name</div>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') onSave(); }}
                placeholder={`${category}_01`}
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: `1px solid ${ED_INK}`,
                  padding: '6px 0',
                  fontFamily: SERIF, fontSize: 22, color: ED_INK,
                  outline: 'none',
                }}
              />
              <div style={{ fontFamily: SANS, fontSize: 10, color: ED_DIM, marginTop: 8, letterSpacing: 0.5 }}>
                → samples / {category} / {cleanNamePreview(name) || category + '_xx'}.wav
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={onCancel} style={{
                padding: '14px 22px', background: 'transparent', color: ED_INK,
                border: `1px solid ${ED_RULE}`,
                fontFamily: SANS, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
                cursor: 'pointer',
              }}>cancel</button>
              <button onClick={onSave} style={{
                padding: '14px 28px', background: ED_INK, color: ED_PAPER, border: 'none',
                fontFamily: SANS, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
                cursor: 'pointer',
              }}>{isUpdate ? 'update ↗' : 'save ↗'}</button>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function TransportButton({
  children, onClick, disabled, primary, active, ghost,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
  active?: boolean;
  ghost?: boolean;
}) {
  let bg = 'transparent', color = ED_INK, border = `1px solid ${ED_RULE}`;
  if (active) { bg = ED_INK; color = ED_PAPER; border = `1px solid ${ED_INK}`; }
  else if (primary) { bg = ED_INK; color = ED_PAPER; border = 'none'; }
  if (ghost) { border = 'none'; color = ED_DIM; }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: ghost ? '12px 4px' : '12px 22px',
        background: disabled && !ghost ? 'transparent' : bg,
        color: disabled ? ED_DIM : color,
        border, cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
        opacity: disabled && ghost ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

// ── Recording ─────────────────────────────────────────────────────

function Recording({
  elapsed, analyser, onStop, onCancel,
}: {
  elapsed: number;
  analyser: AnalyserNode | null;
  onStop: () => void;
  onCancel: () => void;
}) {
  return (
    <Panel kicker="recording" title="Capturing tab audio"
      right={<><span style={{ color: ED_ACC }}>●</span> live</>}
      style={{ flex: 1, minWidth: 0 }}>
      <div style={{
        padding: 30, flex: 1,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 20, textAlign: 'center', minHeight: 0,
      }}>
        <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 4, textTransform: 'uppercase', color: ED_ACC }}>
          <span style={{ animation: 'recPulse 1s infinite' }}>●</span> now recording
        </div>
        <div style={{
          fontFamily: SERIF, fontSize: 'clamp(80px, 14vw, 160px)',
          lineHeight: 0.92, letterSpacing: -3, fontWeight: 500,
        }}>
          {formatRec(elapsed).main}<span style={{ color: ED_DIM }}>{formatRec(elapsed).frac}</span>
        </div>
        <div style={{ width: '70%', maxWidth: 720, padding: '0 0 6px' }}>
          <FreqBars analyser={analyser} count={48} height={120} color={ED_INK} />
        </div>
        <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: 18, color: ED_DIM }}>
          keep going, or stop when ready
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <button onClick={onStop} style={{
            padding: '14px 30px', background: ED_INK, color: ED_PAPER, border: 'none',
            fontFamily: SANS, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', cursor: 'pointer',
          }}>■ stop &amp; edit</button>
          <button onClick={onCancel} style={{
            padding: '14px 30px', background: 'transparent', color: ED_INK,
            border: `1px solid ${ED_RULE}`,
            fontFamily: SANS, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', cursor: 'pointer',
          }}>cancel</button>
        </div>
      </div>
    </Panel>
  );
}

// ── FreqBars (live analyser) ──────────────────────────────────────

function FreqBars({
  analyser, count = 48, height = 120, color = ED_INK,
}: {
  analyser: AnalyserNode | null;
  count?: number;
  height?: number;
  color?: string;
}) {
  const [bars, setBars] = useState<number[]>(Array(count).fill(0));
  useEffect(() => {
    if (!analyser) { setBars(Array(count).fill(0)); return; }
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const bins = data.length;
      const out: number[] = [];
      for (let i = 0; i < count; i++) {
        const i0 = Math.floor((i / count) * bins);
        const i1 = Math.max(i0 + 1, Math.floor(((i + 1) / count) * bins));
        let sum = 0;
        for (let j = i0; j < i1; j++) sum += data[j] ?? 0;
        out.push(sum / Math.max(1, i1 - i0) / 255);
      }
      setBars(out);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser, count]);

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', gap: 3, height, width: '100%',
    }}>
      {bars.map((v, i) => (
        <span key={i} style={{
          flex: 1, height: `${Math.max(3, v * 100)}%`, background: color,
        }} />
      ))}
    </div>
  );
}

// ── Waveform ──────────────────────────────────────────────────────

function Waveform({
  buffer, startFrac, endFrac, playheadFrac, onChangeFrac, duration,
}: {
  buffer: AudioBuffer;
  startFrac: number; endFrac: number; playheadFrac: number | null;
  onChangeFrac: (s: number, e: number) => void;
  duration: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(700);
  const height = 240;
  const drag = useRef<{ kind: 'start' | 'end' | 'move' | null; grab?: number }>({ kind: null });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const peaks = useMemo(() => computePeaksAbs(buffer, 200), [buffer]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(w * dpr); cv.height = Math.floor(height * dpr);
    cv.style.width = w + 'px';
    cv.style.height = height + 'px';
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background paper
    ctx.fillStyle = ED_PAPER;
    ctx.fillRect(0, 0, w, height);

    const xs = startFrac * w;
    const xe = endFrac * w;

    // Centerline
    ctx.fillStyle = ED_RULE;
    ctx.fillRect(0, Math.floor(height / 2), w, 1);

    // Wave bars
    const n = peaks.length;
    const step = w / n;
    const barW = Math.max(1, step - 1);
    for (let i = 0; i < n; i++) {
      const v = peaks[i] ?? 0;
      const bh = Math.max(1, Math.floor(v * (height * 0.85)));
      const bx = i * step;
      const inSel = bx >= xs && bx <= xe;
      ctx.fillStyle = inSel ? ED_INK : ED_DIM;
      ctx.fillRect(bx, Math.floor((height - bh) / 2), barW, bh);
    }

    // Selection vertical markers (orange)
    ctx.fillStyle = ED_ACC;
    ctx.fillRect(Math.floor(xs), 0, 1, height);
    ctx.fillRect(Math.floor(xe), 0, 1, height);

    // Handle caps
    ctx.fillRect(Math.floor(xs) - 3, 0, 7, 4);
    ctx.fillRect(Math.floor(xs) - 3, height - 4, 7, 4);
    ctx.fillRect(Math.floor(xe) - 3, 0, 7, 4);
    ctx.fillRect(Math.floor(xe) - 3, height - 4, 7, 4);

    // Playhead
    if (playheadFrac != null && playheadFrac >= startFrac && playheadFrac <= endFrac) {
      const px = Math.floor(playheadFrac * w);
      ctx.fillStyle = ED_INK;
      ctx.fillRect(px, 0, 1, height);
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

  // Time ticks below waveform
  const ticks = 5;
  const tickValues = Array.from({ length: ticks }, (_, i) => (duration * i) / (ticks - 1));

  return (
    <div ref={wrapRef} style={{ position: 'relative', minHeight: height + 30 }}>
      {/* IN / OUT labels above */}
      <div style={{ position: 'relative', height: 18 }}>
        <div style={{
          position: 'absolute', bottom: 0, left: `${startFrac * 100}%`,
          transform: 'translateX(-50%)',
          fontFamily: SANS, fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: ED_ACC,
          pointerEvents: 'none',
        }}>in</div>
        <div style={{
          position: 'absolute', bottom: 0, left: `${endFrac * 100}%`,
          transform: 'translateX(-50%)',
          fontFamily: SANS, fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: ED_ACC,
          pointerEvents: 'none',
        }}>out</div>
      </div>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: 'ew-resize', width: '100%' }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
      />
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontFamily: SANS, fontSize: 9, color: ED_DIM, letterSpacing: 1,
        marginTop: 6,
      }}>
        {tickValues.map((t, i) => <span key={i}>{formatT(t)}</span>)}
      </div>
    </div>
  );
}

// ── AlertBox / PromptBox modals ───────────────────────────────────

function AlertBox({ msg, onOk }: { msg: string; onOk: () => void }) {
  return (
    <ModalShell>
      <div style={{ padding: '24px 26px 14px' }}>
        <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase', color: ED_DIM, marginBottom: 6 }}>
          collector
        </div>
        <div style={{
          fontFamily: SERIF, fontSize: 20, lineHeight: 1.3, color: ED_INK, whiteSpace: 'pre-wrap',
        }}>{msg}</div>
      </div>
      <div style={{
        padding: '14px 26px 22px', display: 'flex', justifyContent: 'flex-end',
        borderTop: `1px solid ${ED_RULE}`,
      }}>
        <button onClick={onOk} style={{
          padding: '12px 26px', background: ED_INK, color: ED_PAPER, border: 'none', cursor: 'pointer',
          fontFamily: SANS, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
        }}>ok</button>
      </div>
    </ModalShell>
  );
}

function PromptBox({ msg, onConfirm, onCancel }: {
  msg: string; onConfirm: (v: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  return (
    <ModalShell>
      <div style={{ padding: '24px 26px 14px' }}>
        <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase', color: ED_DIM, marginBottom: 6 }}>
          new folder
        </div>
        <div style={{ fontFamily: SERIF, fontSize: 20, lineHeight: 1.3, color: ED_INK, marginBottom: 14 }}>{msg}</div>
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && value.trim()) onConfirm(value);
            if (e.key === 'Escape') onCancel();
          }}
          style={{
            width: '100%',
            background: 'transparent',
            border: 'none', borderBottom: `1px solid ${ED_INK}`,
            padding: '6px 0',
            fontFamily: SERIF, fontSize: 22, color: ED_INK,
            outline: 'none',
          }}
        />
      </div>
      <div style={{
        padding: '14px 26px 22px', display: 'flex', justifyContent: 'flex-end', gap: 10,
        borderTop: `1px solid ${ED_RULE}`,
      }}>
        <button onClick={onCancel} style={{
          padding: '12px 22px', background: 'transparent', color: ED_INK, border: `1px solid ${ED_RULE}`,
          fontFamily: SANS, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', cursor: 'pointer',
        }}>cancel</button>
        <button onClick={() => value.trim() && onConfirm(value)} style={{
          padding: '12px 26px', background: ED_INK, color: ED_PAPER, border: 'none', cursor: 'pointer',
          fontFamily: SANS, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
        }}>ok</button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(24, 22, 19, 0.25)', zIndex: 100,
    }}>
      <div style={{
        minWidth: 340, maxWidth: 480, background: ED_PAPER,
        border: `1px solid ${ED_RULE}`,
        boxShadow: '0 12px 40px rgba(0,0,0,0.12)',
      }}>
        {children}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

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

function formatRec(s: number): { main: string; frac: string } {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return {
    main: `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`,
    frac: `.${String(cs).padStart(2, '0')}`,
  };
}
