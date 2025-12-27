import React, { useEffect, useRef, useMemo } from 'react';
import { ConversationState } from '../hooks/useGeminiLive';

interface ImmersiveVisualizerProps {
  state: ConversationState;
  isCameraActive: boolean;
  onClick: () => void;
  onCameraToggle: () => void;
  cameraStream: MediaStream | null;
}

const getRandomPosition = (radius: number, distance: number) => {
  const angle = Math.random() * 2 * Math.PI;
  const x = Math.cos(angle) * (radius * distance);
  const y = Math.sin(angle) * (radius * distance);
  return { x, y };
};

export const ImmersiveVisualizer: React.FC<ImmersiveVisualizerProps> = ({
  state,
  isCameraActive,
  onClick,
  onCameraToggle,
  cameraStream,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const isConversationActive = state === ConversationState.ACTIVE || state === ConversationState.CONNECTING;

  // Memoize random positions so they don't change on re-render unless the state dependency changes
  const cameraSatellitePosition = useMemo(() => getRandomPosition(120, 1.7), [isCameraActive]);

  useEffect(() => {
    if (isCameraActive && cameraStream && videoRef.current) {
      videoRef.current.srcObject = cameraStream;
      videoRef.current.play().catch(e => console.error("Video play failed:", e));
    } else if (videoRef.current && videoRef.current.srcObject) {
      // Clear the stream if camera becomes inactive or stream is null
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
  }, [isCameraActive, cameraStream]);
  
  const mainSphereAnimation = isConversationActive ? 'animate-[surface-ripple-active_4s_ease-in-out_infinite]' : 'animate-[surface-ripple-idle_6s_ease-in-out_infinite]';
  
  return (
    <div className="w-full h-full cursor-pointer" onClick={onClick}>
      <svg width="100%" height="100%" viewBox="-300 -300 600 600">
        <defs>
          <filter id="gooey">
            <feGaussianBlur in="SourceGraphic" stdDeviation="15" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8" result="goo" />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
          <filter id="liquid-video">
              <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="2" result="noise"/>
              <feDisplacementMap in="SourceGraphic" in2="noise" scale="20" />
          </filter>
        </defs>

        <g filter="url(#gooey)">
          {/* Main Sphere */}
          <g className="animate-[breathing-hover_8s_ease-in-out_infinite]">
              <circle cx="0" cy="0" r="100" fill="white" className={mainSphereAnimation} />
          </g>

          {/* Camera Satellite */}
          {isCameraActive && (
            <g className="animate-[emerge_0.7s_ease-out_forwards]" onClick={(e) => { e.stopPropagation(); onCameraToggle(); }}>
                <line
                    x1={0} y1={0}
                    x2={cameraSatellitePosition.x} y2={cameraSatellitePosition.y}
                    stroke="white"
                    className="animate-[filament-pulse_1.5s_ease-in-out_infinite]"
                />
                <g style={{ transform: `translate(${cameraSatellitePosition.x}px, ${cameraSatellitePosition.y}px)` }}>
                     {/* The circle for the gooey effect. No longer has opacity="0" */}
                    <circle cx="0" cy="0" r="60" fill="white" />
                    <foreignObject x="-60" y="-60" width="120" height="120">
                      <div style={{ width: '120px', height: '120px', borderRadius: '50%', overflow: 'hidden' }}>
                        <video
                            ref={videoRef}
                            width="120"
                            height="120"
                            muted
                            playsInline
                            style={{ objectFit: 'cover', width: '100%', height: '100%', animation: 'clarify 1.5s ease-out forwards', filter: 'url(#liquid-video)' }}
                        />
                      </div>
                    </foreignObject>
                </g>
            </g>
          )}
        </g>
      </svg>
    </div>
  );
};