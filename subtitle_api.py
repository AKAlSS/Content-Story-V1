from flask import Flask, request, jsonify
import moviepy.editor as mp
import os
from whisper import load_model
import subprocess

app = Flask(__name__)

@app.route('/process', methods=['POST'])
def process():
    data = request.get_json()
    video_path = data.get('videoPath')
    subtitle_path = data.get('subtitlePath')

    if not video_path or not subtitle_path:
        return jsonify({'error': 'Invalid input'}), 400

    try:
        # Extract audio from video
        audio_path = os.path.join(os.path.dirname(video_path), 'temp_audio.wav')
        video = mp.VideoFileClip(video_path)
        video.audio.write_audiofile(audio_path)

        # Transcribe audio to generate subtitles
        model = load_model("base")
        result = model.transcribe(audio_path)
        os.remove(audio_path)

        # Write subtitles to file
        with open(subtitle_path, 'w') as srt_file:
            for i, segment in enumerate(result["segments"]):
                start = segment["start"]
                end = segment["end"]
                text = segment["text"]
                srt_file.write(f"{i + 1}\n")
                srt_file.write(f"{format_time(start)} --> {format_time(end)}\n")
                srt_file.write(f"{text}\n\n")

        return jsonify({'message': 'Subtitles generated successfully', 'subtitle_path': subtitle_path})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def format_time(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    seconds = int(seconds % 60)
    milliseconds = int((seconds * 1000) % 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
