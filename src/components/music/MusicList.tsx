/**
 * MusicList — 歌单页组件。
 * 从配置的 openlist（Alist）目录递归读取音频文件，
 * 用 music-metadata 解析内嵌元数据（标题/创作者/封面/歌词，Range 分段请求 + localStorage 缓存），
 * 注册到 meting.ts 的直链元数据表，喂给主题自带 AudioPlayer 播放。
 * 数据源由 site.yaml 的 music 段配置（openlistOrigin / path）。
 */

import { AudioPlayer } from '@components/markdown/AudioPlayer';
import { registerDirectMetadata } from '@lib/meting';
import { parseWebStream } from 'music-metadata';
import { useEffect, useState } from 'react';

const AUDIO_EXT = /\.(mp3|flac|ogg|oga|m4a|aac|wav|opus)$/i;
/** 只拉取文件头部区间即可覆盖 ID3v2/Vorbis/FLAC 块/MP4 moov 等标签区（skipPostHeaders 免读文件尾） */
const META_RANGE_BYTES = 2 * 1024 * 1024;
/** 元数据解析并发上限 */
const PARSE_CONCURRENCY = 3;
const CACHE_PREFIX = 'openlist-meta-v1:';

interface AlistEntry {
  name: string;
  is_dir: boolean;
  size?: number;
  modified?: string;
}

interface AudioGroup {
  title?: string;
  list: string[];
}

interface SongMeta {
  name: string;
  artist: string;
  pic: string;
  lrc: string;
}

async function listDir(origin: string, path: string, page: number): Promise<AlistEntry[]> {
  const res = await fetch(`${origin}/api/fs/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, password: '', page, per_page: 100, refresh: false }),
  });
  if (!res.ok) throw new Error(`openlist HTTP ${res.status}`);
  const data: { code: number; message?: string; data?: { content: AlistEntry[] } } = await res.json();
  if (data.code !== 200) throw new Error(data.message ?? 'openlist error');
  return data.data?.content ?? [];
}

async function listAll(origin: string, path: string): Promise<AlistEntry[]> {
  const entries: AlistEntry[] = [];
  for (let page = 1; ; page++) {
    const batch = await listDir(origin, path, page);
    entries.push(...batch);
    if (batch.length < 100) break;
  }
  return entries;
}

function fileUrl(origin: string, path: string): string {
  return `${origin}/d/${path.split('/').map(encodeURIComponent).join('/')}`;
}

interface SongEntry {
  path: string;
  url: string;
  size: number;
  modified: string;
}

function u8ToBase64(u8: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function collectSongs(origin: string, dirPath: string, out: SongEntry[]): Promise<void> {
  const entries = await listAll(origin, dirPath);
  for (const f of entries) {
    if (f.is_dir) {
      await collectSongs(origin, `${dirPath}/${f.name}`, out);
    } else if (AUDIO_EXT.test(f.name)) {
      out.push({
        path: `${dirPath}/${f.name}`,
        url: fileUrl(origin, `${dirPath}/${f.name}`),
        size: f.size ?? 0,
        modified: f.modified ?? '',
      });
    }
  }
}

function readCache(key: string): SongMeta | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as SongMeta) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, meta: SongMeta): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(meta));
  } catch {
    // 存储满/不可用 — 非关键，跳过
  }
}

/** Range 拉取文件头部 + music-metadata 解析 → 标题/创作者/封面/歌词 */
async function parseSongMeta(song: SongEntry): Promise<SongMeta> {
  const cacheKey = `${song.path}|${song.modified}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const rangeEnd = song.size > 0 ? Math.min(song.size - 1, META_RANGE_BYTES - 1) : META_RANGE_BYTES - 1;
  const res = await fetch(song.url, { headers: { Range: `bytes=0-${rangeEnd}` } });
  if (!res.ok && res.status !== 206) throw new Error(`fetch ${res.status}`);
  if (!res.body) throw new Error('no body');

  const metadata = await parseWebStream(res.body, { size: song.size || undefined }, { skipPostHeaders: true });
  const common = metadata.common;
  const picture = common.picture?.[0];
  const lyrics = common.lyrics?.[0]?.text ?? '';
  // 文件名启发式回退：多数文件只嵌封面/歌词未打标题标签，按 "标题 - 创作者" 约定拆分
  const filename = decodeURIComponent(song.path.split('/').pop() ?? song.path);
  const base = filename.replace(/\.(mp3|flac|ogg|oga|m4a|aac|wav|opus)$/i, '');
  const dashIndex = base.lastIndexOf(' - ');
  const fallbackTitle = dashIndex > 0 ? base.slice(0, dashIndex) : base;
  const fallbackArtist = dashIndex > 0 ? base.slice(dashIndex + 3) : '';
  const meta: SongMeta = {
    name: common.title ?? fallbackTitle,
    artist: common.artist ?? (common.artists && common.artists.length > 0 ? common.artists.join(', ') : '') ?? fallbackArtist,
    pic: picture ? `data:${picture.format};base64,${u8ToBase64(picture.data)}` : '',
    lrc: lyrics,
  };
  writeCache(cacheKey, meta);
  return meta;
}

async function parseAllWithConcurrency(songs: SongEntry[]): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(PARSE_CONCURRENCY, songs.length) }, async () => {
    while (index < songs.length) {
      const song = songs[index++];
      try {
        const meta = await parseSongMeta(song);
        registerDirectMetadata(song.url, meta);
      } catch {
        // 单个文件解析失败不影响歌单（回退为文件名）
      }
    }
  });
  await Promise.all(workers);
}

interface MusicListProps {
  /** openlist（Alist）服务地址 */
  origin: string;
  /** 歌单目录路径 */
  path: string;
}

export default function MusicList({ origin, path }: MusicListProps) {
  const [groups, setGroups] = useState<AudioGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const songs: SongEntry[] = [];
        await collectSongs(origin, path, songs);
        if (cancelled) return;
        await parseAllWithConcurrency(songs);
        if (cancelled) return;
        const root = songs.filter((s) => !s.path.slice(path.length + 1).includes('/'));
        const subs = songs.filter((s) => s.path.slice(path.length + 1).includes('/'));
        const g: AudioGroup[] = [];
        if (root.length > 0) g.push({ title: '音乐', list: root.map((s) => s.url) });
        const subTitles = new Set(subs.map((s) => s.path.slice(path.length + 1).split('/')[0]));
        for (const title of subTitles) {
          g.push({ title, list: subs.filter((s) => s.path.startsWith(`${path}/${title}/`)).map((s) => s.url) });
        }
        if (!cancelled) setGroups(g);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [origin, path]);

  useEffect(() => {
    if (element && groups.length > 0) {
      element.dataset.src = JSON.stringify(groups);
      setReady(true);
    }
  }, [element, groups]);

  if (loading)
    return (
      <div className="audio-player audio-player-loading">
        <span>正在加载歌单…</span>
      </div>
    );
  if (error)
    return (
      <div className="audio-player audio-player-error">
        <span>歌单加载失败：{error}</span>
      </div>
    );
  if (groups.length === 0)
    return (
      <div className="audio-player audio-player-empty">
        <span>歌单为空</span>
      </div>
    );

  return (
    <div className="not-prose">
      <div ref={setElement} data-audio-player />
      {ready && element && <AudioPlayer element={element} />}
    </div>
  );
}
