/**
 * VoiceControl - Voice input UI controller
 *
 * Handles:
 * - Voice recording toggle (mic button, keyboard shortcuts)
 * - Real-time transcript display
 * - Audio level visualization (spectrum bars)
 * - Deepgram WebSocket communication
 * - Error handling and recovery
 *
 * On hosted site: uses cloud proxy for Deepgram
 * On localhost: uses local server via EventClient socket
 */

import { VoiceInput } from "../audio/VoiceInput";
import { soundManager } from "../audio/SoundManager";
import type { EventClient } from "../events/EventClient";
import { keybindManager } from "./KeybindConfig";

/**
 * Check if we're running on the hosted vibecraft.sh site
 */
function isHostedSite(): boolean {
  return window.location.hostname === "vibecraft.sh";
}

/**
 * Get the voice proxy WebSocket URL for hosted mode
 */
function getCloudVoiceUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/voice`;
}

export type VoiceStatus = "idle" | "connecting" | "recording" | "error";

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
  client: EventClient;
  soundEnabled: () => boolean;
  onStateChange?: (state: VoiceState) => void;
}

/**
 * Initialize voice input controls
 * Returns the voice state object if setup succeeds, null otherwise
 */
export function setupVoiceControl(deps: VoiceControlDeps): VoiceState | null {
  const { client, soundEnabled } = deps;

  // DOM elements
  const voiceBtn = document.getElementById(
    "voice-btn",
  ) as HTMLButtonElement | null;
  const promptInput = document.getElementById(
    "prompt-input",
  ) as HTMLTextAreaElement | null;
  const transcriptEl = document.getElementById("voice-transcript");
  const transcriptTextEl = document.getElementById("voice-transcript-text");
  const transcriptLabelEl = transcriptEl?.querySelector(".transcript-label");
  const voiceControlEl = document.getElementById("voice-control");
  const voiceBars = voiceControlEl?.querySelectorAll(".voice-bar") as
    | NodeListOf<HTMLElement>
    | undefined;

  if (!voiceBtn || !promptInput) return null;

  const voiceInput = new VoiceInput();

  // Set up spectrum callback for equalizer visualization
  voiceInput.setSpectrumCallback((levels) => {
    if (voiceBars) {
      levels.forEach((level, i) => {
        if (voiceBars[i]) {
          // Scale height: min 8px, max 36px
          const height = 8 + level * 28;
          voiceBars[i].style.height = `${height}px`;
        }
      });
    }
  });

  // Internal state
  let accumulatedTranscript = "";
  let currentInterim = ""; // Current interim (tentative) transcript
  let existingPromptText = ""; // Text in prompt before recording started
  let isRecording = false;
  let status: VoiceStatus = "idle";
  let error: string | null = null;
  let deepgramReady = false;
  let connectionTimeout: number | null = null;
  let cloudVoiceSocket: WebSocket | null = null; // Used on vibecraft.sh

  // State object that will be exposed
  const voiceState: VoiceState = {
    input: voiceInput,
    isRecording: false,
    status: "idle",
    error: null,
    accumulatedTranscript: "",
    stop: stopRecording,
    toggle: toggleRecording,
  };

  // Sync internal state to exposed state
  const syncState = () => {
    voiceState.isRecording = isRecording;
    voiceState.status = status;
    voiceState.error = error;
    voiceState.accumulatedTranscript = accumulatedTranscript;
    deps.onStateChange?.(voiceState);
  };

  // Update UI to reflect current status
  const updateUI = () => {
    switch (status) {
      case "idle":
        if (transcriptEl) transcriptEl.classList.remove("visible");
        if (voiceControlEl) voiceControlEl.classList.remove("recording");
        voiceBars?.forEach((bar) => {
          bar.style.height = "8px";
        });
        break;
      case "connecting":
        if (voiceControlEl) voiceControlEl.classList.add("recording");
        break;
      case "recording":
        if (transcriptEl) transcriptEl.classList.add("visible");
        if (voiceControlEl) voiceControlEl.classList.add("recording");
        if (transcriptLabelEl) {
          transcriptLabelEl.innerHTML =
            '<span class="recording-dot"></span> Listening...';
        }
        break;
      case "error":
        if (voiceControlEl) voiceControlEl.classList.remove("recording");
        voiceBars?.forEach((bar) => {
          bar.style.height = "8px";
        });
        if (transcriptEl && transcriptTextEl) {
          transcriptEl.classList.add("visible");
          transcriptTextEl.textContent = error || "Unknown error";
          if (transcriptLabelEl) {
            transcriptLabelEl.innerHTML = "⚠️ Error";
          }
          setTimeout(() => {
            if (status === "error") {
              status = "idle";
              error = null;
              updateUI();
              syncState();
            }
          }, 3000);
        }
        break;
    }
    syncState();
  };

  // Set error state
  const setError = (message: string) => {
    status = "error";
    error = message;
    isRecording = false;
    deepgramReady = false;
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
    }
    voiceInput.stop();

    // Close appropriate socket based on mode
    if (isHostedSite()) {
      if (cloudVoiceSocket) {
        cloudVoiceSocket.close();
        cloudVoiceSocket = null;
      }
    } else {
      const socket = client.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "voice_stop" }));
      }
    }
    updateUI();
  };

  // Stop recording and return accumulated transcript
  function stopRecording(): Promise<string> {
    return new Promise((resolve) => {
      if (!isRecording) {
        resolve("");
        return;
      }

      voiceInput.stop();

      // Close appropriate socket based on mode
      if (isHostedSite()) {
        if (cloudVoiceSocket) {
          cloudVoiceSocket.send(JSON.stringify({ type: "voice_stop" }));
          cloudVoiceSocket.close();
          cloudVoiceSocket = null;
        }
      } else {
        const socket = client.socket;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "voice_stop" }));
        }
      }

      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }

      status = "idle";
      isRecording = false;
      deepgramReady = false;
      updateUI();

      if (soundEnabled()) soundManager.play("voice_stop");

      // Wait briefly for any final transcripts
      setTimeout(() => {
        const transcript = accumulatedTranscript;
        accumulatedTranscript = "";
        syncState();

        if (!transcript && transcriptEl && transcriptTextEl) {
          transcriptEl.classList.add("visible");
          transcriptTextEl.textContent = "No speech detected";
          if (transcriptLabelEl) {
            transcriptLabelEl.innerHTML = "ℹ️ Info";
          }
          setTimeout(() => {
            transcriptEl.classList.remove("visible");
          }, 2000);
        }

        resolve(transcript);
      }, 300);
    });
  }

  // Get the socket to use for voice (cloud or local)
  function getVoiceSocket(): WebSocket | null {
    if (isHostedSite()) {
      return cloudVoiceSocket;
    }
    return client.socket;
  }

  // Handle messages from cloud voice socket
  function handleCloudVoiceMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "voice_status" && data.status === "listening") {
        deepgramReady = true;
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
      } else if (data.type === "voice_transcript") {
        handleTranscript(data);
      } else if (data.type === "voice_error") {
        setError(data.error || "Transcription error");
      }
    } catch {
      // Ignore non-JSON messages
    }
  }

  // Handle transcript data (used by both local and cloud)
  function handleTranscript(data: {
    transcript?: string;
    is_final?: boolean;
    speech_final?: boolean;
  }) {
    const transcript = data.transcript;
    if (!transcript) return;

    if (data.is_final || data.speech_final) {
      // Final transcript - add to accumulated, clear interim
      accumulatedTranscript += (accumulatedTranscript ? " " : "") + transcript;
      currentInterim = "";
    } else {
      // Interim transcript - update current interim (will be replaced by next interim)
      currentInterim = transcript;
    }

    // Update transcript display (floating label)
    if (transcriptTextEl) {
      const displayText =
        accumulatedTranscript +
        (currentInterim
          ? (accumulatedTranscript ? " " : "") + currentInterim
          : "");
      transcriptTextEl.textContent = displayText || "Listening...";
      if (transcriptLabelEl) {
        transcriptLabelEl.textContent = data.is_final
          ? "Transcript:"
          : "Listening...";
      }
    }

    // Stream to prompt input in real-time
    if (promptInput) {
      const parts: string[] = [];
      if (existingPromptText) parts.push(existingPromptText);
      if (accumulatedTranscript) parts.push(accumulatedTranscript);
      if (currentInterim) parts.push(currentInterim);
      promptInput.value = parts.join(" ");
      promptInput.dispatchEvent(new Event("input")); // Trigger auto-resize
    }

    voiceState.accumulatedTranscript = accumulatedTranscript;
    deps.onStateChange?.(voiceState);
  }

  // Start recording
  async function startRecording(): Promise<boolean> {
    status = "connecting";
    deepgramReady = false;
    // Capture existing text in prompt before we start adding transcript
    existingPromptText = promptInput?.value.trim() ?? "";
    currentInterim = "";
    updateUI();

    // For hosted site, create dedicated voice WebSocket
    if (isHostedSite()) {
      try {
        cloudVoiceSocket = new WebSocket(getCloudVoiceUrl());

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Connection timeout")),
            5000,
          );

          cloudVoiceSocket!.onopen = () => {
            clearTimeout(timeout);
            cloudVoiceSocket!.send(JSON.stringify({ type: "voice_start" }));
            resolve();
          };

          cloudVoiceSocket!.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("Failed to connect to voice service"));
          };

          cloudVoiceSocket!.onmessage = handleCloudVoiceMessage;

          cloudVoiceSocket!.onclose = () => {
            if (isRecording) {
              cancelRecording();
            }
          };
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Voice connection failed");
        return false;
      }
    } else {
      // Local mode - use EventClient socket
      const socket = client.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        setError("Not connected to server");
        return false;
      }
      socket.send(JSON.stringify({ type: "voice_start" }));
    }

    connectionTimeout = window.setTimeout(() => {
      if (status === "connecting") {
        setError("Transcription service timeout");
      }
    }, 5000);

    const voiceSocket = getVoiceSocket();
    const started = await voiceInput.start((audioData) => {
      if (voiceSocket && voiceSocket.readyState === WebSocket.OPEN) {
        voiceSocket.send(audioData);
      }
    });

    if (!started) {
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }
      setError("Microphone access denied");
      if (voiceSocket?.readyState === WebSocket.OPEN) {
        voiceSocket.send(JSON.stringify({ type: "voice_stop" }));
      }
      if (cloudVoiceSocket) {
        cloudVoiceSocket.close();
        cloudVoiceSocket = null;
      }
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    if (status === "connecting") {
      status = "recording";
      isRecording = true;
      accumulatedTranscript = "";
      updateUI();
      if (soundEnabled()) soundManager.play("voice_start");
    }

    return true;
  }

  // Cancel recording without sending
  function cancelRecording() {
    if (!isRecording && status !== "connecting") return;

    voiceInput.stop();

    // Close appropriate socket based on mode
    if (isHostedSite()) {
      if (cloudVoiceSocket) {
        cloudVoiceSocket.send(JSON.stringify({ type: "voice_stop" }));
        cloudVoiceSocket.close();
        cloudVoiceSocket = null;
      }
    } else {
      const socket = client.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "voice_stop" }));
      }
    }

    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
    }

    accumulatedTranscript = "";
    status = "idle";
    isRecording = false;
    deepgramReady = false;
    updateUI();

    if (soundEnabled()) soundManager.play("voice_stop");
  }

  // Toggle recording
  async function toggleRecording() {
    if (status === "error") {
      status = "idle";
      error = null;
      updateUI();
      return;
    }

    if (isRecording || status === "connecting") {
      await stopRecording();
      // Transcript is already streamed to promptInput in real-time, just focus
      promptInput?.focus();
    } else {
      await startRecording();
    }
  }

  // Handle messages from server
  client.onRawMessage((data) => {
    if (data.type === "voice_ready") {
      deepgramReady = true;
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }
      if (status === "connecting") {
        status = "recording";
        isRecording = true;
        updateUI();
        if (soundEnabled()) soundManager.play("voice_start");
      }
    } else if (data.type === "voice_transcript") {
      const { transcript, isFinal } = data.payload as {
        transcript: string;
        isFinal: boolean;
      };
      // Use shared handler for consistent streaming behavior
      handleTranscript({ transcript, is_final: isFinal });
      if (transcriptEl) transcriptEl.classList.toggle("interim", !isFinal);
    } else if (data.type === "voice_utterance_end") {
      // Utterance end - clear interim, transcript is already in promptInput
      currentInterim = "";
      syncState();
    } else if (data.type === "voice_error") {
      const payload = data.payload as { error?: string };
      const errorMsg = payload?.error || "Transcription error";

      if (errorMsg.includes("not configured")) {
        setError("Voice not configured (missing API key)");
      } else if (errorMsg.includes("rate") || errorMsg.includes("limit")) {
        setError("Rate limit exceeded");
      } else {
        setError(errorMsg);
      }
    }
  });

  // Click to toggle
  voiceBtn.addEventListener("click", toggleRecording);

  // Get form for global submit
  const promptForm = document.getElementById(
    "prompt-form",
  ) as HTMLFormElement | null;

  // Keyboard shortcuts
  document.addEventListener("keydown", async (e) => {
    // Voice toggle (Ctrl+M by default, user-configurable)
    if (keybindManager.matches("voice-toggle", e)) {
      e.preventDefault();
      toggleRecording();
      return;
    }

    // Escape to cancel recording (not configurable - standard behavior)
    if (e.key === "Escape" && (isRecording || status === "connecting")) {
      e.preventDefault();
      e.stopPropagation();
      cancelRecording();
      promptInput?.focus();
      return;
    }

    // Enter stops voice recording and sends
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      // If recording, Enter stops and sends (voice-specific shortcut)
      if (isRecording || status === "connecting") {
        e.preventDefault();
        await stopRecording();
        // Transcript is already streamed to promptInput, just submit if there's text
        if (promptInput?.value.trim() && promptForm) {
          promptForm.requestSubmit();
        }
        return;
      }

      // Cmd/Ctrl+Enter to send from outside textarea
      if (e.ctrlKey || e.metaKey) {
        const activeEl = document.activeElement;
        const isInTextArea =
          activeEl?.tagName === "TEXTAREA" || activeEl?.tagName === "INPUT";
        if (!isInTextArea && promptInput?.value.trim() && promptForm) {
          e.preventDefault();
          promptForm.requestSubmit();
        }
      }
    }
  });

  return voiceState;
}
