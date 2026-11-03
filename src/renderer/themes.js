'use strict';
// Color themes and corner styles. Each theme becomes a set of CSS variables.
// Styles are inspired by community themes for the Windows 11 Taskbar Styler mod.

// On a Mac the launcher dresses like macOS: San Francisco type, glass panels, system blue.
window.IS_MAC = /Mac/i.test(navigator.platform || '') || /Macintosh/.test(navigator.userAgent || '');
if (window.IS_MAC) document.documentElement.classList.add('mac');

window.THEMES = [
  {
    id: 'macos', name: 'macOS Dark', desc: 'Glass panels and system blue · the Mac default', mac: true,
    bg: '#0B0B10', hero1: '#1A2B4C', hero2: '#3B2D6B', accent: '#0A84FF', onAccent: '#FFFFFF',
    panel: 'rgba(255,255,255,0.08)', panelSolid: '#1C1C21', panelHover: 'rgba(255,255,255,0.14)', chip: 'rgba(255,255,255,0.10)', border: 'rgba(255,255,255,0.10)', blur: 'blur(30px) saturate(180%)',
    text: '#F5F5F7', sub: '#98989F', sidebar: 'rgba(22,22,28,0.72)', field: 'rgba(0,0,0,0.28)', fieldBorder: 'rgba(255,255,255,0.12)',
    tiles: ['#1F4E8C', '#55408C', '#2C6A4E', '#8A5A2C', '#2A687E', '#86344F', '#4A4E5A', '#6A4F9E'], light: false
  },
  {
    id: 'macoslight', name: 'macOS Light', desc: 'Bright glass, like a Mac in Light mode', mac: true,
    bg: '#F2F2F7', hero1: '#D9E4F7', hero2: '#E6DBF4', accent: '#007AFF', onAccent: '#FFFFFF',
    panel: 'rgba(255,255,255,0.70)', panelSolid: '#FFFFFF', panelHover: 'rgba(255,255,255,0.92)', chip: 'rgba(0,0,0,0.05)', border: 'rgba(0,0,0,0.08)', blur: 'blur(30px) saturate(180%)',
    text: '#1D1D1F', sub: '#6E6E73', sidebar: 'rgba(246,246,248,0.80)', field: '#FFFFFF', fieldBorder: 'rgba(0,0,0,0.12)',
    tiles: ['#5E8FD6', '#957ACC', '#5FA57F', '#D0975A', '#58A3BF', '#CD6984', '#8C91A0', '#7C69C0'], light: true
  },
  {
    id: 'original', name: 'Original', desc: 'Navy with amber · the default',
    bg: '#0A0D12', hero1: '#1F3346', hero2: '#2A4A62', accent: '#F2A33A', onAccent: '#0A0D12',
    panel: '#1B2632', panelSolid: '#1B2632', panelHover: '#243241', chip: '#2A3846', border: 'transparent', blur: 'none',
    text: '#F3F5F8', sub: '#A9B4C0', sidebar: '#10161E', field: '#0E141B', fieldBorder: '#2A3644',
    tiles: ['#2E4A5E', '#5A3E66', '#3C5A3A', '#6B4A2E', '#2F4F6B', '#6A2F3D', '#465060', '#2E5B5B'], light: false
  },
  {
    id: 'frosted', name: 'Frosted Glass', desc: 'See-through blurred panels over cool blue',
    bg: '#0F1A2A', hero1: '#1E3A5F', hero2: '#3B6E9E', accent: '#9FD3FF', onAccent: '#0B1624',
    panel: 'rgba(255,255,255,0.10)', panelSolid: '#1A2B40', panelHover: 'rgba(255,255,255,0.16)', chip: 'rgba(255,255,255,0.14)', border: 'rgba(255,255,255,0.20)', blur: 'blur(16px)',
    text: '#F4F8FC', sub: '#C3D2E2', sidebar: 'rgba(10,20,34,0.75)', field: 'rgba(0,0,0,0.25)', fieldBorder: 'rgba(255,255,255,0.22)',
    tiles: ['#2B4D74', '#3E6C8F', '#5A7FA8', '#2F5A6B', '#45618A', '#36567A', '#4C7396', '#2A4660'], light: false
  },
  {
    id: 'rosepine', name: 'Rosé Pine', desc: 'Soft muted purples with rose and gold',
    bg: '#191724', hero1: '#1f1d2e', hero2: '#26233a', accent: '#ebbcba', onAccent: '#191724',
    panel: '#1f1d2e', panelSolid: '#1f1d2e', panelHover: '#26233a', chip: '#26233a', border: '#26233a', blur: 'none',
    text: '#e0def4', sub: '#a29fbd', sidebar: '#1f1d2e', field: '#191724', fieldBorder: '#403d52',
    tiles: ['#31748f', '#7d6aa3', '#a8536c', '#a8835a', '#4f8a92', '#524f67', '#3f6f8a', '#8a6fae'], light: false
  },
  {
    id: 'xdark', name: 'xDark', desc: 'True black, made for OLED TVs',
    bg: '#000000', hero1: '#0D0D0D', hero2: '#1A1A1A', accent: '#FFFFFF', onAccent: '#000000',
    panel: '#111111', panelSolid: '#111111', panelHover: '#1C1C1C', chip: '#1C1C1C', border: '#262626', blur: 'none',
    text: '#FFFFFF', sub: '#A0A0A0', sidebar: '#0A0A0A', field: '#000000', fieldBorder: '#333333',
    tiles: ['#262626', '#333333', '#1F1F1F', '#3D3D3D', '#2B2B2B', '#353535', '#222222', '#2F2F2F'], light: false
  },
  {
    id: 'tinted', name: 'Tinted Glass', desc: 'Glass panels tinted with the accent color',
    bg: '#160F22', hero1: '#2A1A44', hero2: '#4A2F73', accent: '#C79BFF', onAccent: '#160F22',
    panel: 'rgba(199,155,255,0.12)', panelSolid: '#251838', panelHover: 'rgba(199,155,255,0.20)', chip: 'rgba(199,155,255,0.16)', border: 'rgba(199,155,255,0.28)', blur: 'blur(16px)',
    text: '#F5EFFF', sub: '#CDBFE3', sidebar: 'rgba(22,15,34,0.8)', field: 'rgba(0,0,0,0.25)', fieldBorder: 'rgba(199,155,255,0.3)',
    tiles: ['#3A2560', '#5B3A8A', '#6E4A9E', '#43306B', '#7A5AAE', '#4F3580', '#352254', '#62449A'], light: false
  },
  {
    id: 'cleanslate', name: 'Clean Slate', desc: 'Bright and light, for daytime rooms',
    bg: '#EEF1F4', hero1: '#DCE3EA', hero2: '#C8D3DE', accent: '#2F5E96', onAccent: '#FFFFFF',
    panel: '#FFFFFF', panelSolid: '#FFFFFF', panelHover: '#F4F7FA', chip: '#E3E8EE', border: '#D5DCE3', blur: 'none',
    text: '#12161B', sub: '#4D5966', sidebar: '#E4E9EE', field: '#FFFFFF', fieldBorder: '#C3CCD6',
    tiles: ['#5F7C9A', '#7A6A91', '#5E8466', '#93775A', '#5B7F8E', '#6F7885', '#64759B', '#8C6F69'], light: true
  }
];

window.CORNERS = [
  { id: 'rounded', name: 'Rounded', tile: '8px', card: '10px', pill: '999px', box: '10px' },
  { id: 'squircle', name: 'Squircle', tile: '22px', card: '20px', pill: '14px', box: '20px' },
  { id: 'sharp', name: 'Sharp', tile: '0px', card: '0px', pill: '0px', box: '0px' }
];

window.ACCENTS = ['#F2A33A', '#FF7A45', '#E2506B', '#FF5FA2', '#C46BFF', '#8B7CFF', '#4F6BFF', '#4FA3FF', '#2EC4E6', '#2FD6B5', '#3CC48A', '#7FD13B', '#E5D04A', '#C9A27A', '#B0B8C4', '#FFFFFF'];

// Black or white text, whichever reads better on a color.
window.textOn = function (hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#000000';
  const n = parseInt(m[1], 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#0A0D12' : '#FFFFFF';
};

window.applyTheme = function (settings, animate) {
  const fallback = window.THEMES.find((x) => x.id === (window.IS_MAC ? 'macos' : 'original'));
  const t = window.THEMES.find((x) => x.id === settings.theme && (!x.mac || window.IS_MAC)) || fallback;
  const c = window.CORNERS.find((x) => x.id === settings.corners) || window.CORNERS[0];
  const accent = settings.accent || t.accent;
  const onAccent = settings.accent ? window.textOn(settings.accent) : t.onAccent;
  const root = document.documentElement;
  if (animate && !settings.reduceMotion) {
    root.classList.add('theming');
    clearTimeout(window.__themingTimer);
    window.__themingTimer = setTimeout(() => root.classList.remove('theming'), 600);
  }
  const vars = {
    '--bg': t.bg, '--hero1': t.hero1, '--hero2': t.hero2, '--accent': accent, '--on-accent': onAccent,
    '--panel': t.panel, '--panel-solid': t.panelSolid, '--panel-hover': t.panelHover, '--chip': t.chip,
    '--border': t.border, '--blur': t.blur, '--text': t.text, '--sub': t.sub, '--sidebar': t.sidebar,
    '--field': t.field, '--field-border': t.fieldBorder,
    '--r-tile': c.tile, '--r-card': c.card, '--r-pill': c.pill, '--r-box': c.box
  };
  for (const k of Object.keys(vars)) root.style.setProperty(k, vars[k]);
  root.classList.toggle('light', !!t.light);
  root.classList.toggle('reduce-motion', !!settings.reduceMotion);
  return t;
};
