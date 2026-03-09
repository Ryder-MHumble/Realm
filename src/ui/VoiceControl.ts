/**
 * VoiceControl - ChatGPT-style voice mode controller
 *
 * When the mic button is clicked, the prompt form hides and a voice
 * visualization + Send/Stop bar appears in its place.
 *
 * - Send button: stop recording, submit transcript immediately
 * - Stop button: stop recording, put transcript in textarea, return to text mode
 * - No global keyboard shortcut (avoids accidental triggers while typing)
 *
 * Uses the Web Speech API (SpeechRecognition) — no server or API key needed.
 * Voice recognition language is independently configurable (zh-CN / en-US)
 * with a toggle button, separate from the UI locale.
 */

import { VoiceInput } from "../audio/VoiceInput";
import { soundManager } from "../audio/SoundManager";
import { getLocale, t } from "../i18n/index";

export type VoiceStatus = "idle" | "connecting" | "recording" | "error";
export type VoiceLang = "en" | "zh";

export interface VoiceState {
  input: VoiceInput;
  isRecording: boolean;
  status: VoiceStatus;
  error: string | null;
  accumulatedTranscript: string;
  stop: () => Promise<string>;
  toggle: () => void;
}

interface VoiceControlDeps {
  soundEnabled: () => boolean;
  onStateChange?: (state: VoiceState) => void;
}

/** Get SpeechRecognition constructor (handles webkit prefix) */
function getSpeechRecognitionCtor(): (new () => any) | null {
  return (
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition ||
    null
  );
}

// ---- Voice language preference (independent of UI locale) ----

const VOICE_LANG_KEY = "realm-voice-lang";

/** Get saved voice recognition language, defaults to current i18n locale */
function getVoiceLang(): VoiceLang {
  const saved = localStorage.getItem(VOICE_LANG_KEY) as VoiceLang | null;
  if (saved === "zh" || saved === "en") return saved;
  return getLocale() === "zh" ? "zh" : "en";
}

/** Save voice recognition language preference */
function setVoiceLang(lang: VoiceLang): void {
  localStorage.setItem(VOICE_LANG_KEY, lang);
}

/** Map voice lang to BCP-47 tag for SpeechRecognition */
function toBcp47(lang: VoiceLang): string {
  return lang === "zh" ? "zh-CN" : "en-US";
}

/**
 * Join two text segments with the correct separator for the given language.
 * Chinese: no space. English: space.
 */
export function joinText(a: string, b: string, lang?: VoiceLang): string {
  if (!a) return b;
  if (!b) return a;
  const effectiveLang = lang ?? getVoiceLang();
  return effectiveLang === "zh" ? a + b : a + " " + b;
}

/**
 * Initialize voice input controls (ChatGPT-style mode toggle).
 * Returns the voice state object if setup succeeds, null otherwise.
 */
export function setupVoiceControl(deps: VoiceControlDeps): VoiceState | null {
  const { soundEnabled } = deps;

  // Check browser support
  const SpeechRecognitionCtor = getSpeechRecognitionCtor();
  if (!SpeechRecognitionCtor) return null;

  // DOM elements — AI-native layout (voice mode hides prompt-container)
  const micBtn = document.getElementById(
    "voice-mode-btn",
  ) as HTMLButtonElement | null;
  const promptForm = document.getElementById(
    "prompt-form",
  ) as HTMLFormElement | null;
  const promptContainer = document.getElementById(
    "prompt-container",
  ) as HTMLElement | null;
  const voiceModeEl = document.getElementById("voice-mode");
  const promptInput = document.getElementById(
    "prompt-input",
  ) as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById(
    "voice-send-btn",
  ) as HTMLButtonElement | null;
  const stopBtn = document.getElementById(
    "voice-stop-btn",
  ) as HTMLButtonElement | null;
  const voiceBars = voiceModeEl?.querySelectorAll(".voice-bar") as
    | NodeListOf<HTMLElement>
    | undefined;
  const voiceLangBtn = document.getElementById(
    "voice-lang-btn",
  ) as HTMLButtonElement | null;
  const voiceTranscriptEl = document.getElementById("voice-transcript");
  const voiceTranscriptText = document.getElementById("voice-transcript-text");
  const voiceTranscriptInterim = document.getElementById(
    "voice-transcript-interim",
  );

  if (
    !micBtn ||
    !promptForm ||
    !promptContainer ||
    !voiceModeEl ||
    !promptInput
  )
    return null;

  // Capture as non-null for use inside nested functions
  const form = promptForm;
  const container = promptContainer;
  const voiceMode = voiceModeEl;
  const input = promptInput;

  const voiceInput = new VoiceInput();

  // Spectrum visualization callback
  voiceInput.setSpectrumCallback((levels) => {
    if (voiceBars) {
      levels.forEach((level, i) => {
        if (voiceBars[i]) {
          const height = 4 + level * 28;
          voiceBars[i].style.height = `${height}px`;
        }
      });
    }
  });

  // SpeechRecognition instance
  const recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;

  // Internal state
  let accumulatedTranscript = "";
  let currentInterim = "";
  let existingPromptText = "";
  let isRecording = false;
  let status: VoiceStatus = "idle";
  let error: string | null = null;
  let voiceLang: VoiceLang = getVoiceLang();

  // Exposed state object
  const voiceState: VoiceState = {
    input: voiceInput,
    isRecording: false,
    status: "idle",
    error: null,
    accumulatedTranscript: "",
    stop: stopRecording,
    toggle: toggleRecording,
  };

  const syncState = () => {
    voiceState.isRecording = isRecording;
    voiceState.status = status;
    voiceState.error = error;
    voiceState.accumulatedTranscript = accumulatedTranscript;
    deps.onStateChange?.(voiceState);
  };

  // ---- Language toggle ----

  function updateLangButton() {
    if (voiceLangBtn) {
      voiceLangBtn.textContent = voiceLang === "zh" ? "中" : "EN";
      voiceLangBtn.title =
        voiceLang === "zh"
          ? t("voice.switchToEnglish")
          : t("voice.switchToChinese");
    }
  }

  // Initialize button state
  updateLangButton();

  voiceLangBtn?.addEventListener("click", () => {
    voiceLang = voiceLang === "zh" ? "en" : "zh";
    setVoiceLang(voiceLang);
    updateLangButton();

    // If currently recording, restart recognition with new language
    if (isRecording) {
      recognition.lang = toBcp47(voiceLang);
      try {
        recognition.abort();
      } catch {
        // ignore — onend handler will restart with the updated lang
      }
    }
  });

  // ---- Transcript display ----

  function clearTranscriptDisplay() {
    if (voiceTranscriptText) voiceTranscriptText.textContent = "";
    if (voiceTranscriptInterim) voiceTranscriptInterim.textContent = "";
    if (voiceTranscriptEl) voiceTranscriptEl.classList.add("hidden");
  }

  function updateTranscriptDisplay() {
    // Build display text from existing + accumulated
    const displayParts: string[] = [];
    if (existingPromptText) displayParts.push(existingPromptText);
    if (accumulatedTranscript) displayParts.push(accumulatedTranscript);
    if (voiceTranscriptText) {
      voiceTranscriptText.textContent = displayParts.reduce(
        (acc, part) => joinText(acc, part, voiceLang),
        "",
      );
    }
    if (voiceTranscriptInterim) {
      voiceTranscriptInterim.textContent = currentInterim;
    }

    // Show transcript area when there's content
    if (voiceTranscriptEl) {
      const hasContent = accumulatedTranscript || currentInterim;
      voiceTranscriptEl.classList.toggle("hidden", !hasContent);
    }
  }

  // ---- UI mode switching ----

  /** Switch to voice mode: hide prompt container, show voice visualization */
  function enterVoiceMode() {
    container.style.display = "none";
    voiceMode.classList.remove("hidden");
  }

  /** Switch back to text mode: show prompt container, hide voice visualization */
  function exitVoiceMode() {
    voiceMode.classList.add("hidden");
    container.style.display = "";
    // Reset bar heights
    voiceBars?.forEach((bar) => {
      bar.style.height = "4px";
    });
    clearTranscriptDisplay();
  }

  // ---- Recording control ----

  /** Start recording and enter voice mode */
  async function startRecording(): Promise<boolean> {
    status = "connecting";
    existingPromptText = input.value.trim();
    currentInterim = "";
    enterVoiceMode();
    clearTranscriptDisplay();
    syncState();

    // Start microphone for spectrum visualization
    const started = await voiceInput.start(() => {
      // No-op — SpeechRecognition handles transcription directly
    });

    if (!started) {
      setError("Microphone access denied");
      return false;
    }

    // Configure language from saved preference
    voiceLang = getVoiceLang();
    recognition.lang = toBcp47(voiceLang);
    updateLangButton();

    try {
      recognition.start();
    } catch {
      setError("Speech recognition failed to start");
      voiceInput.stop();
      return false;
    }

    status = "recording";
    isRecording = true;
    accumulatedTranscript = "";
    syncState();
    if (soundEnabled()) soundManager.play("voice_start");
    return true;
  }

  /** Stop recording and return accumulated transcript */
  function stopRecording(): Promise<string> {
    return new Promise((resolve) => {
      if (!isRecording) {
        resolve("");
        return;
      }

      voiceInput.stop();
      try {
        recognition.stop();
      } catch {
        // ignore
      }

      status = "idle";
      isRecording = false;
      syncState();

      if (soundEnabled()) soundManager.play("voice_stop");

      // Wait briefly for any final results
      setTimeout(() => {
        const transcript = accumulatedTranscript;
        accumulatedTranscript = "";
        clearTranscriptDisplay();
        syncState();
        resolve(transcript);
      }, 300);
    });
  }

  /** Cancel recording without keeping transcript */
  function cancelRecording() {
    if (!isRecording && status !== "connecting") return;

    voiceInput.stop();
    try {
      recognition.abort();
    } catch {
      // ignore
    }

    accumulatedTranscript = "";
    status = "idle";
    isRecording = false;
    exitVoiceMode();
    syncState();

    if (soundEnabled()) soundManager.play("voice_stop");
  }

  /** Set error state and exit voice mode */
  function setError(message: string) {
    status = "error";
    error = message;
    isRecording = false;
    voiceInput.stop();
    try {
      recognition.abort();
    } catch {
      // ignore
    }
    exitVoiceMode();
    syncState();

    // Clear error after a moment
    setTimeout(() => {
      if (status === "error") {
        status = "idle";
        error = null;
        syncState();
      }
    }, 3000);
  }

  /** Toggle recording on/off */
  async function toggleRecording() {
    if (status === "error") {
      status = "idle";
      error = null;
      syncState();
      return;
    }

    if (isRecording || status === "connecting") {
      // Stop and put transcript in textarea (same as Stop button)
      await handleStop();
    } else {
      await startRecording();
    }
  }

  // ---- Transcript handling ----

  function handleTranscript(data: { transcript?: string; is_final?: boolean }) {
    const transcript = data.transcript;
    if (!transcript) return;

    if (data.is_final) {
      accumulatedTranscript = joinText(
        accumulatedTranscript,
        transcript,
        voiceLang,
      );
      currentInterim = "";
    } else {
      currentInterim = transcript;
    }

    // Stream to prompt input in real-time (for form submission)
    const parts: string[] = [];
    if (existingPromptText) parts.push(existingPromptText);
    if (accumulatedTranscript) parts.push(accumulatedTranscript);
    if (currentInterim) parts.push(currentInterim);
    input.value = parts.reduce(
      (acc, part) => joinText(acc, part, voiceLang),
      "",
    );
    input.dispatchEvent(new Event("input")); // Trigger auto-resize

    // Update visible transcript display
    updateTranscriptDisplay();

    voiceState.accumulatedTranscript = accumulatedTranscript;
    deps.onStateChange?.(voiceState);
  }

  // ---- SpeechRecognition events ----

  recognition.onresult = (event: any) => {
    let finalTranscript = "";
    let interimTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      } else {
        interimTranscript += result[0].transcript;
      }
    }

    if (finalTranscript) {
      handleTranscript({ transcript: finalTranscript, is_final: true });
    }
    if (interimTranscript) {
      handleTranscript({ transcript: interimTranscript, is_final: false });
    }
  };

  recognition.onend = () => {
    // Chrome may stop on silence — restart if still recording
    if (isRecording) {
      try {
        recognition.start();
      } catch {
        // ignore
      }
    }
  };

  recognition.onerror = (event: any) => {
    if (event.error === "no-speech") return;
    if (event.error === "aborted") return;

    if (
      event.error === "not-allowed" ||
      event.error === "service-not-allowed"
    ) {
      setError("Microphone access denied");
    } else if (event.error === "network") {
      setError("Speech recognition network error");
    } else {
      setError(event.error);
    }
  };

  // ---- Button handlers ----

  /** Send button: stop recording + submit form immediately */
  async function handleSend() {
    const transcript = await stopRecording();
    exitVoiceMode();

    // Ensure transcript is in the input
    if (transcript) {
      const existing = existingPromptText;
      input.value = joinText(existing, transcript, voiceLang);
      input.dispatchEvent(new Event("input"));
    }

    // Submit the form if there's text
    if (input.value.trim()) {
      form.requestSubmit();
    } else {
      input.focus();
    }
  }

  /** Stop button: stop recording + return to text mode with transcript in textarea */
  async function handleStop() {
    await stopRecording();
    exitVoiceMode();
    // Transcript is already streamed to input in real-time
    input.focus();
  }

  // Mic button — enter voice mode
  micBtn.addEventListener("click", () => {
    if (!isRecording && status !== "connecting") {
      startRecording();
    }
  });

  // Send button in voice mode
  sendBtn?.addEventListener("click", handleSend);

  // Stop button in voice mode
  stopBtn?.addEventListener("click", handleStop);

  // Escape while in voice mode — cancel
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (isRecording || status === "connecting")) {
      e.preventDefault();
      e.stopPropagation();
      cancelRecording();
      input.focus();
    }
  });

  return voiceState;
}
