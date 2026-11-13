"use strict";
/**
 * luba-voice.js — Synthèse vocale Gemini TTS pour LUBA (CommonJS).
 *
 * Variables d'environnement (Render) :
 *   GEMINI_TTS_API_KEY      clé dédiée à la voix (obligatoire pour activer). Alias : GEMINI_VOICE_API_KEY
 *   GEMINI_TTS_API_KEY_2    clé de secours voix (optionnelle)
 *   GEMINI_TTS_MODEL        défaut "gemini-3.8-flash-tts"
 *   GEMINI_TTS_VOICE        défaut "Kore"
 *   GEMINI_TTS_ENABLED      "false" pour désactiver
 *   GEMINI_TTS_TIMEOUT_MS   défaut 12000
 *   GEMINI_TTS_MAX_FAILS    échecs consécutifs avant pause (défaut 3)
 *   GEMINI_TTS_COOLDOWN_MS  durée de pause (défaut 60000)
 */

const VOICES = {
  kore: "Kore", achernar: "Achernar", sulafat: "Sulafat",
  aoede: "Aoede", despina: "Despina", erinome: "Erinome"
};

const LANGUAGES = {
  fr: "French", en: "English", de: "German",
  ln: "Lingala", ja: "Japanese", es: "Spanish"
};

const DEFAULT_MODEL = "gemini-3.8-flash-tts";

function getKeys() {
  return [
    process.env.GEMINI_TTS_API_KEY || process.env.GEMINI_VOICE_API_KEY,
    process.env.GEMINI_TTS_API_KEY_2
  ].map(k => (k || "").trim()).filter(Boolean);
}

function isEnabled() {
  if (String(process.env.GEMINI_TTS_ENABLED || "true").toLowerCase() === "false") return false;
  return getKeys().length > 0;
}

// ---- Santé / disjoncteur ----
const health = { fails: 0, openUntil: 0, lastError: null, lastOkAt: 0, keyIdx: 0 };

function isAvailable() {
  return isEnabled() && Date.now() >= health.openUntil;
}

function recordSuccess() {
  health.fails = 0;
  health.openUntil = 0;
  health.lastOkAt = Date.now();
}

function recordFailure(err) {
  health.fails++;
  health.lastError = String(err && err.message ? err.message : err).slice(0, 200);
  const max = parseInt(process.env.GEMINI_TTS_MAX_FAILS, 10) || 3;
  if (health.fails >= max) {
    health.openUntil = Date.now() + (parseInt(process.env.GEMINI_TTS_COOLDOWN_MS, 10) || 60000);
    health.fails = 0;
  }
}

function getStatus() {
  return {
    enabled: isEnabled(),
    available: isAvailable(),
    model: process.env.GEMINI_TTS_MODEL || DEFAULT_MODEL,
    keys: getKeys().length,
    cooldownMsLeft: Math.max(0, health.openUntil - Date.now()),
    lastError: health.lastError,
    lastOkAt: health.lastOkAt || null
  };
}

// ---- PCM -> WAV ----
function createWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

let _GoogleGenAI = null;
const _clients = new Map();
function getClient(key) {
  if (!_GoogleGenAI) _GoogleGenAI = require("@google/genai").GoogleGenAI;
  if (!_clients.has(key)) _clients.set(key, new _GoogleGenAI({ apiKey: key }));
  return _clients.get(key);
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error("Gemini TTS timeout")), ms); })
  ]).finally(() => clearTimeout(t));
}

function resolveVoice(v) {
  const name = String(v || process.env.GEMINI_TTS_VOICE || "Kore").toLowerCase();
  return VOICES[name] || "Kore";
}

function resolveLanguage(l) {
  const code = String(l || "fr").toLowerCase().slice(0, 2);
  return LANGUAGES[code] ? code : "fr";
}

function buildPrompt(text, lang) {
  return [
    "Tu es LUBA, une assistante vocale féminine, chaleureuse, élégante et naturelle.",
    `Langue de lecture : ${LANGUAGES[lang]}.`,
    "Lis le texte suivant avec un ton posé, souriant et professionnel, sans rien ajouter ni omettre :",
    "",
    text
  ].join("\n");
}

/**
 * Synthétise du texte avec Gemini TTS.
 * @returns {{success:true,audio:Buffer,provider:"gemini",format:"wav",voice:string}|{success:false,error:string}}
 */
async function synthesizeGemini(text, options = {}) {
  if (!text || !String(text).trim()) return { success: false, error: "Texte vide" };
  if (!isAvailable()) return { success: false, error: "Gemini TTS indisponible (désactivé ou en pause)" };

  const keys = getKeys();
  const model = process.env.GEMINI_TTS_MODEL || DEFAULT_MODEL;
  const voiceName = resolveVoice(options.geminiVoice);
  const lang = resolveLanguage(options.language);
  const timeout = parseInt(process.env.GEMINI_TTS_TIMEOUT_MS, 10) || 12000;

  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(health.keyIdx + i) % keys.length];
    try {
      const response = await withTimeout(getClient(key).models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: buildPrompt(String(text), lang) }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
        }
      }), timeout);

      const parts = (response && response.candidates && response.candidates[0] &&
        response.candidates[0].content && response.candidates[0].content.parts) || [];
      const part = parts.find(p => p.inlineData && p.inlineData.data);
      if (!part) throw new Error("Aucun audio dans la réponse Gemini");

      const pcm = Buffer.from(part.inlineData.data, "base64");
      if (!pcm.length) throw new Error("Audio Gemini vide");
      health.keyIdx = (health.keyIdx + i) % keys.length;
      recordSuccess();
      return { success: true, audio: createWav(pcm), provider: "gemini", format: "wav", voice: voiceName };
    } catch (e) {
      lastErr = e;
    }
  }
  recordFailure(lastErr);
  return { success: false, error: "Gemini TTS: " + (lastErr && lastErr.message || "erreur") };
}

module.exports = {
  VOICES, LANGUAGES, createWav, synthesizeGemini,
  isEnabled, isAvailable, getStatus
};
