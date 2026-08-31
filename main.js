'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');

const FENCE = '`' + '`' + '`';
const BLOCK_LANGUAGES = ['youtube', 'yt'];

const DEFAULT_SETTINGS = {
  convertOnPaste: true,     // pasting a YouTube link inserts the player
  insertMode: 'block',      // 'block' = ```youtube fence  |  'native' = ![](url)
  storeMetadata: true,      // write the title and channel into the note itself
  showTitle: true,          // header bar with the video title
  privacyMode: false,       // play from youtube-nocookie.com
  keepTimestamp: true,      // honour the ?t= of the pasted link
  titleCache: {}            // { videoId: { title, author } }
};

/* ------------------------------------------------------------------ */
/* URL parsing                                                         */
/* ------------------------------------------------------------------ */

const YOUTUBE_HOSTS = [
  'youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'youtu.be'
];

/** Accepts "90", "90s", "1m30s", "1h2m3s" and returns seconds. */
function parseTimestamp(value) {
  if (!value) return 0;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
  if (!match) return 0;
  return (+(match[1] || 0)) * 3600 + (+(match[2] || 0)) * 60 + (+(match[3] || 0));
}

/** Returns { videoId, list, start, kind, url } or null when it is not a YouTube link. */
function parseYouTubeUrl(input) {
  if (!input) return null;

  let url;
  try {
    url = new URL(String(input).trim());
  } catch (error) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (!YOUTUBE_HOSTS.includes(host)) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  let videoId = null;
  let kind = 'video';

  if (host === 'youtu.be') {
    videoId = segments[0] || null;
  } else if (segments[0] === 'watch') {
    videoId = url.searchParams.get('v');
  } else if (segments[0] === 'shorts') {
    videoId = segments[1] || null;
    kind = 'short';
  } else if (segments[0] === 'live' || segments[0] === 'embed' || segments[0] === 'v') {
    videoId = segments[1] || null;
  }

  const list = url.searchParams.get('list');

  if (videoId && !/^[A-Za-z0-9_-]{11}$/.test(videoId)) videoId = null;
  if (!videoId && !list) return null;
  if (!videoId && list) kind = 'playlist';

  const start = parseTimestamp(
    url.searchParams.get('t') ||
    url.searchParams.get('start') ||
    (url.hash || '').replace(/^#t=/, '')
  );

  return { videoId: videoId, list: list, start: start, kind: kind, url: url.href };
}

function buildPlayerUrl(video, settings) {
  const origin = settings.privacyMode
    ? 'https://www.youtube-nocookie.com/embed/'
    : 'https://www.youtube.com/embed/';

  const path = video.videoId ? video.videoId : 'videoseries';
  const params = new URLSearchParams();
  if (video.list) params.set('list', video.list);
  if (settings.keepTimestamp && video.start > 0) params.set('start', String(video.start));
  params.set('rel', '0');

  return origin + path + '?' + params.toString();
}

function buildWatchUrl(video) {
  if (video.videoId) {
    let url = 'https://www.youtube.com/watch?v=' + video.videoId;
    if (video.list) url += '&list=' + video.list;
    if (video.start > 0) url += '&t=' + video.start;
    return url;
  }
  return 'https://www.youtube.com/playlist?list=' + video.list;
}

/* ------------------------------------------------------------------ */
/* Block source                                                        */
/* ------------------------------------------------------------------ */

/**
 * A block is the URL on the first non-empty line, optionally followed by
 * `title:` and `channel:` lines. Unknown lines are ignored, so a block written
 * by an older version, or hand-edited, still renders.
 */
function parseBlockSource(source) {
  const lines = (source || '').split('\n');
  let url = null;
  const meta = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (url === null) {
      url = line;
      continue;
    }

    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!value) continue;
    if (key === 'title') meta.title = value;
    else if (key === 'channel') meta.channel = value;
  }

  return { url: url, meta: meta };
}

/** Keeps a value safe to sit on a single line of a fenced block. */
function sanitizeMetaValue(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

/** Keeps a value safe to sit inside the `![...]` of a native embed. */
function sanitizeAltText(value) {
  return sanitizeMetaValue(value).replace(/[\[\]|]/g, '');
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class YouTubePasteEmbedPlugin extends Plugin {

  async onload() {
    await this.loadSettings();

    // Another plugin may already own one of these languages; skip it instead
    // of failing to load.
    for (const language of BLOCK_LANGUAGES) {
      try {
        this.registerMarkdownCodeBlockProcessor(language, (source, el) => {
          this.renderPlayer(source, el);
        });
      } catch (error) {
        // language taken by another plugin
      }
    }

    this.registerEvent(
      this.app.workspace.on('editor-paste', (event, editor) => {
        if (!this.settings.convertOnPaste) return;
        if (event.defaultPrevented) return;
        if (!event.clipboardData) return;

        const text = (event.clipboardData.getData('text/plain') || '').trim();
        if (!text || /\s/.test(text)) return;
        if (!parseYouTubeUrl(text)) return;
        if (editor.somethingSelected()) return;

        event.preventDefault();
        this.insertEmbed(editor, text);
      })
    );

    this.addCommand({
      id: 'insert-from-clipboard',
      name: 'Insert embed from clipboard',
      editorCallback: async (editor) => {
        let text = '';
        try {
          text = (await navigator.clipboard.readText()).trim();
        } catch (error) {
          new Notice('Could not read the clipboard.');
          return;
        }
        if (!parseYouTubeUrl(text)) {
          new Notice('The clipboard does not contain a YouTube link.');
          return;
        }
        this.insertEmbed(editor, text);
      }
    });

    this.addCommand({
      id: 'convert-link-on-current-line',
      name: 'Convert link on current line to embed',
      editorCallback: (editor) => {
        const cursor = editor.getCursor();
        const match = (editor.getLine(cursor.line) || '').match(/https?:\/\/\S+/);
        if (!match || !parseYouTubeUrl(match[0])) {
          new Notice('No YouTube link found on this line.');
          return;
        }

        const url = match[0];
        const snippet = this.buildSnippet(url);
        const snippetLines = snippet.split('\n').length;
        editor.setLine(cursor.line, snippet);
        editor.setCursor({ line: cursor.line + snippetLines - 1, ch: 0 });

        const target = this.settings.insertMode === 'native' ? cursor.line : cursor.line + 1;
        this.annotate(editor, target, url);
      }
    });

    this.addCommand({
      id: 'fill-missing-titles',
      name: 'Fill in missing titles in this note',
      editorCallback: (editor) => {
        this.fillMissingTitles(editor);
      }
    });

    this.addSettingTab(new YouTubePasteEmbedSettingTab(this.app, this));
  }

  onunload() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveSettings();
    }
  }

  /* ---------------- settings ---------------- */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.titleCache) this.settings.titleCache = {};
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Coalesces the writes caused by rendering several players at once. */
  queueSave() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveSettings();
    }, 1500);
  }

  /* ---------------- metadata ---------------- */

  /**
   * Title and channel for a video, from the cache when possible. Returns null
   * when the lookup fails, which is also what a deleted video looks like.
   */
  async lookupMetadata(video) {
    const key = video.videoId || ('list:' + video.list);
    const cached = this.settings.titleCache[key];
    if (cached) return cached;

    try {
      const response = await requestUrl({
        url: 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(buildWatchUrl(video)),
        method: 'GET'
      });
      const data = response.json;
      if (!data || !data.title) return null;

      const metadata = { title: data.title, author: data.author_name || '' };
      this.settings.titleCache[key] = metadata;
      this.queueSave();
      return metadata;
    } catch (error) {
      // Offline, or the video is private or removed.
      return null;
    }
  }

  /* ---------------- insertion ---------------- */

  buildSnippet(url, metadata) {
    if (this.settings.insertMode === 'native') {
      const alt = metadata ? this.buildAltText(metadata) : '';
      return '![' + alt + '](' + url + ')';
    }

    let body = url;
    if (metadata && this.settings.storeMetadata) {
      const lines = this.buildMetadataLines(metadata);
      if (lines) body += '\n' + lines;
    }
    return FENCE + 'youtube\n' + body + '\n' + FENCE;
  }

  buildMetadataLines(metadata) {
    const lines = [];
    const title = sanitizeMetaValue(metadata.title);
    const channel = sanitizeMetaValue(metadata.author || metadata.channel);
    if (title) lines.push('title: ' + title);
    if (channel) lines.push('channel: ' + channel);
    return lines.join('\n');
  }

  buildAltText(metadata) {
    const title = sanitizeAltText(metadata.title);
    const channel = sanitizeAltText(metadata.author || metadata.channel);
    if (title && channel) return title + ' — ' + channel;
    return title || channel || '';
  }

  insertEmbed(editor, url) {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line) || '';
    const before = line.slice(0, cursor.ch);
    const after = line.slice(cursor.ch);

    const prefix = before.trim().length ? '\n\n' : '';
    const suffix = after.trim().length ? '\n\n' : '\n';
    const snippet = this.buildSnippet(url);

    editor.replaceSelection(prefix + snippet + suffix);

    // The lookup is async, so the block goes in immediately and the title is
    // written a moment later. Work out which line to come back to: the cursor
    // now sits at the end of everything that was inserted.
    const endLine = editor.getCursor().line;
    const suffixNewlines = suffix.split('\n').length - 1;
    const snippetNewlines = snippet.split('\n').length - 1;
    const firstSnippetLine = endLine - snippetNewlines - suffixNewlines;
    const target = this.settings.insertMode === 'native' ? firstSnippetLine : firstSnippetLine + 1;

    this.annotate(editor, target, url);
  }

  /**
   * Writes the title and channel into the note, on the line holding the URL.
   * Bails out silently if the line moved or changed while the lookup ran.
   */
  async annotate(editor, lineIndex, url) {
    if (!this.settings.storeMetadata) return;

    const video = parseYouTubeUrl(url);
    if (!video) return;

    const metadata = await this.lookupMetadata(video);
    if (!metadata || !metadata.title) return;

    const current = editor.getLine(lineIndex);
    if (typeof current !== 'string') return;

    if (this.settings.insertMode === 'native') {
      if (current.trim() !== '![](' + url + ')') return;
      editor.setLine(lineIndex, '![' + this.buildAltText(metadata) + '](' + url + ')');
      return;
    }

    if (current.trim() !== url.trim()) return;
    const lines = this.buildMetadataLines(metadata);
    if (!lines) return;
    editor.replaceRange('\n' + lines, { line: lineIndex, ch: current.length });
  }

  /**
   * Walks every youtube block in the note and fills in the ones with no stored
   * title. For playlists full of links saved before this existed.
   */
  async fillMissingTitles(editor) {
    const openers = [FENCE + 'youtube', FENCE + 'yt'];
    let filled = 0;
    let missed = 0;

    for (let i = 0; i < editor.lineCount(); i++) {
      if (!openers.includes((editor.getLine(i) || '').trim())) continue;

      let end = -1;
      for (let j = i + 1; j < editor.lineCount(); j++) {
        if ((editor.getLine(j) || '').trim() === FENCE) { end = j; break; }
      }
      if (end < 0) break;

      const body = [];
      for (let j = i + 1; j < end; j++) body.push(editor.getLine(j));

      const parsed = parseBlockSource(body.join('\n'));
      const video = parsed.url ? parseYouTubeUrl(parsed.url) : null;

      if (!video || parsed.meta.title) { i = end; continue; }

      // Locate the URL inside the block; blank lines are allowed before it.
      let urlLine = -1;
      for (let j = i + 1; j < end; j++) {
        if ((editor.getLine(j) || '').trim()) { urlLine = j; break; }
      }
      if (urlLine < 0) { i = end; continue; }

      const metadata = await this.lookupMetadata(video);
      const lines = metadata ? this.buildMetadataLines(metadata) : '';

      if (!lines) {
        missed++;
        i = end;
        continue;
      }

      const current = editor.getLine(urlLine);
      editor.replaceRange('\n' + lines, { line: urlLine, ch: current.length });
      filled++;
      i = end + lines.split('\n').length;
    }

    if (!filled && !missed) new Notice('Every embed in this note already has a title.');
    else if (!missed) new Notice('Filled in ' + filled + ' title' + (filled === 1 ? '' : 's') + '.');
    else new Notice('Filled in ' + filled + ', could not reach ' + missed + '.');
  }

  /* ---------------- rendering ---------------- */

  renderPlayer(source, el) {
    el.empty();

    const parsed = parseBlockSource(source);
    const video = parsed.url ? parseYouTubeUrl(parsed.url) : null;

    if (!video) {
      el.createDiv({ cls: 'ype-error' })
        .setText('Not a valid YouTube link: ' + (parsed.url || '(empty block)'));
      return;
    }

    const wrapper = el.createDiv({ cls: 'ype-embed' });
    if (video.kind === 'short') wrapper.addClass('ype-short');

    let titleEl = null;
    if (this.settings.showTitle) {
      const bar = wrapper.createDiv({ cls: 'ype-bar' });
      bar.createSpan({ cls: 'ype-icon', text: '▶' });

      titleEl = bar.createSpan({ cls: 'ype-title', text: parsed.meta.title || 'YouTube' });
      if (parsed.meta.title) titleEl.setAttr('title', parsed.meta.title);

      if (parsed.meta.channel) {
        bar.createSpan({ cls: 'ype-channel', text: parsed.meta.channel });
      }

      const link = bar.createEl('a', {
        cls: 'ype-open',
        text: 'Open ↗',
        href: buildWatchUrl(video)
      });
      link.setAttr('target', '_blank');
      link.setAttr('rel', 'noopener');
    }

    const frame = wrapper.createDiv({ cls: 'ype-frame' });
    const iframe = frame.createEl('iframe');
    iframe.setAttr('src', buildPlayerUrl(video, this.settings));
    iframe.setAttr('allow', 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen');
    iframe.setAttr('allowfullscreen', 'true');
    iframe.setAttr('loading', 'lazy');
    iframe.setAttr('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.setAttr('frameborder', '0');

    // Only reach the network when the note does not already carry the title.
    if (titleEl && !parsed.meta.title) this.applyTitle(titleEl, video);
  }

  async applyTitle(titleEl, video) {
    const metadata = await this.lookupMetadata(video);
    if (!metadata || !metadata.title) return;
    titleEl.setText(metadata.title);
    titleEl.setAttr('title', metadata.author ? metadata.title + ' — ' + metadata.author : metadata.title);
  }
}

/* ------------------------------------------------------------------ */
/* Settings tab                                                        */
/* ------------------------------------------------------------------ */

class YouTubePasteEmbedSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const containerEl = this.containerEl;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Convert on paste')
      .setDesc('Pasting a bare YouTube link, with no text selected, inserts the player instead of the link.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.convertOnPaste)
        .onChange(async (value) => {
          this.plugin.settings.convertOnPaste = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Inserted format')
      .setDesc('Code block renders the full card. Native embed uses ![](url), which Obsidian renders even without this plugin.')
      .addDropdown(dropdown => dropdown
        .addOption('block', 'Code block (recommended)')
        .addOption('native', 'Native embed')
        .setValue(this.plugin.settings.insertMode)
        .onChange(async (value) => {
          this.plugin.settings.insertMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Store title in the note')
      .setDesc('Write the title and channel as plain text next to the link, so the note still says what the video was after it is taken down.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.storeMetadata)
        .onChange(async (value) => {
          this.plugin.settings.storeMetadata = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show video title')
      .setDesc('Header bar above the player. Uses the title stored in the note, and only looks it up on youtube.com when there is none.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showTitle)
        .onChange(async (value) => {
          this.plugin.settings.showTitle = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Privacy mode')
      .setDesc('Play from youtube-nocookie.com.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.privacyMode)
        .onChange(async (value) => {
          this.plugin.settings.privacyMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Keep timestamp')
      .setDesc('When the link carries a ?t= value, start the player there.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.keepTimestamp)
        .onChange(async (value) => {
          this.plugin.settings.keepTimestamp = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Title cache')
      .setDesc(Object.keys(this.plugin.settings.titleCache || {}).length + ' titles stored. Titles already written into your notes are not affected.')
      .addButton(button => button
        .setButtonText('Clear')
        .onClick(async () => {
          this.plugin.settings.titleCache = {};
          await this.plugin.saveSettings();
          this.display();
        }));
  }
}

module.exports = YouTubePasteEmbedPlugin;
