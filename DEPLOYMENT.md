# Deploying MP3 Last.fm Tagger as a website

This is a Node/Express app, so deploy it as a **web service**, not as a static website.

## Recommended simple route: Railway

1. Put this folder in a GitHub repository.
2. Open Railway and create a new project from the GitHub repo.
3. Railway should detect Node automatically.
4. Set the start command to:

```bash
npm start
```

5. Add these service variables:

```env
LASTFM_API_KEY=your_key_here
SITE_USERNAME=admin
SITE_PASSWORD=make_a_strong_password
MAX_UPLOAD_MB=50
CLEANUP_AFTER_HOURS=6
```

6. Generate a public domain in Railway.
7. Open the public URL on your phone.

### Optional volume

The app only needs temporary storage while you are tagging a file, so it can run without a volume. If you want fewer issues during restarts, attach a Railway volume and set:

```env
DATA_DIR=/data
```

Mount the volume to `/data`.

## Render route

1. Put this folder in a GitHub repository.
2. Create a new Render **Web Service** from the repo.
3. Use:

```bash
npm install
```

as the build command, and:

```bash
npm start
```

as the start command.

4. Add environment variables:

```env
LASTFM_API_KEY=your_key_here
SITE_USERNAME=admin
SITE_PASSWORD=make_a_strong_password
MAX_UPLOAD_MB=50
CLEANUP_AFTER_HOURS=6
```

5. Deploy and open the Render URL.

### Optional persistent disk on Render

If you use a persistent disk, mount it and set `DATA_DIR` to the mounted path, for example:

```env
DATA_DIR=/var/data
```

## Why not Vercel?

Vercel is excellent for frontend apps, but this project uploads MP3 files to a Node server. Typical MP3s are larger than Vercel's serverless request body limit, so Railway/Render/Fly are better fits.

## Privacy note

Set `SITE_PASSWORD`. Without it, anyone with your app link could upload files to your server.
