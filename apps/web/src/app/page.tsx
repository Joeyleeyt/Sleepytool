'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Plus, Film, Upload, FileText, X } from 'lucide-react';
import { NavRail } from '@/components/layout/NavRail';
import { Button } from '@/components/primitives/Button';
import { Badge } from '@/components/primitives/Badge';
import { api } from '@/lib/api';
import { STAGE_LABELS, formatRelative } from '@/lib/utils';

export default function WorkspaceHome() {
  const [showNew, setShowNew] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects, refetchInterval: 5000 });

  return (
    <div className="h-screen flex">
      <NavRail />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-border bg-bg-subtle">
          <h1 className="font-display text-base font-semibold">Projects</h1>
          <Button variant="primary" onClick={() => setShowNew(true)}>
            <Plus size={14} /> New project
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <Skeleton />
          ) : !data || data.projects.length === 0 ? (
            <Empty onNew={() => setShowNew(true)} />
          ) : (
            <ProjectGrid projects={data.projects} />
          )}
        </div>
      </div>

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} />}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-56 rounded-card border border-border bg-bg-elev shimmer" />
      ))}
    </div>
  );
}

function Empty({ onNew }: { onNew: () => void }) {
  return (
    <div className="grid place-items-center min-h-[60vh] text-center">
      <div>
        <Film size={36} className="mx-auto text-text-faint" />
        <h2 className="mt-4 font-display text-lg">No projects yet</h2>
        <p className="mt-1 text-text-dim text-sm">Paste a transcript to make your first cinematic video.</p>
        <Button variant="primary" className="mt-5" onClick={onNew}>
          <Plus size={14} /> New project
        </Button>
      </div>
    </div>
  );
}

function ProjectGrid({ projects }: { projects: Awaited<ReturnType<typeof api.listProjects>>['projects'] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {projects.map((p) => (
        <Link
          key={p.id}
          href={`/p/${p.id}/script`}
          className="group rounded-card border border-border bg-bg-elev hover:border-border-strong transition-colors overflow-hidden"
        >
          <div className="aspect-video bg-bg-subtle grid place-items-center text-text-faint group-hover:text-text-dim">
            <Film size={28} />
          </div>
          <div className="p-3">
            <div className="text-sm font-medium truncate">{p.title}</div>
            <div className="mt-2 flex items-center justify-between">
              <Badge tone={p.status === 'published' ? 'ok' : p.status === 'failed' ? 'bad' : p.status === 'ingested' ? 'neutral' : 'busy'}>
                {STAGE_LABELS[p.status] ?? p.status}
              </Badge>
              <span className="text-[11px] text-text-faint">{formatRelative(p.updatedAt)}</span>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

// Strip cue numbers + timestamp lines from SubRip / WebVTT transcripts so the
// LLM sees plain prose instead of `00:00:12,440 --> 00:00:15,200`. Leaves
// other text files untouched.
//
// Detection is filename-only — content sniffing on `-->` falsely matched plain
// prose with em-dash arrows (`Then -->`) and stripped standalone-number lines
// like "1942".
function cleanSubtitleText(raw: string, filename: string): string {
  if (!/\.(srt|vtt)$/i.test(filename)) return raw;
  return raw
    // Drop a leading BOM and the WEBVTT header (with optional kind/lang).
    .replace(/^﻿/, '')
    .replace(/^WEBVTT.*$/im, '')
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (/^\d+$/.test(t)) return false;                  // cue numbers
      if (/-->/.test(line)) return false;                 // timestamp lines
      if (/^(NOTE|STYLE)\b/.test(line)) return false;     // VTT metadata
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState('');
  const [transcript, setTranscript] = useState('');
  const [uploadedFile, setUploadedFile] = useState<{ name: string; size: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createProject({ title: title || `Untitled ${new Date().toLocaleString()}`, transcript }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      router.push(`/p/${res.projectId}/board`);
    },
  });

  const handleFile = async (file: File) => {
    setUploadError(null);
    // 5 MB ceiling — a 2hr narration transcript is ~50 KB. Anything bigger is
    // almost certainly the wrong file (audio, video, .docx).
    if (file.size > 5 * 1024 * 1024) {
      setUploadError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 5 MB.`);
      return;
    }
    try {
      const raw = await file.text();
      const cleaned = cleanSubtitleText(raw, file.name);
      if (cleaned.trim().length < 100) {
        setUploadError('File is empty or too short (need at least 100 characters).');
        return;
      }
      setTranscript(cleaned);
      setUploadedFile({ name: file.name, size: file.size });
      if (!title) {
        // Seed title from filename (strip extension) so the user doesn't have
        // to type one. They can still edit it.
        setTitle(file.name.replace(/\.[^.]+$/, '').slice(0, 80));
      }
    } catch (err) {
      setUploadError(`Could not read file: ${(err as Error).message}`);
    }
  };

  const clearFile = () => {
    setTranscript('');
    setUploadedFile(null);
    setUploadError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const wordCount = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;
  const estMin = Math.round((wordCount / 150) * 10) / 10;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-bg-elev border border-border rounded-card overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border">
          <h2 className="font-display text-lg font-semibold">New project</h2>
          <p className="text-sm text-text-dim mt-1">Paste a transcript or upload a .txt / .md / .srt / .vtt file. EmberForge will segment, generate, and render automatically.</p>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-text-dim">Title</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Cosmic Origins"
              className="mt-1 w-full bg-bg border border-border rounded-md px-3 h-9 text-sm focus:outline-none focus:border-ember-500"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-text-dim">Transcript</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.markdown,.srt,.vtt,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                }}
              />
              {uploadedFile ? (
                <button
                  type="button"
                  onClick={clearFile}
                  className="text-[11px] text-text-dim hover:text-text flex items-center gap-1"
                >
                  <X size={11} /> Clear
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-[11px] text-text-dim hover:text-text flex items-center gap-1"
                >
                  <Upload size={11} /> Upload file
                </button>
              )}
            </div>
            {uploadedFile && (
              <div className="mb-2 flex items-center gap-2 text-[11px] bg-bg-subtle border border-border rounded px-2 py-1.5">
                <FileText size={12} className="text-text-dim" />
                <span className="text-text font-mono truncate flex-1">{uploadedFile.name}</span>
                <span className="text-text-faint tabular-nums">{(uploadedFile.size / 1024).toFixed(1)} KB</span>
              </div>
            )}
            {uploadError && (
              <div className="mb-2 text-[11px] text-bad">{uploadError}</div>
            )}
            <textarea
              value={transcript}
              onChange={(e) => {
                setTranscript(e.target.value);
                // If the user edits after uploading, drop the file badge —
                // the content no longer matches the source file.
                if (uploadedFile) setUploadedFile(null);
              }}
              placeholder="In the cold silence before the first dawn..."
              rows={12}
              className="w-full bg-bg border border-border rounded-md px-3 py-2 text-sm font-narration leading-relaxed focus:outline-none focus:border-ember-500"
            />
            <div className="mt-1 flex items-center justify-between text-[11px] text-text-faint tabular-nums">
              <span>{wordCount.toLocaleString()} words</span>
              <span>≈ {estMin} min of finished video</span>
            </div>
          </div>
          {create.error && <div className="text-bad text-sm">{(create.error as Error).message}</div>}
        </div>
        <div className="p-5 border-t border-border flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending || transcript.trim().length < 100}>
            {create.isPending ? 'Creating…' : 'Start generating'}
          </Button>
        </div>
      </div>
    </div>
  );
}
