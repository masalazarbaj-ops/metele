import React, { useEffect, useRef, useState } from 'react';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { AlertCircle, Camera, CameraOff, Eye, EyeOff, Volume2, VolumeX } from 'lucide-react';
import { cn } from './lib/utils';

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isLookingAway, setIsLookingAway] = useState(false);
  const [awayTime, setAwayTime] = useState(0);
  const [isAlarmPlaying, setIsAlarmPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [debugStats, setDebugStats] = useState({ vRatio: 0, hRatio: 0 });

  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const requestRef = useRef<number>(0);
  const lastVideoTimeRef = useRef<number>(-1);
  const awayStartTimeRef = useRef<number | null>(null);
  
  // Audio context for the annoying sound
  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);

  const ALARM_THRESHOLD_MS = 5000; // 5 seconds

  useEffect(() => {
    // Suppress the XNNPACK info log from the WASM module
    const originalInfo = console.info;
    const originalLog = console.log;
    console.info = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('XNNPACK')) return;
      originalInfo(...args);
    };
    console.log = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('XNNPACK')) return;
      originalLog(...args);
    };

    async function initMediaPipe() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm'
        );
        const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
            delegate: 'GPU'
          },
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: true,
          runningMode: 'VIDEO',
          numFaces: 1
        });
        faceLandmarkerRef.current = faceLandmarker;
        setIsLoading(false);
      } catch (err) {
        console.error('Error initializing MediaPipe:', err);
        setError('Error al cargar el modelo de IA. Por favor, recarga la página.');
        setIsLoading(false);
      }
    }
    initMediaPipe();

    return () => {
      console.info = originalInfo;
      console.log = originalLog;
      if (faceLandmarkerRef.current) {
        faceLandmarkerRef.current.close();
      }
      stopAlarm();
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
      }
      clearTimeout(requestRef.current);
    };
  }, []);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 640, height: 480 } 
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.addEventListener('loadeddata', predictWebcam);
        setIsCameraOn(true);
        setError(null);
      }
    } catch (err) {
      console.error('Error accessing camera:', err);
      setError('No se pudo acceder a la cámara. Por favor, otorga los permisos necesarios.');
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
      setIsCameraOn(false);
      clearTimeout(requestRef.current);
      stopAlarm();
      setAwayTime(0);
      setIsLookingAway(false);
      awayStartTimeRef.current = null;
    }
  };

  const playAlarm = () => {
    if (oscillatorRef.current) return; // Use ref to prevent multiple overlapping alarms
    
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }

    const osc = audioCtxRef.current.createOscillator();
    const gainNode = audioCtxRef.current.createGain();
    
    // Annoying high-pitched square wave
    osc.type = 'square';
    osc.frequency.setValueAtTime(3000, audioCtxRef.current.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1000, audioCtxRef.current.currentTime + 0.1);
    
    // Modulate frequency to make it more annoying (siren effect)
    const lfo = audioCtxRef.current.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5; // 5 Hz modulation
    const lfoGain = audioCtxRef.current.createGain();
    lfoGain.gain.value = 500;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start();
    
    gainNode.gain.setValueAtTime(0.1, audioCtxRef.current.currentTime); // Volume
    
    osc.connect(gainNode);
    gainNode.connect(audioCtxRef.current.destination);
    
    osc.start();
    oscillatorRef.current = osc;
    setIsAlarmPlaying(true);
  };

  const stopAlarm = () => {
    if (oscillatorRef.current) {
      try {
        oscillatorRef.current.stop();
        oscillatorRef.current.disconnect();
      } catch (e) {
        // Ignore errors if already stopped
      }
      oscillatorRef.current = null;
    }
    setIsAlarmPlaying(false);
  };

  const predictWebcam = async () => {
    if (!videoRef.current || !faceLandmarkerRef.current) return;

    const video = videoRef.current;
    let startTimeMs = performance.now();
    
    if (lastVideoTimeRef.current !== video.currentTime) {
      lastVideoTimeRef.current = video.currentTime;
      
      const results = faceLandmarkerRef.current.detectForVideo(video, startTimeMs);
      
      if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        const landmarks = results.faceLandmarks[0];
        
        // Use 3D coordinates for better accuracy
        const nose = landmarks[1]; // Tip of nose
        const leftEye = landmarks[159]; // Top of left eye
        const rightEye = landmarks[386]; // Top of right eye
        const chin = landmarks[152]; // Bottom of chin
        
        // 1. Detect looking down (Pitch)
        // When looking down, the 2D distance between nose and eyes decreases
        // compared to the distance between nose and chin.
        const eyeCenterY = (leftEye.y + rightEye.y) / 2;
        const noseToEyes = nose.y - eyeCenterY;
        const chinToNose = chin.y - nose.y;
        
        // Ratio of top half of face vs bottom half
        const verticalRatio = noseToEyes / chinToNose;
        
        // 2. Detect looking sideways (Yaw)
        // Compare horizontal distance from nose to each eye
        const noseToLeftEye = Math.abs(nose.x - leftEye.x);
        const noseToRightEye = Math.abs(rightEye.x - nose.x);
        const horizontalRatio = noseToLeftEye / noseToRightEye;

        // Thresholds (Tuned for typical webcam angles)
        // verticalRatio < 0.65 means looking down (nose is very close to eyes in 2D projection)
        // horizontalRatio < 0.35 means looking right
        // horizontalRatio > 2.8 means looking left
        const isLookingDown = verticalRatio > 0.65; 
        const isLookingSide = horizontalRatio < 0.35 || horizontalRatio > 2.8;
        
        const currentlyLookingAway = isLookingDown || isLookingSide;
        
        // Update debug stats occasionally to avoid too many re-renders
        if (Math.random() < 0.1) {
          setDebugStats({ vRatio: verticalRatio, hRatio: horizontalRatio });
        }
        
        if (currentlyLookingAway) {
          if (!awayStartTimeRef.current) {
            awayStartTimeRef.current = performance.now();
          }
          const timeAway = performance.now() - awayStartTimeRef.current;
          setAwayTime(timeAway);
          setIsLookingAway(true);
          
          if (timeAway >= ALARM_THRESHOLD_MS) {
            playAlarm();
          }
        } else {
          awayStartTimeRef.current = null;
          setAwayTime(0);
          setIsLookingAway(false);
          stopAlarm();
        }
      } else {
        // No face detected, assume looking away
        if (!awayStartTimeRef.current) {
          awayStartTimeRef.current = performance.now();
        }
        const timeAway = performance.now() - awayStartTimeRef.current;
        setAwayTime(timeAway);
        setIsLookingAway(true);
        
        if (timeAway >= ALARM_THRESHOLD_MS) {
          playAlarm();
        }
      }
    }
    
    if (videoRef.current && videoRef.current.srcObject) {
      // Use setTimeout instead of requestAnimationFrame so it keeps running in background tabs
      requestRef.current = window.setTimeout(predictWebcam, 100);
    }
  };

  // Format time for display
  const secondsAway = Math.min(5, Math.floor(awayTime / 1000));
  const progressPercentage = Math.min(100, (awayTime / ALARM_THRESHOLD_MS) * 100);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center py-12 px-4 font-sans">
      <div className="max-w-3xl w-full space-y-8">
        <div className="w-full flex items-start justify-start">
          <div
            className="w-10 h-10 border border-zinc-700/70 bg-zinc-900 rounded-md flex items-center justify-center text-xs tracking-widest text-zinc-100 shadow-sm"
            style={{ fontFamily: '"Akira Expanded", "Arial Black", sans-serif' }}
            aria-label="DP"
          >
            DP
          </div>
        </div>

        <div className="text-center space-y-4">
          <h1
            className="text-5xl font-black tracking-tighter text-white flex items-center justify-center gap-3"
            style={{ fontFamily: '"Monument Extended", "Arial Black", sans-serif' }}
          >
            <Eye className="w-12 h-12 text-red-500" />
            METELE
          </h1>
          <p className="text-zinc-400 text-lg max-w-xl mx-auto">
            Aplicación de seguimiento ocular. Si miras tu teléfono o te distraes por más de 5 segundos, sonará una alarma molesta.
          </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-xl flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <p>{error}</p>
          </div>
        )}

        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl relative">
          {/* Status Overlay */}
          <div className="absolute top-4 left-4 right-4 z-10 flex justify-between items-start">
            <div className={cn(
              "px-4 py-2 rounded-full text-sm font-bold flex items-center gap-2 backdrop-blur-md transition-colors",
              !isCameraOn ? "bg-zinc-800/80 text-zinc-300" :
              isAlarmPlaying ? "bg-red-600 animate-pulse text-white" :
              isLookingAway ? "bg-amber-500/90 text-white" :
              "bg-emerald-500/90 text-white"
            )}>
              {!isCameraOn ? (
                <><CameraOff className="w-4 h-4" /> Cámara Apagada</>
              ) : isAlarmPlaying ? (
                <><Volume2 className="w-4 h-4" /> ¡DESPIERTA!</>
              ) : isLookingAway ? (
                <><EyeOff className="w-4 h-4" /> Distraído...</>
              ) : (
                <><Eye className="w-4 h-4" /> Concentrado</>
              )}
            </div>

            {isCameraOn && (
              <div className="bg-black/50 backdrop-blur-md px-4 py-2 rounded-full text-sm font-mono text-white flex items-center gap-2">
                {secondsAway}s / 5s
              </div>
            )}
          </div>

          {/* Video Container */}
          <div className="relative aspect-video bg-zinc-950 flex items-center justify-center overflow-hidden">
            {isCameraOn && (
              <div className="absolute bottom-4 right-4 z-30 bg-black/60 backdrop-blur-md px-3 py-2 rounded-lg text-xs font-mono text-zinc-400">
                V: {debugStats.vRatio.toFixed(2)} | H: {debugStats.hRatio.toFixed(2)}
              </div>
            )}
            {isLoading && !isCameraOn && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-20 bg-zinc-900">
                <div className="w-8 h-8 border-4 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
                <p className="text-zinc-400 font-medium">Cargando modelo de IA...</p>
              </div>
            )}
            
            <video
              ref={videoRef}
              className={cn(
                "w-full h-full object-cover transform -scale-x-100 transition-opacity duration-500",
                isCameraOn ? "opacity-100" : "opacity-0"
              )}
              autoPlay
              playsInline
              muted
            />
            
            {!isCameraOn && !isLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-zinc-500">
                <Camera className="w-16 h-16 opacity-20" />
                <p>La cámara está apagada</p>
              </div>
            )}

            {/* Alarm visual effect */}
            {isAlarmPlaying && (
              <div className="absolute inset-0 bg-red-500/20 animate-pulse pointer-events-none mix-blend-overlay" />
            )}
          </div>

          {/* Progress Bar */}
          <div className="h-2 bg-zinc-800 w-full relative overflow-hidden">
            <div 
              className={cn(
                "absolute top-0 left-0 h-full transition-all duration-100 ease-linear",
                isAlarmPlaying ? "bg-red-500" : "bg-amber-500"
              )}
              style={{ width: `${progressPercentage}%` }}
            />
          </div>

          {/* Controls */}
          <div className="p-6 bg-zinc-900 flex justify-center">
            <button
              onClick={isCameraOn ? stopCamera : startCamera}
              disabled={isLoading}
              className={cn(
                "px-8 py-4 rounded-2xl font-bold text-lg transition-all active:scale-95 flex items-center gap-3",
                isCameraOn 
                  ? "bg-zinc-800 hover:bg-zinc-700 text-white" 
                  : "bg-white hover:bg-zinc-200 text-zinc-950 disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              {isCameraOn ? (
                <><CameraOff className="w-5 h-5" /> Detener Seguimiento</>
              ) : (
                <><Camera className="w-5 h-5" /> Iniciar METELE</>
              )}
            </button>
          </div>
        </div>
        
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-6 text-sm text-zinc-400 space-y-4">
          <h3 className="text-zinc-200 font-semibold text-base">¿Cómo funciona esta cosa?</h3>
          <ul className="list-disc list-inside space-y-2">
            <li>La aplicación utiliza inteligencia artificial (MediaPipe) para detectar la orientación de tu rostro.</li>
            <li>Si detecta que estás mirando hacia abajo (como a un teléfono) o hacia los lados, inicia un temporizador.</li>
            <li>Si el temporizador alcanza los 5 segundos, se reproducirá un sonido de alarma molesto.</li>
            <li>El sonido se detendrá automáticamente en cuanto vuelvas a mirar a la pantalla.</li>
            <li>Todo el procesamiento se realiza localmente en tu navegador; NO se envían imágenes a ningún servidor.</li>
            <li>Concentrarse es duro, pero es posible, y por eso creamos esta herramienta para ti; METELE.</li>
          </ul>
        </div>

        <footer className="pt-6 text-center text-sm text-zinc-500">
          "La concetracion es un poder" - Creado por{" "}
          <a
            href="https://donprueba.online"
            target="_blank"
            rel="noreferrer"
            className="text-zinc-200 hover:text-white underline underline-offset-4 transition-colors"
          >
            DonPrueba
          </a>
        </footer>
      </div>
    </div>
  );
}
