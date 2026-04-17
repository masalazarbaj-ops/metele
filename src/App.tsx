import React, { useEffect, useRef, useState } from 'react';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import {
  AlertCircle,
  Camera,
  CameraOff,
  Clock3,
  Eye,
  EyeOff,
  Play,
  Volume2,
} from 'lucide-react';
import { cn } from './lib/utils';
import roasterSoundFile from './RoasterSound.mp3';
import ambulanceSoundFile from './AmbulanceSound.mp3';

type AlarmSoundOption = 'default' | 'roaster' | 'ambulance';

const ALARM_THRESHOLD_MS = 5000;
const BATHROOM_BREAK_MS = 5 * 60 * 1000;
const SOUND_OPTIONS: Array<{
  value: AlarmSoundOption;
  label: string;
  description: string;
}> = [
  { value: 'default', label: 'Default', description: 'El sonido original actual' },
  { value: 'roaster', label: 'Rooster', description: 'Canto de gallo' },
  { value: 'ambulance', label: 'Ambulance', description: 'Sirena de ambulancia' },
];
const SIDE_WORD_COUNT = 14;

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const requestRef = useRef<number>(0);
  const lastVideoTimeRef = useRef<number>(-1);
  const awayStartTimeRef = useRef<number | null>(null);
  const isBathroomBreakActiveRef = useRef(false);
  const selectedAlarmSoundRef = useRef<AlarmSoundOption>('default');

  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const lfoRef = useRef<OscillatorNode | null>(null);
  const roasterAudioRef = useRef<HTMLAudioElement | null>(null);
  const ambulanceAudioRef = useRef<HTMLAudioElement | null>(null);

  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isLookingAway, setIsLookingAway] = useState(false);
  const [awayTime, setAwayTime] = useState(0);
  const [isAlarmPlaying, setIsAlarmPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [debugStats, setDebugStats] = useState({ vRatio: 0, hRatio: 0 });
  const [selectedAlarmSound, setSelectedAlarmSound] =
    useState<AlarmSoundOption>('default');
  const [isBathroomBreakActive, setIsBathroomBreakActive] = useState(false);
  const [bathroomBreakRemainingMs, setBathroomBreakRemainingMs] =
    useState(BATHROOM_BREAK_MS);

  useEffect(() => {
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
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
            delegate: 'GPU',
          },
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: true,
          runningMode: 'VIDEO',
          numFaces: 1,
        });
        faceLandmarkerRef.current = faceLandmarker;
        setIsLoading(false);
      } catch (err) {
        console.error('Error initializing MediaPipe:', err);
        setError('Error al cargar el modelo de IA. Por favor, recarga la página.');
        setIsLoading(false);
      }
    }

    void initMediaPipe();

    return () => {
      console.info = originalInfo;
      console.log = originalLog;
      faceLandmarkerRef.current?.close();
      stopAlarm();
      void audioCtxRef.current?.close();
      window.clearTimeout(requestRef.current);
    };
  }, []);

  useEffect(() => {
    const roasterAudio = new Audio(roasterSoundFile);
    roasterAudio.preload = 'auto';
    roasterAudio.loop = true;
    roasterAudioRef.current = roasterAudio;

    const ambulanceAudio = new Audio(ambulanceSoundFile);
    ambulanceAudio.preload = 'auto';
    ambulanceAudio.loop = true;
    ambulanceAudioRef.current = ambulanceAudio;

    return () => {
      roasterAudio.pause();
      ambulanceAudio.pause();
      roasterAudioRef.current = null;
      ambulanceAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    isBathroomBreakActiveRef.current = isBathroomBreakActive;
  }, [isBathroomBreakActive]);

  useEffect(() => {
    selectedAlarmSoundRef.current = selectedAlarmSound;
  }, [selectedAlarmSound]);

  useEffect(() => {
    if (!isBathroomBreakActive) return;

    const intervalId = window.setInterval(() => {
      setBathroomBreakRemainingMs((current) => Math.max(0, current - 1000));
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isBathroomBreakActive]);

  useEffect(() => {
    if (!isBathroomBreakActive || bathroomBreakRemainingMs > 0) return;

    finishBathroomBreak();
  }, [bathroomBreakRemainingMs, isBathroomBreakActive]);

  const isAudioElementPlaying = (audio: HTMLAudioElement | null) =>
    Boolean(audio && !audio.paused);

  const stopPredictionLoop = () => {
    window.clearTimeout(requestRef.current);
  };

  const stopSelectedAudio = () => {
    [roasterAudioRef.current, ambulanceAudioRef.current].forEach((audio) => {
      if (!audio) return;
      audio.pause();
      audio.currentTime = 0;
    });
  };

  const stopAlarm = () => {
    stopSelectedAudio();

    if (oscillatorRef.current) {
      try {
        oscillatorRef.current.stop();
        oscillatorRef.current.disconnect();
      } catch {
        // Ignore if already stopped.
      }
      oscillatorRef.current = null;
    }

    if (lfoRef.current) {
      try {
        lfoRef.current.stop();
        lfoRef.current.disconnect();
      } catch {
        // Ignore if already stopped.
      }
      lfoRef.current = null;
    }

    setIsAlarmPlaying(false);
  };

  const resetTrackingState = () => {
    awayStartTimeRef.current = null;
    setAwayTime(0);
    setIsLookingAway(false);
    setDebugStats({ vRatio: 0, hRatio: 0 });
    stopAlarm();
  };

  const playAlarm = () => {
    if (
      oscillatorRef.current ||
      isAudioElementPlaying(roasterAudioRef.current) ||
      isAudioElementPlaying(ambulanceAudioRef.current)
    ) {
      return;
    }

    const soundToPlay = selectedAlarmSoundRef.current;

    if (soundToPlay === 'default') {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext ||
          (window as typeof window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext)();
      }

      if (audioCtxRef.current.state === 'suspended') {
        void audioCtxRef.current.resume();
      }

      const osc = audioCtxRef.current.createOscillator();
      const gainNode = audioCtxRef.current.createGain();
      const lfo = audioCtxRef.current.createOscillator();
      const lfoGain = audioCtxRef.current.createGain();

      osc.type = 'square';
      osc.frequency.setValueAtTime(3000, audioCtxRef.current.currentTime);
      osc.frequency.exponentialRampToValueAtTime(
        1000,
        audioCtxRef.current.currentTime + 0.1
      );

      lfo.type = 'sine';
      lfo.frequency.value = 5;
      lfoGain.gain.value = 500;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      lfo.start();

      gainNode.gain.setValueAtTime(0.1, audioCtxRef.current.currentTime);

      osc.connect(gainNode);
      gainNode.connect(audioCtxRef.current.destination);
      osc.start();

      oscillatorRef.current = osc;
      lfoRef.current = lfo;
      setIsAlarmPlaying(true);
      return;
    }

    const audio =
      soundToPlay === 'roaster' ? roasterAudioRef.current : ambulanceAudioRef.current;

    if (!audio) return;

    audio.currentTime = 0;
    void audio
      .play()
      .then(() => setIsAlarmPlaying(true))
      .catch((playError) => {
        console.error('Error playing alarm sound:', playError);
        setError('No se pudo reproducir el sonido de la alarma. Intenta iniciar nuevamente.');
        setIsAlarmPlaying(false);
      });
  };

  const resumeTracking = () => {
    if (!videoRef.current?.srcObject || !faceLandmarkerRef.current) return;

    lastVideoTimeRef.current = -1;
    stopPredictionLoop();
    void predictWebcam();
  };

  const finishBathroomBreak = () => {
    isBathroomBreakActiveRef.current = false;
    setIsBathroomBreakActive(false);
    setBathroomBreakRemainingMs(BATHROOM_BREAK_MS);
    resetTrackingState();

    if (isCameraOn) {
      resumeTracking();
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadeddata = () => {
          lastVideoTimeRef.current = -1;
          void predictWebcam();
        };
      }

      setIsCameraOn(true);
      setError(null);
    } catch (err) {
      console.error('Error accessing camera:', err);
      setError(
        'No se pudo acceder a la cámara. Por favor, otorga los permisos necesarios.'
      );
    }
  };

  const stopCamera = () => {
    if (!videoRef.current?.srcObject) return;

    const stream = videoRef.current.srcObject as MediaStream;
    stream.getTracks().forEach((track) => track.stop());
    videoRef.current.srcObject = null;
    videoRef.current.onloadeddata = null;

    setIsCameraOn(false);
    isBathroomBreakActiveRef.current = false;
    setIsBathroomBreakActive(false);
    setBathroomBreakRemainingMs(BATHROOM_BREAK_MS);
    stopPredictionLoop();
    resetTrackingState();
  };

  const startBathroomBreak = () => {
    if (!isCameraOn || isBathroomBreakActive) return;

    stopPredictionLoop();
    resetTrackingState();
    isBathroomBreakActiveRef.current = true;
    setIsBathroomBreakActive(true);
    setBathroomBreakRemainingMs(BATHROOM_BREAK_MS);
  };

  const selectAlarmSound = (sound: AlarmSoundOption) => {
    const shouldRestartAlarm = isAlarmPlaying;

    stopAlarm();
    setSelectedAlarmSound(sound);

    if (shouldRestartAlarm) {
      window.setTimeout(() => {
        playAlarm();
      }, 0);
    }
  };

  const predictWebcam = async () => {
    if (!videoRef.current || !faceLandmarkerRef.current) return;
    if (isBathroomBreakActiveRef.current) return;

    const video = videoRef.current;
    const startTimeMs = performance.now();

    if (lastVideoTimeRef.current !== video.currentTime) {
      lastVideoTimeRef.current = video.currentTime;

      const results = faceLandmarkerRef.current.detectForVideo(video, startTimeMs);

      if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        const landmarks = results.faceLandmarks[0];
        const nose = landmarks[1];
        const leftEye = landmarks[159];
        const rightEye = landmarks[386];
        const chin = landmarks[152];

        const eyeCenterY = (leftEye.y + rightEye.y) / 2;
        const noseToEyes = nose.y - eyeCenterY;
        const chinToNose = chin.y - nose.y;
        const verticalRatio = noseToEyes / chinToNose;

        const noseToLeftEye = Math.abs(nose.x - leftEye.x);
        const noseToRightEye = Math.abs(rightEye.x - nose.x);
        const horizontalRatio = noseToLeftEye / noseToRightEye;

        const isLookingDown = verticalRatio > 0.65;
        const isLookingSide = horizontalRatio < 0.35 || horizontalRatio > 2.8;
        const currentlyLookingAway = isLookingDown || isLookingSide;

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

    if (videoRef.current?.srcObject && !isBathroomBreakActiveRef.current) {
      requestRef.current = window.setTimeout(predictWebcam, 100);
    }
  };

  const secondsAway = Math.min(5, Math.floor(awayTime / 1000));
  const progressPercentage = Math.min(100, (awayTime / ALARM_THRESHOLD_MS) * 100);
  const bathroomMinutes = Math.floor(bathroomBreakRemainingMs / 60000);
  const bathroomSeconds = Math.floor((bathroomBreakRemainingMs % 60000) / 1000);
  const bathroomCountdown = `${bathroomMinutes}:${bathroomSeconds
    .toString()
    .padStart(2, '0')}`;
  const currentSoundLabel =
    SOUND_OPTIONS.find((option) => option.value === selectedAlarmSound)?.label ??
    'Default';

  const reportEmail = 'pruebadetiempos+problemametele@gmail.com';
  const gmailComposeUrl =
    'https://mail.google.com/mail/?view=cm&fs=1&to=' +
    encodeURIComponent(reportEmail) +
    '&su=' +
    encodeURIComponent('Reportar problema - METELE');
  const sideWords = Array.from({ length: SIDE_WORD_COUNT }, (_, index) => index);

  return (
    <div className="relative min-h-screen overflow-hidden bg-zinc-950 px-4 py-12 font-sans text-zinc-100">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 hidden w-40 overflow-hidden lg:block xl:w-56"
      >
        <div className="absolute inset-y-[-8%] left-[-1.75rem] flex flex-col justify-between xl:left-[-0.5rem]">
          {sideWords.map((index) => (
            <span
              key={`left-${index}`}
              className="select-none whitespace-nowrap -rotate-45 text-[1.7rem] font-black uppercase tracking-[0.35em] text-zinc-800/70 xl:text-[2.2rem]"
              style={{ fontFamily: '"Monument Extended", "Arial Black", sans-serif' }}
            >
              METELE
            </span>
          ))}
        </div>
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 hidden w-40 overflow-hidden lg:block xl:w-56"
      >
        <div className="absolute inset-y-[-8%] right-[-1.75rem] flex flex-col items-end justify-between xl:right-[-0.5rem]">
          {sideWords.map((index) => (
            <span
              key={`right-${index}`}
              className="select-none whitespace-nowrap rotate-45 text-[1.7rem] font-black uppercase tracking-[0.35em] text-zinc-800/70 xl:text-[2.2rem]"
              style={{ fontFamily: '"Monument Extended", "Arial Black", sans-serif' }}
            >
              METELE
            </span>
          ))}
        </div>
      </div>

      <div className="relative z-10 mx-auto w-full max-w-3xl space-y-8">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center gap-3 sm:gap-4">
            <a
              href="https://donprueba.online"
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              aria-label="Ir a donprueba.online"
              title="donprueba.online"
            >
              <img
                src="/logoDP.png"
                alt="Logo de METELE"
                className="h-12 w-12 rounded-md"
              />
            </a>

            <h1
              className="flex items-center justify-center gap-2 whitespace-nowrap text-[clamp(2rem,7vw,3rem)] font-black tracking-tighter text-white sm:gap-3"
              style={{ fontFamily: '"Monument Extended", "Arial Black", sans-serif' }}
            >
              <Eye className="h-[clamp(2rem,6vw,3rem)] w-[clamp(2rem,6vw,3rem)] shrink-0 text-[#bd0003]" />
              METELE
            </h1>
          </div>

          <p className="mx-auto max-w-xl text-center text-lg text-zinc-400">
            En <strong className="font-bold">DonPrueba</strong> queremos ayudarte!!,
            si miras tu teléfono o te distraes por más de 5 segundos, sonará una
            alarma molesta.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-red-500/50 bg-red-500/10 p-4 text-red-400">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        <div className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 shadow-2xl">
          <div className="absolute left-4 right-4 top-4 z-10 flex items-start justify-between">
            <div
              className={cn(
                'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold backdrop-blur-md transition-colors',
                !isCameraOn
                  ? 'bg-zinc-800/80 text-zinc-300'
                  : isBathroomBreakActive
                    ? 'bg-sky-500/90 text-white'
                    : isAlarmPlaying
                      ? 'animate-pulse bg-red-600 text-white'
                      : isLookingAway
                        ? 'bg-amber-500/90 text-white'
                        : 'bg-emerald-500/90 text-white'
              )}
            >
              {!isCameraOn ? (
                <>
                  <CameraOff className="h-4 w-4" /> Cámara apagada
                </>
              ) : isBathroomBreakActive ? (
                <>
                  <Clock3 className="h-4 w-4" /> Pausa baño
                </>
              ) : isAlarmPlaying ? (
                <>
                  <Volume2 className="h-4 w-4" /> ¡DESPIERTA!
                </>
              ) : isLookingAway ? (
                <>
                  <EyeOff className="h-4 w-4" /> Distraído...
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4" /> Concentrado
                </>
              )}
            </div>

            {isCameraOn && (
              <div className="flex items-center gap-2 rounded-full bg-black/50 px-4 py-2 font-mono text-sm text-white backdrop-blur-md">
                {isBathroomBreakActive ? `${bathroomCountdown} pausa` : `${secondsAway}s / 5s`}
              </div>
            )}
          </div>

          <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-zinc-950">
            {isCameraOn && (
              <div className="absolute bottom-4 right-4 z-30 rounded-lg bg-black/60 px-3 py-2 font-mono text-xs text-zinc-400 backdrop-blur-md">
                V: {debugStats.vRatio.toFixed(2)} | H: {debugStats.hRatio.toFixed(2)}
              </div>
            )}

            {isLoading && !isCameraOn && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-zinc-900">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-zinc-600 border-t-zinc-300" />
                <p className="font-medium text-zinc-400">Cargando modelo de IA...</p>
              </div>
            )}

            <video
              ref={videoRef}
              className={cn(
                'h-full w-full transform object-cover transition-opacity duration-500 -scale-x-100',
                isCameraOn ? 'opacity-100' : 'opacity-0'
              )}
              autoPlay
              playsInline
              muted
            />

            {!isCameraOn && !isLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-zinc-500">
                <Camera className="h-16 w-16 text-[#bd0003] opacity-20" />
                <p>La cámara está apagada</p>
              </div>
            )}

            {isBathroomBreakActive && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950/70 px-6 text-center backdrop-blur-sm">
                <div className="max-w-sm rounded-3xl border border-sky-400/20 bg-black/55 px-8 py-7 shadow-2xl">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-sky-500/15 text-sky-300">
                    <Clock3 className="h-7 w-7" />
                  </div>
                  <p className="text-sm uppercase tracking-[0.25em] text-sky-300/80">
                    Pausa de baño
                  </p>
                  <p className="mt-3 text-5xl font-black tracking-tight text-white">
                    {bathroomCountdown}
                  </p>
                  <p className="mt-3 text-sm text-zinc-300">
                    El tracking está en pausa durante 5 minutos. Puedes volver antes
                    con el botón de retomar.
                  </p>
                  <button
                    onClick={finishBathroomBreak}
                    className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-white px-5 py-3 font-semibold text-zinc-950 transition-colors hover:bg-zinc-200"
                  >
                    <Play className="h-4 w-4" />
                    Retomar tracking
                  </button>
                </div>
              </div>
            )}

            {isAlarmPlaying && (
              <div className="pointer-events-none absolute inset-0 animate-pulse bg-red-500/20 mix-blend-overlay" />
            )}
          </div>

          <div className="relative h-2 w-full overflow-hidden bg-zinc-800">
            <div
              className={cn(
                'absolute left-0 top-0 h-full transition-all duration-100 ease-linear',
                isBathroomBreakActive
                  ? 'bg-sky-400'
                  : isAlarmPlaying
                    ? 'bg-red-500'
                    : 'bg-amber-500'
              )}
              style={{
                width: isBathroomBreakActive
                  ? `${100 - (bathroomBreakRemainingMs / BATHROOM_BREAK_MS) * 100}%`
                  : `${progressPercentage}%`,
              }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3 bg-zinc-900 p-6">
            <button
              onClick={isCameraOn ? stopCamera : startCamera}
              disabled={isLoading}
              className={cn(
                'flex items-center gap-3 rounded-2xl px-8 py-4 text-lg font-bold transition-all active:scale-95',
                isCameraOn
                  ? 'bg-zinc-800 text-white hover:bg-zinc-700'
                  : 'bg-white text-zinc-950 hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50'
              )}
            >
              {isCameraOn ? (
                <>
                  <CameraOff className="h-5 w-5" /> Detener seguimiento
                </>
              ) : (
                <>
                  <Camera className="h-5 w-5" /> Iniciar METELE
                </>
              )}
            </button>

            <button
              onClick={isBathroomBreakActive ? finishBathroomBreak : startBathroomBreak}
              disabled={!isCameraOn}
              className={cn(
                'flex items-center gap-3 rounded-2xl border px-5 py-4 font-semibold transition-all active:scale-95',
                !isCameraOn
                  ? 'cursor-not-allowed border-zinc-800 bg-zinc-900 text-zinc-500'
                  : isBathroomBreakActive
                    ? 'border-sky-400/30 bg-sky-500/15 text-sky-100 hover:bg-sky-500/20'
                    : 'border-zinc-700 bg-zinc-800 text-white hover:bg-zinc-700'
              )}
            >
              {isBathroomBreakActive ? (
                <>
                  <Play className="h-5 w-5" /> Retomar
                </>
              ) : (
                <>
                  <Clock3 className="h-5 w-5" /> Baño 5 min
                </>
              )}
            </button>

          </div>
        </div>

        <section className="rounded-3xl border border-zinc-800 bg-zinc-900/70 p-6 shadow-2xl">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.22em] text-zinc-500">
                Sonido de alarma
              </p>
              <h2 className="mt-2 flex items-center gap-2 text-2xl font-black text-white">
                <Volume2 className="h-6 w-6 text-[#bd0003]" />
                Selector de sonido
              </h2>
            </div>
            <div className="rounded-full border border-zinc-700 bg-zinc-950/80 px-4 py-2 text-sm text-zinc-300">
              Activo: <span className="font-semibold text-white">{currentSoundLabel}</span>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {SOUND_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => selectAlarmSound(option.value)}
                className={cn(
                  'rounded-2xl border px-5 py-4 text-left transition-colors',
                  selectedAlarmSound === option.value
                    ? 'border-[#bd0003]/60 bg-[#bd0003]/12 text-white'
                    : 'border-zinc-700 bg-zinc-950/80 text-zinc-300 hover:bg-zinc-900'
                )}
              >
                <p className="font-semibold">{option.label}</p>
                <p className="mt-2 text-sm text-zinc-500">{option.description}</p>
              </button>
            ))}
          </div>
        </section>

        <div className="space-y-4 rounded-2xl border border-zinc-800/50 bg-zinc-900/50 p-6 text-sm text-zinc-400">
          <h3 className="text-base font-semibold text-zinc-200">¿Cómo funciona esta cosa?</h3>
          <ul className="list-inside list-disc space-y-2">
            <li>
              La aplicación utiliza inteligencia artificial (MediaPipe) para detectar
              la orientación de tu rostro.
            </li>
            <li>
              Si detecta que estás mirando hacia abajo (como a un teléfono) o hacia
              los lados, inicia un temporizador.
            </li>
            <li>
              Si el temporizador alcanza los 5 segundos, se reproducirá el sonido de
              alarma seleccionado.
            </li>
            <li>
              El sonido se detendrá automáticamente en cuanto vuelvas a mirar a la
              pantalla.
            </li>
            <li>
              Puedes usar el botón de baño para pausar el tracking 5 minutos y
              retomarlo antes si ya volviste.
            </li>
            <li>
              Todo el procesamiento se realiza localmente en tu navegador;{' '}
              <strong className="font-bold">NO se envían imágenes a ningún servidor</strong>.
            </li>
            <li>
              Concentrarse es duro, pero es posible, y por eso creamos esta
              herramienta para ti; <strong className="font-bold">METELE</strong>.
            </li>
          </ul>
        </div>

        <footer className="pt-6 text-center text-sm text-zinc-500">
          "La concentración reduce lo infinito a lo finito" - Creado por{' '}
          <a
            href="https://donprueba.online"
            target="_blank"
            rel="noreferrer"
            className="text-zinc-200 underline underline-offset-4 transition-colors hover:text-white"
          >
            DonPrueba
          </a>

          <div className="mt-10">
            <a
              href={gmailComposeUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center rounded-xl border border-zinc-700/70 bg-zinc-900/60 px-4 py-2 text-zinc-200 transition-colors hover:bg-zinc-800/70 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              aria-label="Abrir Gmail para reportar problema"
            >
              Reportar Problema
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
