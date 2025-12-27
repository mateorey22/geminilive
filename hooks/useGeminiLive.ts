import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveSession, LiveServerMessage, Blob, FunctionDeclaration, Type } from '@google/genai';
import { Connection, McpServer } from '../components/SettingsPanel';

// --- Type Definitions ---
export enum ConversationState {
  IDLE,
  CONNECTING,
  ACTIVE,
  ERROR,
}

export interface ConversationSettings {
  apiKey: string;
  voice: string;
  emotion: boolean;
  connections: Connection[];
  mcpServers: McpServer[];
  personality: string;
}

// --- Audio Utility Functions ---

function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

function createPcmBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

// --- The Custom Hook ---

export const useGeminiLive = () => {
  const [conversationState, setConversationState] = useState<ConversationState>(ConversationState.IDLE);
  const [isGeminiSpeaking, setIsGeminiSpeaking] = useState<boolean>(false);
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Session refs
  const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);

  // Audio refs
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const speakingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Video refs
  const [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [activeCameraDeviceId, setActiveCameraDeviceId] = useState<string | null>(null);
  const [activeVideoStream, setActiveVideoStream] = useState<MediaStream | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // On hook initialization, enumerate cameras
  useEffect(() => {
    const enumerateCameras = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        stream.getTracks().forEach(track => track.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        if (videoDevices.length > 0) {
          setAvailableCameras(videoDevices);
        }
      } catch (error) {
        console.warn("Could not enumerate camera devices. The feature might be limited.", error);
      }
    };
    enumerateCameras();
  }, []);

  const stopCameraStream = useCallback(() => {
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach(track => track.stop());
      videoStreamRef.current = null;
    }
    setActiveVideoStream(null);
    setActiveCameraDeviceId(null);
  }, []);

  const startCameraStream = useCallback(async (deviceId: string) => {
    if (!sessionPromiseRef.current) return;

    stopCameraStream();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } }
      });

      setActiveVideoStream(stream);
      videoStreamRef.current = stream;

      const videoTrack = stream.getVideoTracks()[0];
      // @ts-ignore
      const imageCapture = new ImageCapture(videoTrack);

      frameIntervalRef.current = setInterval(async () => {
        try {
          const imageBitmap = await imageCapture.grabFrame();
          const canvas = document.createElement('canvas');
          canvas.width = imageBitmap.width;
          canvas.height = imageBitmap.height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(imageBitmap, 0, 0);
          const base64Data = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];

          const imageBlob: Blob = {
            data: base64Data,
            mimeType: 'image/jpeg',
          };
          sessionPromiseRef.current?.then(session => {
            session.sendRealtimeInput({ media: imageBlob });
          });
        } catch (e) {
          console.error("Could not grab frame:", e);
          stopCameraStream();
          setIsCameraActive(false);
        }
      }, 1000 / 2); // 2 FPS
    } catch (e) {
      console.error("Failed to start camera stream:", e);
      setErrorMessage("Could not access camera. Please check permissions.");
      setIsCameraActive(false);
    }
  }, [stopCameraStream]);

  const stopConversation = useCallback(async () => {
    if (speakingTimeoutRef.current) {
      clearTimeout(speakingTimeoutRef.current);
    }

    if (sessionPromiseRef.current) {
      try {
        const session = await sessionPromiseRef.current;
        session.close();
      } catch (e) {
        console.error("Error closing session:", e);
      }
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    stopCameraStream();

    scriptProcessorRef.current?.disconnect();
    mediaStreamSourceRef.current?.disconnect();
    inputAudioContextRef.current?.close();
    outputAudioContextRef.current?.close();

    // Reset all refs and state
    sessionPromiseRef.current = null;
    mediaStreamRef.current = null;
    scriptProcessorRef.current = null;
    mediaStreamSourceRef.current = null;
    inputAudioContextRef.current = null;
    outputAudioContextRef.current = null;
    nextStartTimeRef.current = 0;
    audioSourcesRef.current.clear();
    setConversationState(ConversationState.IDLE);
    setIsGeminiSpeaking(false);
    setIsCameraActive(false);
    setErrorMessage(null);
  }, [stopCameraStream]);

  const toggleCamera = useCallback(() => {
    setIsCameraActive(prev => !prev);
  }, []);

  useEffect(() => {
    if (isCameraActive && activeCameraDeviceId) {
      startCameraStream(activeCameraDeviceId);
    } else if (!isCameraActive) {
      stopCameraStream();
    }

    return () => {
      stopCameraStream();
    };
  }, [isCameraActive, activeCameraDeviceId, startCameraStream, stopCameraStream]);

  const startConversation = useCallback(async (settings: ConversationSettings) => {
    setConversationState(ConversationState.CONNECTING);
    setErrorMessage(null);

    try {
      const gApiKey = settings.apiKey || process.env.GEMINI_API_KEY || '';
      if (!gApiKey) {
        throw new Error('Gemini API Key is missing. Please enter it in Settings.');
      }
      const ai = new GoogleGenAI({ apiKey: gApiKey });

      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });

      const personalityInstruction = settings.personality;
      const fallbackInstruction = settings.emotion
        ? 'You are a friendly, expressive, and emotional AI assistant.'
        : 'You are a friendly and helpful AI assistant.';
      let baseSystemInstruction = personalityInstruction || fallbackInstruction;

      // Add camera context to the system prompt
      if (availableCameras.length > 0) {
        const cameraNames = availableCameras.map(cam => `'${cam.label}'`).join(', ');
        const cameraInstruction = ` You have a tool called 'start_camera_view' to see through the user's camera. The available cameras are: ${cameraNames}. When the user asks you to look at something, call this tool. You can specify which camera to use by its label. On a phone, the back camera is usually best for looking at things.`;
        baseSystemInstruction += cameraInstruction;
      }

      const systemInstruction = baseSystemInstruction + ' When a user\'s request matches one of your available tools, you must use that tool.';

      // 1. Add Webhook Tools
      const functionDeclarations: FunctionDeclaration[] = settings.connections.map(conn => ({
        name: conn.name,
        description: conn.description,
        parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: `The user's complete and exact request.` } }, required: ['query'] },
      }));

      // 2. Add MCP Tools
      if (settings.mcpServers) {
        settings.mcpServers.forEach(server => {
          // Check if tools exist and add them
          if (server.tools && Array.isArray(server.tools)) {
            functionDeclarations.push(...server.tools);
          }
        });
      }

      // 3. Add the built-in camera tool
      functionDeclarations.push({
        name: 'start_camera_view',
        description: "Activates the user's camera when they ask you to look at, see, or watch something. Use the 'cameraLabel' parameter to specify which camera to activate from the provided list.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            cameraLabel: {
              type: Type.STRING,
              description: "The label of the camera to use from the available list of cameras."
            }
          }
        }
      });

      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } },
          systemInstruction: systemInstruction,
          tools: [{ functionDeclarations }],
        },
        callbacks: {
          onopen: () => {
            setConversationState(ConversationState.ACTIVE);
            if (!mediaStreamRef.current || !inputAudioContextRef.current) return;
            mediaStreamSourceRef.current = inputAudioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
            scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromiseRef.current?.then((session) => { session.sendRealtimeInput({ media: pcmBlob }); });
            };
            mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
            scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                // A) Handle internal camera tool
                if (fc.name === 'start_camera_view') {
                  const requestedLabel = (fc.args as { cameraLabel?: string })?.cameraLabel;
                  let selectedDevice: MediaDeviceInfo | undefined;

                  if (requestedLabel) {
                    // Find the camera that best matches the requested label
                    selectedDevice = availableCameras.find(cam => cam.label.toLowerCase().includes(requestedLabel.toLowerCase()));
                  }

                  // Fallback logic if no specific camera was found or requested
                  if (!selectedDevice && availableCameras.length > 0) {
                    const isMobile = /Mobi|Android/i.test(navigator.userAgent);
                    if (isMobile) {
                      // On mobile, prefer the back camera ('environment')
                      selectedDevice = availableCameras.find(cam => cam.label.toLowerCase().includes('back')) || availableCameras[0];
                    } else {
                      // On desktop, use the first available camera
                      selectedDevice = availableCameras[0];
                    }
                  }

                  if (selectedDevice) {
                    setActiveCameraDeviceId(selectedDevice.deviceId);
                    setIsCameraActive(true);
                    sessionPromiseRef.current?.then((session) => {
                      session.sendToolResponse({
                        functionResponses: { id: fc.id, name: fc.name, response: { result: "Ok, the camera is now active. I can see what you're showing me." } },
                      });
                    });
                  } else {
                    sessionPromiseRef.current?.then((session) => {
                      session.sendToolResponse({
                        functionResponses: { id: fc.id, name: fc.name, response: { result: "Sorry, I couldn't find a suitable camera to activate." } },
                      });
                    });
                  }
                  continue;
                }

                // B) Handle MCP Tool Calls (Agent Zero)
                let mcpServer: McpServer | undefined;
                if (settings.mcpServers) {
                  mcpServer = settings.mcpServers.find(s => s.tools.some(t => t.name === fc.name));
                }

                if (mcpServer) {
                  (async () => {
                    try {
                      // Send JSON-RPC 2.0 Request to the MCP Post URL
                      const rpcRequest = {
                        jsonrpc: "2.0",
                        method: "tools/call",
                        id: Date.now(), // Request ID
                        params: {
                          name: fc.name,
                          arguments: fc.args || {}
                        }
                      };

                      const fetchOptions: RequestInit = {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(rpcRequest)
                      };

                      if (mcpServer.useCredentials) {
                        fetchOptions.credentials = 'include';
                      }

                      const response = await fetch(mcpServer.postUrl, fetchOptions);

                      if (!response.ok) throw new Error(`MCP Call failed: ${response.statusText}`);

                      const rpcResponse = await response.json();

                      // The result is usually in rpcResponse.result.content
                      // MCP defines content as a list of text/images.
                      const result = rpcResponse.result?.content
                        ? rpcResponse.result.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
                        : JSON.stringify(rpcResponse.result || rpcResponse);

                      sessionPromiseRef.current?.then((session) => {
                        session.sendToolResponse({
                          functionResponses: [{ id: fc.id, name: fc.name, response: { result: result } }],
                        });
                      });

                    } catch (e) {
                      console.error(`MCP execution failed for ${fc.name}:`, e);
                      sessionPromiseRef.current?.then((session) => {
                        session.sendToolResponse({
                          functionResponses: { id: fc.id, name: fc.name, response: { result: `Error executing MCP tool: ${(e as Error).message}` } },
                        });
                      });
                    }
                  })();
                  continue;
                }

                // C) Handle external tools (N8N Webhooks) non-blockingly
                const connection = settings.connections.find(c => c.name === fc.name);
                if (connection) {
                  // Fire-and-forget the webhook call
                  (async () => {
                    try {
                      const webhookResponse = await fetch(connection.url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(fc.args),
                      });

                      const responseText = await webhookResponse.text();
                      sessionPromiseRef.current?.then((session) => {
                        session.sendToolResponse({
                          functionResponses: { id: fc.id, name: fc.name, response: { result: responseText } },
                        });
                      });
                    } catch (e) {
                      console.error(`Webhook call failed for ${fc.name}:`, e);
                      sessionPromiseRef.current?.then((session) => {
                        session.sendToolResponse({
                          functionResponses: { id: fc.id, name: fc.name, response: { result: `Error calling tool: ${(e as Error).message}` } },
                        });
                      });
                    }
                  })();
                }
              }
            }

            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              setIsGeminiSpeaking(true);
              if (speakingTimeoutRef.current) clearTimeout(speakingTimeoutRef.current);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContextRef.current, 24000, 1);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContextRef.current.currentTime);
              const source = outputAudioContextRef.current.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAudioContextRef.current.destination);
              source.addEventListener('ended', () => {
                audioSourcesRef.current.delete(source);
                if (audioSourcesRef.current.size === 0) {
                  speakingTimeoutRef.current = setTimeout(() => setIsGeminiSpeaking(false), 300);
                }
              });
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              for (const source of audioSourcesRef.current.values()) { source.stop(); }
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsGeminiSpeaking(false);
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error('Gemini Live API Error:', e);
            setErrorMessage(e.message || 'A connection error occurred.');
            setConversationState(ConversationState.ERROR);
            stopConversation();
          },
          onclose: (e: CloseEvent) => { stopConversation(); },
        },
      });
    } catch (error: any) {
      console.error('Failed to start conversation:', error);
      setErrorMessage(error.message || 'Failed to initialize.');
      setConversationState(ConversationState.ERROR);
      await stopConversation();
    }
  }, [stopConversation, availableCameras, startCameraStream]);

  return { conversationState, isGeminiSpeaking, isCameraActive, errorMessage, startConversation, stopConversation, toggleCamera, activeVideoStream };
};