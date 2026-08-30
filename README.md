# Paste YouTube embed

Paste a YouTube link into a note and get a player where the link would have gone — no dialog, no extra command, no leaving the keyboard.

Obsidian can already embed YouTube with `![](url)`, but you have to write that syntax yourself and the result is a bare iframe. This plugin does the conversion at paste time and renders a card with the video title, so a link you dropped into a note six months ago still tells you what it is.

## What it does

- **Converts on paste.** Paste a bare YouTube URL on its own, with no text selected, and it becomes a player block. Paste with text selected, or paste anything else, and nothing changes.
- **Shows the video title.** The header bar carries the real title and channel, fetched once through YouTube's oEmbed endpoint and then cached in the vault.
- **Handles the whole URL family.** `youtube.com/watch`, `youtu.be`, `shorts`, `live`, `embed`, `m.youtube.com`, `music.youtube.com`, and playlists.
- **Keeps timestamps.** A link with `?t=90` or `?t=1h2m3s` starts the player at that point.
- **Renders Shorts vertically**, in a 9:16 card sized for them, instead of stretching them into a 16:9 box.
- **Stays out of the way otherwise.** The player is a plain fenced block holding the original URL, so the note is still readable and greppable without the plugin.

## What it writes to your note

````markdown
```youtube
https://www.youtube.com/watch?v=dQw4w9WgXcQ
```
````

If you would rather stay on syntax Obsidian understands on its own, switch **Inserted format** to *Native embed* and it writes `![](url)` instead. That renders without the plugin installed, at the cost of the title bar and the Shorts handling.

## Commands

- **Insert embed from clipboard** — for when the link is already copied.
- **Convert link on current line to embed** — turns a link you pasted earlier into a player.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Convert on paste | on | Paste a YouTube link and get the player. Turn it off to keep plain links and use the commands instead. |
| Inserted format | Code block | Code block, or native `![](url)`. |
| Show video title | on | Header bar with the title and channel. |
| Privacy mode | off | Play from `youtube-nocookie.com`. |
| Keep timestamp | on | Honour `?t=` from the pasted link. |
| Title cache | — | Clear the stored titles. |

## Network use

Two things reach youtube.com: the player iframe itself, and one oEmbed request per video to read its title. Turn off **Show video title** to stop the second one; turn on **Privacy mode** to serve the player from `youtube-nocookie.com`.

## Clipboard use

Two paths touch the clipboard, both only in response to something you did:

- **Converting on paste** reads the text of the paste event you just triggered. It never polls the clipboard on its own, and anything that is not a bare YouTube URL falls straight through to Obsidian's normal paste handling.
- **Insert embed from clipboard** reads the clipboard when you run that command, and ignores its contents unless they are a YouTube link.

Nothing from the clipboard is stored or sent anywhere. The only thing written to disk is the video title, cached in the plugin's `data.json`, which you can clear from the settings.

## Installation

**From Obsidian** — Settings → Community plugins → Browse → search for "Paste YouTube embed".

**Manually** — download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/maxwellnewage/obsidian-youtube-paste-embed/releases/latest) into `<vault>/.obsidian/plugins/youtube-paste-embed/`, then enable the plugin in Settings → Community plugins.

## Development

There is no build step. `main.js` is the source: plain CommonJS against the Obsidian API. Edit it, reload Obsidian, done.

## License

[MIT](LICENSE)
