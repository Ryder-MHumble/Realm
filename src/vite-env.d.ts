/// <reference types="vite/client" />

// Web Speech API types (webkit prefix support)
interface Window {
  SpeechRecognition?: typeof SpeechRecognition;
  webkitSpeechRecognition?: typeof SpeechRecognition;
}
