# MP3 Last.fm Tagger

A deploy-ready local or hosted web app for tagging MP3 files. See `DEPLOYMENT.md` for running it as a website.

A local web app for tagging MP3 files.

## What it does

- Upload one MP3 file.
- Reads existing ID3 tags using `music-metadata`.
- Falls back to parsing the filename, especially `Artist - Song.mp3`.
- Looks up corrected track metadata with Last.fm.
- Pulls Last.fm top tags and converts the year into an era label like `80s`, `90s`, `00s`, `10s` or `20s`.
- Shows album cover choices from Last.fm first, with Apple artwork as a fallback.
- Downloads a new MP3 with ID3 tags and embedded cover art using `node-id3`.

Your original file is not overwritten.

## Setup

1. Install Node.js 18 or newer.
2. Install dependencies:

```bash
npm install
```

3. Copy the environment file:

```bash
cp .env.example .env
```

4. Get a free Last.fm API key from Last.fm and paste it into `.env`:

```env
LASTFM_API_KEY=your_key_here
```

5. Start the app:

```bash
npm start
```

6. Open this in your browser:

```text
http://localhost:3000
```

## Notes

- Last.fm often has great track and tag data, but release years and images are not always complete.
- The app uses Apple Search API only as a fallback for artwork and release year when Last.fm does not return enough data.
- Era is stored in two places: a comment field (`Era: 90s`) and a custom ID3 text frame named `Era`.
- If deployed publicly, set `SITE_PASSWORD` so other people cannot upload files to your server.
- Uploaded files are stored temporarily in `uploads/` or your configured `DATA_DIR`, and old files are cleaned up automatically.

## Troubleshooting

### The app says “Add LASTFM_API_KEY to .env”
Make sure you copied `.env.example` to `.env` and restarted the server after adding your key.

### No covers show up
That usually means Last.fm did not return artwork for that track/artist and Apple did not find a good fallback. You can still download text-only tags.

### The year is blank
Last.fm does not reliably return release dates for every track. Type the year manually and the era will update automatically.
