const express = require('express');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const ngrok = require('ngrok');

let ngrokUrl = '';

const app = express();
app.use(bodyParser.json());

async function downloadVideo(url, outputPath) {
    const writer = require('fs').createWriteStream(outputPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function callPythonScript(videoPath, subtitlePath) {
    try {
        const response = await axios.post('http://localhost:5000/process', {
            videoPath,
            subtitlePath
        });
        return response.data;
    } catch (error) {
        console.error('Error calling Python script:', error.message);
        throw error;
    }
}

function executeFFmpegCommand(command) {
    return new Promise((resolve, reject) => {
        const ffmpegProcess = spawn(command, { shell: true });
        ffmpegProcess.stdout.on('data', (data) => console.log(`FFmpeg Output: ${data}`));
        ffmpegProcess.stderr.on('data', (data) => console.error(`FFmpeg Progress: ${data}`));
        ffmpegProcess.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg exited with code ${code}`));
        });
    });
}

function processSRTContent(content) {
    // Split subtitles into smaller segments
    const lines = content.split('\n');
    let newContent = '';
    for (let i = 0; i < lines.length; i++) {
        if (/^\d+$/.test(lines[i])) {
            // Subtitle index line
            newContent += lines[i] + '\n';
        } else if (/-->/.test(lines[i])) {
            // Timestamp line
            newContent += lines[i] + '\n';
        } else if (lines[i].trim()) {
            // Subtitle text line
            const words = lines[i].split(' ');
            for (let j = 0; j < words.length; j += 3) {
                newContent += words.slice(j, j + 3).join(' ') + '\n';
            }
        } else {
            // Empty line
            newContent += '\n';
        }
    }
    return newContent;
}

app.post('/ffmpeg', async (req, res) => {
    console.log('Received request:', JSON.stringify(req.body, null, 2));
    const { fps, width, height, videos, duration, recordId, webhookUrl } = req.body;

    if (!videos || !Array.isArray(videos) || videos.length === 0) {
        return res.status(400).json({ error: 'Invalid scenes array' });
    }

    videos.sort((a, b) => a.sceneId - b.sceneId);

    const tempDir = path.join(os.tmpdir(), 'ffmpeg-temp');
    const finalOutputDir = path.join(__dirname, 'Final');
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(finalOutputDir, { recursive: true });

    try {
        const downloadedVideos = await Promise.all(videos.map(async (video, index) => {
            const ext = '.mp4';
            const localPath = path.join(tempDir, `video_${index}${ext}`);
            console.log(`Downloading video to ${localPath}`);
            await downloadVideo(video.src, localPath);
            return localPath;
        }));

        const uniqueSuffix = Date.now();
        const combinedVideoPath = path.join(tempDir, `combined_${recordId}_${uniqueSuffix}.mp4`);
        const subtitlePath = path.join(tempDir, 'subtitles.srt');

        console.log(`Combined video path: ${combinedVideoPath}`);
        console.log(`Subtitle path: ${subtitlePath}`);

        const ffmpegConcatCommand = [
            'ffmpeg',
            ...downloadedVideos.map(video => `-i "${video}"`),
            `-filter_complex "concat=n=${downloadedVideos.length}:v=1:a=1[outv][outa]"`,
            `-map "[outv]" -map "[outa]"`,
            `-r ${fps}`,
            `-s ${width}x${height}`,
            `-c:v libx264 -preset medium -crf 23`,
            `"${combinedVideoPath}"`
        ].join(' ');

        console.log(`Executing FFmpeg concat command: ${ffmpegConcatCommand}`);
        await executeFFmpegCommand(ffmpegConcatCommand);

        const pythonResult = await callPythonScript(combinedVideoPath, subtitlePath);
        console.log('Python script result:', pythonResult);

        // Read and process SRT content
        let srtContent = await fs.readFile(subtitlePath, 'utf-8');
        srtContent = processSRTContent(srtContent);
        await fs.writeFile(subtitlePath, srtContent);

        const finalOutputFilename = `output_${recordId}_${uniqueSuffix}.mp4`;
        const finalOutputPath = path.join(finalOutputDir, finalOutputFilename);

        const ffmpegSubtitleCommand = [
            'ffmpeg',
            `-i "${combinedVideoPath}"`,
            `-vf "subtitles='${subtitlePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}:force_style=FontName=Arial,FontSize=24,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=2'"`,
            `-c:v libx264 -preset medium -crf 23`,
            `"${finalOutputPath}"`
        ].join(' ');

        console.log(`Executing FFmpeg subtitle command: ${ffmpegSubtitleCommand}`);
        await executeFFmpegCommand(ffmpegSubtitleCommand);

        // Delay before deleting temporary files
        setTimeout(async () => {
            try {
                await fs.rm(tempDir, { recursive: true, force: true });
            } catch (err) {
                console.error('Error deleting temporary files:', err.message);
            }
        }, 5000); // 5 seconds delay

        const videoUrl = `${ngrokUrl}/videos/${finalOutputFilename}`;
        const webhookPayload = { id: recordId, url: videoUrl };
        console.log('Video processing completed successfully.');
        console.log('Webhook Payload:', JSON.stringify(webhookPayload));

        const response = await axios.post(webhookUrl, webhookPayload);
        console.log('Webhook Response:', response.data);

        res.status(200).json({ message: 'Video created successfully', output: videoUrl });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.use('/videos', express.static(path.join(__dirname, 'Final')));

const port = 3003;

async function startServer() {
    try {
        app.listen(port, () => console.log(`FFmpeg local server running on http://localhost:${port}`));

        ngrokUrl = await ngrok.connect({
            addr: port,
            region: 'us',
            authtoken: '2iiwwuIzICTuorpLobpKhT2jZDH_7wXMuL4HzdmpEw3nYYRWK', // replace with your ngrok auth token
        });
        console.log('\n==================================================');
        console.log(`Ngrok tunnel for fullvideo.js created successfully!`);
        console.log(`Your FFmpeg server is now accessible at: ${ngrokUrl}`);
        console.log('==================================================\n');
        console.log(`Update the Final HTTP Module`);

        console.log('FFmpeg server is ready to process video requests.');
    } catch (err) {
        console.error('Error setting up FFmpeg server or Ngrok:', err);
    }
}

startServer();
