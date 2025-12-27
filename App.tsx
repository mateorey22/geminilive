// Fix: The original App.tsx file contained invalid placeholder text.
// It has been replaced with a fully functional root component for the application.
// FIX: Import useState, useEffect, and useCallback from 'react' to resolve missing name errors.
import React, { useState, useEffect, useCallback } from 'react';
import { useGeminiLive, ConversationState } from './hooks/useGeminiLive';
import { SettingsPanel, AppSettings } from './components/SettingsPanel';
import { ImmersiveVisualizer } from './components/ImmersiveVisualizer';

const DEFAULT_SETTINGS: AppSettings = {
  voice: 'Zephyr',
  emotion: true,
  connections: [],
  mcpServers: [],
  personality: '',
};

function App() {
  const {
    conversationState,
    isGeminiSpeaking,
    isCameraActive,
    errorMessage,
    startConversation,
    stopConversation,
    toggleCamera,
    activeVideoStream,
  } = useGeminiLive();

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Load settings from localStorage on initial render
  useEffect(() => {
    try {
      const savedSettingsJson = localStorage.getItem('gemini-live-settings');
      if (savedSettingsJson) {
        const savedSettings = JSON.parse(savedSettingsJson);
        // Merge saved settings with defaults to ensure all keys are present
        // Remove apiKey from saved settings if it exists to clean up
        const { apiKey, ...cleanSettings } = savedSettings;
        setSettings(prevSettings => ({ ...DEFAULT_SETTINGS, ...cleanSettings }));
      }
    } catch (error) {
      console.error('Failed to parse settings from localStorage:', error);
    }
  }, []);

  const handleSaveSettings = useCallback((newSettings: AppSettings) => {
    setSettings(newSettings);
    try {
      localStorage.setItem('gemini-live-settings', JSON.stringify(newSettings));
    } catch (error) {
      console.error('Failed to save settings to localStorage:', error);
    }
    setIsSettingsOpen(false);
  }, []);

  const handleVisualizerClick = () => {
    if (
      conversationState === ConversationState.IDLE ||
      conversationState === ConversationState.ERROR
    ) {
      startConversation(settings);
    } else {
      stopConversation();
    }
  };
  
  const getStatusText = () => {
    switch (conversationState) {
        case ConversationState.IDLE:
            return 'Click to start';
        case ConversationState.CONNECTING:
            return 'Connecting...';
        case ConversationState.ACTIVE:
            if (isCameraActive) return 'Visual analysis active...';
            if (isGeminiSpeaking) return 'Speaking...';
            return 'Listening...';
        case ConversationState.ERROR:
            return 'Error';
        default:
            return '';
    }
  };

  return (
    <div className="bg-black text-white w-screen h-screen flex flex-col items-center justify-center font-sans overflow-hidden relative">
        <div className="absolute top-6 right-6 z-20">
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-3 bg-gray-800 bg-opacity-70 rounded-full hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-white"
              aria-label="Open settings"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
        </div>

        <div className="w-full h-full absolute flex items-center justify-center pointer-events-none">
             <div className="w-64 h-64 md:w-96 md:h-96 pointer-events-auto">
                <ImmersiveVisualizer
                  state={conversationState}
                  isCameraActive={isCameraActive}
                  onClick={handleVisualizerClick}
                  onCameraToggle={toggleCamera}
                  cameraStream={activeVideoStream}
                />
            </div>
        </div>

        <div className="absolute bottom-10 text-center px-4">
            <p className="text-lg text-gray-300 capitalize h-7">{getStatusText()}</p>
            {errorMessage && (
                <p className="text-sm text-red-500 mt-2 max-w-md mx-auto">{errorMessage}</p>
            )}
        </div>
        
        <SettingsPanel
          isOpen={isSettingsOpen}
          currentSettings={settings}
          onClose={() => setIsSettingsOpen(false)}
          onSave={handleSaveSettings}
        />
    </div>
  );
}

export default App;