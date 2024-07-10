const express = require('express');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const axios = require('axios');
const app = express();
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const ngrok = require('ngrok');

let ngrokUrl = '';

app.use(bodyParser.json());

async function downloadImage(url, outputPath) {
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

app.post('/ffmpeg', async (req, res) => {
    console.log('Received request:', JSON.stringify(req.body, null, 2));
    const { images, width, height, fps, recordId, webhookUrl } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: 'Invalid images array' });
    }

    if (!width || !height || !fps) {
        return res.status(400).json({ error: 'Missing required parameters: width, height, or fps' });
    }

    console.log(`Processing video with dimensions: ${width}x${height}, fps: ${fps}`);
    images.forEach((img, index) => {
        console.log(`Image ${index + 1}: src=${img.src}, width=${img.width}, height=${img.height}`);
    });

    const imageDuration = 5; // Each image should last 5 seconds
    const totalDuration = images.length * imageDuration;
    const tempDir = path.join('C:\\Users\\Ahmad\\Documents\\AiTechAlchemy\\videos', 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    try {
        // Download images
        const downloadedImages = await Promise.all(images.map(async (img, index) => {
            const ext = path.extname(new URL(img.src).pathname) || '.jpg';
            const localPath = path.join(tempDir, `image_${index}${ext}`);
            await downloadImage(img.src, localPath);
            return localPath;
        }));

        const uniqueSuffix = Date.now();
        const outputFilename = `output_${recordId}_${uniqueSuffix}.mp4`;
        const outputPath = path.join('C:\\Users\\Ahmad\\Documents\\AiTechAlchemy\\videos', outputFilename);

        // Create a complex filter for centered zooming effect and transitions
        let filterComplex = '';
        let inputs = '';
        downloadedImages.forEach((img, index) => {
            inputs += `-loop 1 -t ${imageDuration} -i "${img}" `;
            filterComplex += `[${index}:v]scale=${width}:${height},zoompan=z='min(zoom+0.0015,1.5)':d=${imageDuration*fps}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height},trim=duration=${imageDuration},setpts=PTS-STARTPTS[v${index}];`;
        });

        // Concatenate all video streams
        for (let i = 0; i < downloadedImages.length; i++) {
            filterComplex += `[v${i}]`;
        }
        filterComplex += `concat=n=${downloadedImages.length}:v=1:a=0,format=yuv420p[v]`;

        const ffmpegCommand = `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[v]" -t ${totalDuration} -c:v libx264 -preset medium -crf 23 "${outputPath}"`;

        console.log(`Executing FFmpeg command: ${ffmpegCommand}`);

        await new Promise((resolve, reject) => {
            const ffmpegProcess = spawn(ffmpegCommand, { shell: true });
            ffmpegProcess.stdout.on('data', (data) => console.log(`FFmpeg Output: ${data}`));
            ffmpegProcess.stderr.on('data', (data) => console.error(`FFmpeg Progress: ${data}`));
            ffmpegProcess.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg exited with code ${code}`));
            });
        });

        // Clean up temporary files
        await fs.rm(tempDir, { recursive: true, force: true });

        const videoUrl = `${ngrokUrl}/videos/${outputFilename}`;
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

app.use('/videos', express.static('C:\\Users\\Ahmad\\Documents\\AiTechAlchemy\\videos'));

const port = 3002; // Changed from 3000 to 3002

async function startServer() {
    try {
        app.listen(port, () => console.log(`FFmpeg local server running on http://localhost:${port}`));

        ngrokUrl = await ngrok.connect({
            addr: port,
            region: 'us',
            authtoken: '2ifSprkMZimCVgDmKJL4pqmL5tx_3AxycRWe7uu51p8zvAsvU',
        });
        console.log('\n==================================================');
        console.log(`Ngrok tunnel for server.js created successfully!`);
        console.log(`Update the First HTTP Module URL`);
        console.log(`Your FFmpeg server is now accessible at: ${ngrokUrl}`);
        console.log('==================================================\n');

        console.log('FFmpeg server is ready to process video requests.');
    } catch (err) {
        console.error('Error setting up FFmpeg server or Ngrok:', err);
        process.exit(1);
    }
}

startServer();