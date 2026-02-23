import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

// ─── Config ─────────────────────────────────────────────────────────────────

function getWhisperModelPath(): string {
  if (process.env.WHISPER_MODEL_PATH) {
    return process.env.WHISPER_MODEL_PATH.replace(/^~/, process.env.HOME ?? '');
  }
  // Default: ~/models/ggml-base.en.bin
  return join(process.env.HOME ?? '', 'models', 'ggml-base.en.bin');
}

function getWhisperBinaryPath(): string {
  return process.env.WHISPER_CPP_PATH ?? 'whisper-cli';
}

function getFfmpegPath(): string {
  return process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';
}

// ─── Transcription ──────────────────────────────────────────────────────────

/**
 * Transcribe an audio file to text using local whisper-cpp.
 *
 * 1. Converts the input audio to 16kHz mono WAV via ffmpeg
 * 2. Runs whisper-cpp CLI to transcribe
 * 3. Returns the transcribed text
 *
 * Throws if whisper-cpp or ffmpeg are not installed, or if the model file is missing.
 */
export async function transcribeAudio(audioPath: string): Promise<string> {
  const startTime = Date.now();
  const wavPath = join(tmpdir(), `whisper-${Date.now()}.wav`);

  try {
    // Verify prerequisites
    const modelPath = getWhisperModelPath();
    if (!existsSync(modelPath)) {
      throw new Error(
        `Whisper model not found at ${modelPath}. Download it with:\n` +
        `mkdir -p ~/models && curl -L -o ~/models/ggml-base.en.bin ` +
        `'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'`,
      );
    }

    // Step 1: Convert to 16kHz mono WAV (required by whisper-cpp)
    await execFileAsync(getFfmpegPath(), [
      '-i', audioPath,
      '-ar', '16000',
      '-ac', '1',
      '-y',
      wavPath,
    ]);

    // Step 2: Run whisper-cpp
    const { stdout, stderr } = await execFileAsync(getWhisperBinaryPath(), [
      '--model', modelPath,
      '--language', 'en',
      '--no-timestamps',
      '--file', wavPath,
    ], {
      timeout: 60_000, // 60s timeout for long voice notes
    });

    // whisper-cpp outputs transcription to stdout, logs to stderr
    const transcription = stdout.trim();

    if (!transcription) {
      logger.warn({ stderr: stderr.substring(0, 200) }, 'Whisper produced empty transcription');
      throw new Error('Transcription produced no text — the voice note may be too short or unclear');
    }

    const durationMs = Date.now() - startTime;
    logger.info(
      { audioPath, durationMs, charCount: transcription.length },
      'Audio transcribed successfully',
    );

    return transcription;
  } finally {
    // Clean up temp WAV file
    try {
      if (existsSync(wavPath)) unlinkSync(wavPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Check whether local whisper transcription is available.
 * Returns a descriptive error message if not, or null if ready.
 */
export async function checkWhisperAvailability(): Promise<string | null> {
  try {
    await execFileAsync(getWhisperBinaryPath(), ['--help']);
  } catch {
    return 'whisper-cpp is not installed. Install with: brew install whisper-cpp';
  }

  const modelPath = getWhisperModelPath();
  if (!existsSync(modelPath)) {
    return `Whisper model not found at ${modelPath}. Download with:\nmkdir -p ~/models && curl -L -o ~/models/ggml-base.en.bin 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'`;
  }

  return null;
}
