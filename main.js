'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');

const FENCE = '`' + '`' + '`';
const BLOCK_LANGUAGES = ['youtube', 'yt'];

const DEFAULT_SETTINGS = {
  convertOnPaste: true,     // pasting a YouTube link inserts the player
  insertMode: 'block',      // 'block' = ```youtube fence  |  'native' = ![](url)
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
        const snippet = this.buildSnippet(match[0]);
        editor.setLine(cursor.line, snippet);
        editor.setCursor({ line: cursor.line + snippet.split('\n').length - 1, ch: 0 });
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

  /* ---------------- insertion ---------------- */

  buildSnippet(url) {
    if (this.settings.insertMode === 'native') return '![](' + url + ')';
    return FENCE + 'youtube\n' + url + '\n' + FENCE;
  }

  insertEmbed(editor, url) {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line) || '';
    const before = line.slice(0, cursor.ch);
    const after = line.slice(cursor.ch);

    const prefix = before.trim().length ? '\n\n' : '';
    const suffix = after.trim().length ? '\n\n' : '\n';

    editor.replaceSelection(prefix + this.buildSnippet(url) + suffix);
  }

  /* ---------------- rendering ---------------- */

  renderPlayer(source, el) {
    el.empty();

    const firstLine = (source || '').split('\n').map(s => s.trim()).filter(Boolean)[0];
    const video = parseYouTubeUrl(firstLine);

    if (!video) {
      el.createDiv({ cls: 'ype-error' })
        .setText('Not a valid YouTube link: ' + (firstLine || '(empty block)'));
      return;
    }

    const wrapper = el.createDiv({ cls: 'ype-embed' });
    if (video.kind === 'short') wrapper.addClass('ype-short');

    let titleEl = null;
    if (this.settings.showTitle) {
      const bar = wrapper.createDiv({ cls: 'ype-bar' });
      bar.createSpan({ cls: 'ype-icon', text: '▶' });
      titleEl = bar.createSpan({ cls: 'ype-title', text: 'YouTube' });
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

    if (titleEl) this.applyTitle(titleEl, video);
  }

  /** Fills the header with the real video title, cached after the first lookup. */
  async applyTitle(titleEl, video) {
    const key = video.videoId || ('list:' + video.list);
    const cached = this.settings.titleCache[key];

    if (cached) {
      this.setTitleText(titleEl, cached.title, cached.author);
      return;
    }

    try {
      const response = await requestUrl({
        url: 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(buildWatchUrl(video)),
        method: 'GET'
      });
      const data = response.json;
      if (!data || !data.title) return;

      this.settings.titleCache[key] = { title: data.title, author: data.author_name || '' };
      this.queueSave();

      this.setTitleText(titleEl, data.title, data.author_name);
    } catch (error) {
      // Offline, or the video is private or removed: keep the placeholder.
    }
  }

  setTitleText(titleEl, title, author) {
    titleEl.setText(title);
    titleEl.setAttr('title', author ? title + ' — ' + author : title);
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
      .setName('Show video title')
      .setDesc('Header bar with the real video title. Looked up on youtube.com once per video, then cached in the vault.')
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
      .setDesc(Object.keys(this.plugin.settings.titleCache || {}).length + ' titles stored.')
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
