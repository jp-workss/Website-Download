const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.static('public'));

// Smart path detection: uses local 'yt-dlp.exe' on Windows, global 'yt-dlp' on Render/Docker
const localExePath = path.join(__dirname, 'yt-dlp.exe');
const ytdlpPath = fs.existsSync(localExePath) ? localExePath : 'yt-dlp';

const ytdlpArgs = [
    '--extractor-args', 'youtube:player_client=mweb,android,web',
    '--no-playlist'
];

// Endpoint 1: Fetch Metadata
app.get('/api/info', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL is required' });

    const ytdlp = spawn(ytdlpPath, [
        ...ytdlpArgs,
        '--dump-json',
        videoUrl
    ]);

    let rawData = '';
    let errorData = '';

    ytdlp.stdout.on('data', (data) => rawData += data.toString());
    ytdlp.stderr.on('data', (data) => errorData += data.toString());

    ytdlp.on('close', (code) => {
        if (code !== 0) {
            console.error('yt-dlp error:', errorData);
            return res.status(500).json({ error: `yt-dlp error: ${errorData.slice(0, 150)}` });
        }
        try {
            const json = JSON.parse(rawData);
            res.json({
                title: json.title,
                thumbnail: json.thumbnail,
                duration: json.duration_string
            });
        } catch (err) {
            res.status(500).json({ error: 'Failed to parse video metadata.' });
        }
    });
});

// Endpoint 2: Stream Selected Format & Quality
app.get('/api/convert', (req, res) => {
    const { url, title, mode, quality } = req.query;
    if (!url) return res.status(400).send('URL is required');

    const safeTitle = (title ? title.replace(/[^a-zA-Z0-9 _-]/g, "") : "youtube_download").trim();

    // MODE 1: MP3 AUDIO
    if (mode === 'mp3') {
        const bitrate = quality || '192k';

        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_${bitrate}.mp3"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        const ytdlp = spawn(ytdlpPath, [
            ...ytdlpArgs,
            '-o', '-',
            '-f', 'ba/b',
            url
        ]);

        const ffmpeg = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-vn',
            '-acodec', 'libmp3lame',
            '-b:a', bitrate,
            '-f', 'mp3',
            'pipe:1'
        ]);

        ytdlp.stdout.pipe(ffmpeg.stdin);
        ffmpeg.stdout.pipe(res);

        req.on('close', () => {
            ytdlp.kill();
            ffmpeg.kill();
        });
    } 
    // MODE 2: MP4 VIDEO
    else if (mode === 'mp4') {
        const height = quality ? quality.replace('p', '') : '1080';

        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_${height}p.mp4"`);
        res.setHeader('Content-Type', 'video/mp4');

        const formatSpec = `bv*[height=${height}]+ba/bv*[height<=${height}]+ba/best`;

        const ytdlp = spawn(ytdlpPath, [
            ...ytdlpArgs,
            '-o', '-',
            '-f', formatSpec,
            url
        ]);

        const ffmpeg = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '20',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-movflags', 'frag_keyframe+empty_moov',
            '-f', 'mp4',
            'pipe:1'
        ]);

        ytdlp.stdout.pipe(ffmpeg.stdin);
        ffmpeg.stdout.pipe(res);

        req.on('close', () => {
            ytdlp.kill();
            ffmpeg.kill();
        });
    } else {
        res.status(400).send('Invalid mode specified.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});