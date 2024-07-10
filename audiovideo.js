const express = require('express');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const ngrok = require('ngrok');

const airtableApiKey = 'pat6Nz5K8KFmayJ33.c314d1add02eabeedc810805a3a9c9fe3408b11261dbf7d6db9fd3ba490b8eb0';
const airtableBaseId = 'appTG873bj6H9Dsji';
const airtableTableId = 'tbl59LkeRL5T5Bbxh';

let ngrokUrl = '';

const app = express();
app.use(bodyParser.json());
app.use('/audiovideo', express.static(path.join(__dirname, 'audiovideo')));

async function downloadFile(url, outputPath) {
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

function runCommand(command) {
    return new Promise((resolve, reject) => {
        const process = spawn(command, { shell: true });
        let output = '';
        process.stdout.on('data', (data) => {
            output += data.toString();
            console.log(`Command output: ${data}`);
        });
        process.stderr.on('data', (data) => console.error(`Command error: ${data}`));
        process.on('close', (code) => {
            if (code === 0) resolve(output.trim());
            else reject(new Error(`Command exited with code ${code}`));
        });
    });
}

async function getDuration(filePath) {
    const ffprobeCommand = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    try {
        const output = await runCommand(ffprobeCommand);
        const duration = parseFloat(output);
        return isNaN(duration) ? -1 : duration;
    } catch (error) {
        console.error(`Error getting duration for ${filePath}:`, error);
        return -1;
    }
}

async function combineVideoAndAudio(videoPath, audioPath, outputPath) {
    try {
        const audioDuration = await getDuration(audioPath);
        const videoDuration = await getDuration(videoPath);

        console.log(`Video duration: ${videoDuration} seconds`);
        console.log(`Audio duration: ${audioDuration} seconds`);

        if (audioDuration <= 0 || videoDuration <= 0) {
            throw new Error('Invalid audio or video duration');
        }

        const ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${audioPath}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k -shortest -y "${outputPath}"`;

        console.log(`Executing FFmpeg command: ${ffmpegCommand}`);
        await runCommand(ffmpegCommand);

        console.log('Video and audio have been combined successfully. Output file is located at:', outputPath);
    } catch (error) {
        console.error('Error combining video and audio:', error.message);
        throw error;
    }
}

async function fetchAirtableData(recordId) {
    const url = `https://api.airtable.com/v0/${airtableBaseId}/${airtableTableId}/${recordId}`;
    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${airtableApiKey}`
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching data from Airtable:', error);
        throw error;
    }
}

app.post('/merge', async (req, res) => {
    console.log('Received request:', JSON.stringify(req.body, null, 2));
    const { recordId, exports: exportsArray } = req.body;

    try {
        const airtableData = await fetchAirtableData(recordId);
        console.log('Airtable data:', JSON.stringify(airtableData, null, 2));

        const videoScene = airtableData.fields.Video[0];
        const audioScene = airtableData.fields.Audio[0];

        if (!videoScene || !audioScene) {
            return res.status(400).json({ error: 'Missing video or audio scene' });
        }

        console.log('Video URL:', videoScene.url);
        console.log('Audio URL:', audioScene.url);

        const tempDir = path.join(__dirname, 'temp');
        const outputDir = path.join(__dirname, 'audiovideo');
        await fs.mkdir(tempDir, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });

        const videoPath = path.join(tempDir, `video_${recordId}.mp4`);
        const audioPath = path.join(tempDir, `audio_${recordId}.mp3`);

        await downloadFile(videoScene.url, videoPath);
        await downloadFile(audioScene.url, audioPath);

        const outputFilePath = path.join(outputDir, `merged_${recordId}.mp4`);
        await combineVideoAndAudio(videoPath, audioPath, outputFilePath);

        const fullVideoUrl = `${ngrokUrl}/audiovideo/merged_${recordId}.mp4`;
        console.log('Full video URL:', fullVideoUrl);

        const responsePayload = { id: recordId, url: fullVideoUrl };
        const webhookUrl = exportsArray[0].endpoint;

        console.log('Sending webhook to:', webhookUrl);
        console.log('Webhook Payload:', JSON.stringify(responsePayload));
        
        try {
            const webhookResponse = await axios.post(webhookUrl, responsePayload);
            console.log('Webhook response:', webhookResponse.data);
            res.status(200).json({ message: 'Video created and webhook sent successfully', output: fullVideoUrl });
        } catch (error) {
            console.error('Error sending webhook:', error.response ? error.response.data : error.message);
            res.status(500).json({ error: 'Failed to send webhook', details: error.message });
        }
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: 'Failed to process video', details: error.message });
    }
});

const port = 3001; // Changed from 3000 to 3001

(async () => {
    try {
        await ngrok.authtoken("2iioJ1JTcj3Uoii3FTdfy03GfAL_3DV8ceqUU7nJxJrS4L2fa");
        ngrokUrl = await ngrok.connect({
            addr: port,
            region: 'us', // Specify a region if needed
        });
        console.log('Ngrok tunnel for audiovideo.js created successfully! Your server is now accessible at:', ngrokUrl);
        console.log('Audiovideo server is ready to process video requests.');
        console.log(`Update the Second HTTP Module URL`);
    } catch (error) {
        console.error('Error setting up Ngrok for audiovideo.js:', error);
    }
})();

app.listen(port, () => {
    console.log(`Audiovideo local server running on http://localhost:${port}`);
});