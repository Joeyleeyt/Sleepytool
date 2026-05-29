export const r2Paths = {
  shotVideo: (projectId: string, shotId: string, hash: string) =>
    `${projectId}/shots/${shotId}/video/${hash}.mp4`,
  shotImage: (projectId: string, shotId: string, hash: string) =>
    `${projectId}/shots/${shotId}/image/${hash}.png`,
  shotNarration: (projectId: string, shotId: string, hash: string) =>
    `${projectId}/shots/${shotId}/narration/${hash}.wav`,
  musicBed: (projectId: string, key: string) => `${projectId}/music/${key}.mp3`,
  subtitles: (projectId: string) => `${projectId}/subtitles/master.ass`,
  finalRender: (projectId: string, version: number) =>
    `${projectId}/renders/final_v${version}.mp4`,
};
