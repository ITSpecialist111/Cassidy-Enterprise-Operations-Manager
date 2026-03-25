// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Speech Processor — Azure Cognitive Services Speech SDK for TTS and STT.
// Converts text to natural-sounding speech (en-AU-NatashaNeural voice)
// and transcribes user speech to text during voice calls.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpeechConfig {
  subscriptionKey: string;
  region: string;
  voiceName: string;
  language: string;
}

export interface SynthesisResult {
  success: boolean;
  audioData?: Buffer;
  durationMs?: number;
  error?: string;
}

export interface RecognitionResult {
  success: boolean;
  text?: string;
  confidence?: number;
  error?: string;
}

import { config as appConfig, features } from '../featureConfig';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getSpeechConfig(): SpeechConfig {
  return {
    subscriptionKey: appConfig.speechKey,
    region: appConfig.speechRegion,
    voiceName: appConfig.voiceName,
    language: appConfig.speechLanguage,
  };
}

function isSpeechConfigured(): boolean {
  return features.speechConfigured;
}

// ---------------------------------------------------------------------------
// Text-to-Speech — converts Cassidy's text response to audio
// ---------------------------------------------------------------------------

export async function synthesizeSpeech(text: string, options?: {
  emphasis?: 'strong' | 'moderate' | 'reduced';
  rate?: 'slow' | 'medium' | 'fast';
}): Promise<SynthesisResult> {
  if (!isSpeechConfigured()) {
    console.warn('[SpeechProcessor] Azure Speech not configured (AZURE_SPEECH_KEY missing)');
    return { success: false, error: 'Azure Speech SDK not configured' };
  }

  const config = getSpeechConfig();

  try {
    // Build SSML for natural, expressive speech
    const ssml = buildSSML(text, config.voiceName, config.language, options);

    // Call Azure Speech REST API (avoids requiring the native SDK binary)
    const tokenUrl = `https://${config.region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': config.subscriptionKey,
        'Content-Length': '0',
      },
    });

    if (!tokenRes.ok) {
      throw new Error(`Token acquisition failed: ${tokenRes.status}`);
    }

    const accessToken = await tokenRes.text();

    const synthesisUrl = `https://${config.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const synthRes = await fetch(synthesisUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
      },
      body: ssml,
    });

    if (!synthRes.ok) {
      const errText = await synthRes.text();
      throw new Error(`Synthesis failed (${synthRes.status}): ${errText}`);
    }

    const arrayBuffer = await synthRes.arrayBuffer();
    const audioData = Buffer.from(arrayBuffer);

    // Estimate duration: ~128kbps MP3, so bytes / (128000/8) * 1000 = ms
    const estimatedDurationMs = Math.round(audioData.length / 16 * 1000 / 1000);

    console.log(`[SpeechProcessor] Synthesized ${audioData.length} bytes, ~${estimatedDurationMs}ms`);
    return { success: true, audioData, durationMs: estimatedDurationMs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[SpeechProcessor] TTS error:', error);
    return { success: false, error };
  }
}

// ---------------------------------------------------------------------------
// Speech-to-Text — transcribes user's voice during a call
// ---------------------------------------------------------------------------

export async function transcribeAudio(audioData: Buffer, options?: {
  language?: string;
}): Promise<RecognitionResult> {
  if (!isSpeechConfigured()) {
    return { success: false, error: 'Azure Speech SDK not configured' };
  }

  const config = getSpeechConfig();
  const language = options?.language ?? config.language;

  try {
    // Use Azure Speech REST API for single-shot recognition
    const recognitionUrl = `https://${config.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${language}&format=detailed`;

    const res = await fetch(recognitionUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': config.subscriptionKey,
        'Content-Type': 'audio/wav',
        Accept: 'application/json',
      },
      body: new Uint8Array(audioData),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Recognition failed (${res.status}): ${errText}`);
    }

    const data = await res.json() as {
      RecognitionStatus: string;
      DisplayText?: string;
      NBest?: Array<{ Display: string; Confidence: number }>;
    };

    if (data.RecognitionStatus !== 'Success') {
      return { success: false, error: `Recognition status: ${data.RecognitionStatus}` };
    }

    const bestResult = data.NBest?.[0];
    return {
      success: true,
      text: bestResult?.Display ?? data.DisplayText ?? '',
      confidence: bestResult?.Confidence ?? 0.8,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[SpeechProcessor] STT error:', error);
    return { success: false, error };
  }
}

// ---------------------------------------------------------------------------
// SSML builder — makes Cassidy sound natural, not robotic
// ---------------------------------------------------------------------------

function buildSSML(
  text: string,
  voiceName: string,
  language: string,
  options?: { emphasis?: 'strong' | 'moderate' | 'reduced'; rate?: 'slow' | 'medium' | 'fast' },
): string {
  const rate = options?.rate ?? 'medium';
  const rateMap = { slow: '0.9', medium: '1.0', fast: '1.1' };

  // Apply emphasis to text wrapped in **bold** markdown (common in Cassidy's output)
  let processedText = text
    .replace(/\*\*(.+?)\*\*/g, '<emphasis level="strong">$1</emphasis>')
    .replace(/\n/g, '<break time="300ms"/>');

  // Clean any remaining markdown
  processedText = processedText
    .replace(/[*_~`#]/g, '')
    .replace(/<br\s*\/?>/g, '<break time="200ms"/>');

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"
    xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${language}">
  <voice name="${voiceName}">
    <prosody rate="${rateMap[rate]}">
      <mstts:express-as style="friendly" styledegree="1.2">
        ${processedText}
      </mstts:express-as>
    </prosody>
  </voice>
</speak>`;
}

// ---------------------------------------------------------------------------
// Voice availability check
// ---------------------------------------------------------------------------

export function isVoiceAvailable(): boolean {
  return isSpeechConfigured();
}

export function getVoiceConfig(): { voiceName: string; language: string; configured: boolean } {
  const config = getSpeechConfig();
  return {
    voiceName: config.voiceName,
    language: config.language,
    configured: isSpeechConfigured(),
  };
}
