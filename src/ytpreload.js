'use strict';
// Preload for the YouTube window. It runs before YouTube's own scripts and puts the ad
// blocker into the page (only on youtube.com/tv, only when turned on in Settings).
//
// The ad blocker below is adapted from VacuumTube (https://github.com/elytraVIII/VacuumTube):
// src/preload/modules/adblock.js, src/preload/util/jsonModifiers.js and
// src/preload/util/xhrModifiers.js. Changes: combined into one script that runs in the page
// itself (this window keeps Electron's isolation and sandbox on), the parts not needed for ad
// blocking were left out, and it checks the page and the setting first.
//
// ---------------------------------------------------------------------------------------------
// MIT License
//
// Copyright (c) 2025-2026 shy
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// ---------------------------------------------------------------------------------------------

// Runs inside YouTube's page (main world). Kept self-contained: it's turned into text.
function couchAdblock() {
  if (window.__couchAdblock) return;
  window.__couchAdblock = true;

  // --- JSON.parse hook (from jsonModifiers.js): edit YouTube's responses as they're read.
  const modifiers = [];
  const jsonParse = JSON.parse;
  JSON.parse = function () {
    let json = jsonParse.apply(this, arguments);
    try {
      if (json && typeof json === 'object') for (const m of modifiers) json = m(json);
    } catch (err) { console.error('a json modifier failed', err); }
    return json;
  };

  // --- XMLHttpRequest hook (from xhrModifiers.js): edit response text before the page sees it.
  const responseModifiers = [];
  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OriginalXHR();
    const originalOpen = xhr.open;
    xhr.open = function (method, url) { this._url = url; return originalOpen.apply(this, arguments); };
    function modifyResponse() {
      if (xhr.responseType !== '' && xhr.responseType !== 'text') return;
      if (xhr._modifiedAlready || xhr.readyState !== 4) return;
      xhr._modifiedAlready = true;
      let text = xhr.responseText;
      for (const m of responseModifiers) {
        try { const out = m(String(xhr._url || ''), text); if (out !== undefined) text = out; } catch (err) { console.error('an xhr response modifier failed', err); }
      }
      Object.defineProperty(xhr, 'responseText', { get() { return text; } });
      Object.defineProperty(xhr, 'response', { get() { return text; } });
    }
    let readyHandler = null, loadHandler = null;
    Object.defineProperty(xhr, 'onreadystatechange', {
      get() { return readyHandler; },
      set(handler) {
        readyHandler = function () { if (xhr.readyState === 4) modifyResponse(); return handler && handler.apply(xhr, arguments); };
        xhr.addEventListener('readystatechange', readyHandler);
      }
    });
    Object.defineProperty(xhr, 'onload', {
      get() { return loadHandler; },
      set(handler) {
        loadHandler = function () { modifyResponse(); return handler && handler.apply(xhr, arguments); };
        xhr.addEventListener('load', loadHandler);
      }
    });
    const originalAdd = xhr.addEventListener;
    xhr.addEventListener = function (type, listener) {
      if (type === 'load' && typeof listener === 'function') {
        return originalAdd.call(this, type, function () { modifyResponse(); return listener.apply(xhr, arguments); });
      }
      return originalAdd.apply(this, arguments);
    };
    return xhr;
  };
  window.XMLHttpRequest.prototype = OriginalXHR.prototype;

  // --- The ad blocker itself (from adblock.js).
  const toPath = (url) => { try { return new URL(url, location.href).pathname; } catch (_) { return String(url); } };
  responseModifiers.push((url, text) => {
    const p = toPath(url);
    if (!p.startsWith('/youtubei/v1/browse') && !p.startsWith('/youtubei/v1/search')) return undefined;
    const json = jsonParse(text);
    if (p.startsWith('/youtubei/v1/browse')) { // home feed ads (and the big banner ad)
      const home = json.contents && json.contents.tvBrowseRenderer && json.contents.tvBrowseRenderer.content &&
        json.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer && json.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content &&
        json.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer;
      if (!home || !home.contents) return undefined;
      home.contents = home.contents.filter((r) => !r.adSlotRenderer && !r.promoShelfRenderer &&
        !(r.shelfRenderer && r.shelfRenderer.tvhtml5Metadata && r.shelfRenderer.tvhtml5Metadata.hideLogo)); // Premium upsells
      for (const feed of home.contents) {
        const h = feed && feed.shelfRenderer && feed.shelfRenderer.content && feed.shelfRenderer.content.horizontalListRenderer;
        if (h && h.items) h.items = h.items.filter((i) => !i.adSlotRenderer);
      }
    } else { // search ads
      const search = json.contents && json.contents.sectionListRenderer;
      if (!search || !search.contents) return undefined;
      for (const feed of search.contents) {
        const h = feed && feed.shelfRenderer && feed.shelfRenderer.content && feed.shelfRenderer.content.horizontalListRenderer;
        if (h && h.items) h.items = h.items.filter((i) => !i.adSlotRenderer);
      }
    }
    return JSON.stringify(json);
  });
  // video ads
  modifiers.push((json) => {
    if (json.adPlacements) json.adPlacements = [];
    if (json.adSlots) json.adSlots = [];
    return json;
  });
  // Shorts ads
  modifiers.push((json) => {
    if (Array.isArray(json.entries)) json.entries = json.entries.filter((e) => !(e && e.command && e.command.reelWatchEndpoint && e.command.reelWatchEndpoint.adClientParams && e.command.reelWatchEndpoint.adClientParams.isAd));
    return json;
  });
}

const SETUP = '(' + couchAdblock.toString() + ')();';

if (typeof require === 'function' && typeof process === 'object' && process.type === 'renderer') {
  const on = Array.isArray(process.argv) && process.argv.includes('--couch-adblock=1');
  if (on && location.host === 'www.youtube.com' && location.pathname.startsWith('/tv')) {
    try { require('electron').webFrame.executeJavaScript(SETUP); } catch (_) { /* no ad blocking this time */ }
  }
}

if (typeof module === 'object') module.exports = { couchAdblock, SETUP };
