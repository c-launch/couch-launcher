'use strict';
// Medal clips: Medal (medal.tv) saves every clip as a video file in its capture folder,
// C:\Medal by default (changeable in Medal's settings). This finds that folder and lists the
// clips, newest first, grouped by the game folder Medal puts them in.

const fs = require('fs');
const path = require('path');

const VIDEO = /\.(mp4|mkv|webm|mov)$/i;
const IMAGE = /\.(png|jpe?g)$/i;
const SKIP = /^(edits?|temp|tmp|cache|thumbnails?|\.)/i;

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch (_) { return false; } };
const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return []; } };

// Medal's capture folder: your choice in the launcher, Medal's own setting if it can be read,
// then the usual spots.
function findMedalFolders(env, chosen) {
  env = env || process.env;
  const out = [];
  const add = (p) => { if (p && exists(p) && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p); };
  if (chosen) add(chosen);
  // Medal keeps its settings as small JSON files under AppData; look for a saved folder path.
  for (const base of [path.join(env.APPDATA || '', 'Medal'), path.join(env.LOCALAPPDATA || '', 'Medal')]) {
    const stack = [[base, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      for (const ent of listDir(d)) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory() && depth < 2 && !/cache|logs|crash|gpu|blob|code/i.test(ent.name)) stack.push([full, depth + 1]);
        else if (ent.isFile() && /\.json$/i.test(ent.name)) {
          try {
            if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
            const text = fs.readFileSync(full, 'utf8');
            const re = /"(?:clipFolder|clipsFolder|clipDirectory|captureFolder|capturePath|clipPath|recordingPath|recordingsFolder|outputFolder|saveLocation)"\s*:\s*"((?:[^"\\]|\\.)+)"/gi;
            let m;
            while ((m = re.exec(text))) add(m[1].replace(/\\\\/g, '\\'));
          } catch (_) { /* skip */ }
        }
      }
    }
  }
  for (const d of 'CDEFGH') add(d + ':\\Medal');
  add(path.join(env.USERPROFILE || '', 'Videos', 'Medal'));
  return out;
}

// [{ file, game, at, size, kind: 'clip' | 'shot' }]
function listClips(folder, limit) {
  const out = [];
  (function walk(dir, depth, game) {
    if (depth > 4 || out.length > 5000) return;
    for (const ent of listDir(dir)) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP.test(ent.name)) continue;
        // Medal sorts clips into a folder per game (under Clips / Screenshots).
        const isGroup = /^(clips|screenshots|recordings|videos|medal)$/i.test(ent.name);
        walk(full, depth + 1, isGroup ? game : ent.name);
      } else if (ent.isFile() && (VIDEO.test(ent.name) || IMAGE.test(ent.name))) {
        let st;
        try { st = fs.statSync(full); } catch (_) { continue; }
        if (st.size < 20 * 1024) continue; // unfinished / thumbnails
        out.push({ file: full, game: game || 'Clips', at: st.mtimeMs, size: st.size, kind: VIDEO.test(ent.name) ? 'clip' : 'shot' });
      }
    }
  })(folder, 0, null);
  return out.sort((a, b) => b.at - a.at).slice(0, limit || 400);
}

module.exports = { findMedalFolders, listClips };
