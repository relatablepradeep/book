'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import Tesseract from 'tesseract.js';

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [status, setStatus] = useState('Click "Start Camera" to begin.');
  const [extractedText, setExtractedText] = useState('Extracted text will appear here...');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAutoScan, setIsAutoScan] = useState(false);
  const [confidence, setConfidence] = useState(0);
  const rafRef = useRef<number | null>(null);

  // ✅ Optimized Tesseract config for printed books
  const tesseractConfig = {
    logger: (m: any) => console.log(m),
    tessedit_pageseg_mode: '6' as const, // Best for book pages: single uniform text block
    tessedit_char_blacklist: '|{}()[]' as const, // Noise reduction
    tessedit_create_pdf: '0' as const, // Faster processing
  };

  // ✅ Best available voice selection (prioritizes high-quality en-US voices)
  const getBestVoice = (): SpeechSynthesisVoice | null => {
    if (!('speechSynthesis' in window)) return null;
    const voices = speechSynthesis.getVoices();
    if (voices.length === 0) return null; // Voices load async, but we'll handle in speak function

    // Prioritize: Google/Microsoft premium voices (as of 2025, common high-quality options)
    const preferredVoices = [
      'Google US English', // Natural, clear
      'Microsoft Zira Desktop - English (United States)', // Smooth for reading
      'Samantha (Enhanced)', // macOS high-quality
      'en-US-Wavenet-D' // If WaveNet available
    ];

    for (const pref of preferredVoices) {
      const voice = voices.find(v => v.name.includes(pref) || v.name === pref);
      if (voice && voice.lang.startsWith('en-US')) return voice;
    }

    // Fallback: First en-US voice (no gender check, as it's non-standard)
    return voices.find(v => v.lang.startsWith('en-US')) ?? null;
  };

  // ✅ Chunk text into ~200-word segments for unlimited range
  const chunkText = (text: string, maxWords: number = 200): string[] => {
    const words = text.split(/\s+/);
    const chunks: string[] = [];
    let currentChunk = '';
    for (const word of words) {
      if ((currentChunk.split(/\s+/).length + 1) > maxWords) {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = word + ' ';
      } else {
        currentChunk += word + ' ';
      }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
  };

  // ✅ Speak with chunking and best voice
  const speakText = (text: string) => {
    if (!('speechSynthesis' in window)) {
      setStatus('❌ Speech not supported.');
      return;
    }

    const chunks = chunkText(text);
    let chunkIndex = 0;

    const speakNext = () => {
      if (chunkIndex >= chunks.length) return;

      const utterance = new SpeechSynthesisUtterance(chunks[chunkIndex]);
      const bestVoice = getBestVoice();
      if (bestVoice) utterance.voice = bestVoice;

      utterance.rate = 0.8; // Slower for clarity
      utterance.pitch = 1;
      utterance.lang = 'en-US';
      utterance.volume = 1;

      utterance.onend = () => {
        chunkIndex++;
        if (chunkIndex < chunks.length) {
          speakNext();
        } else {
          setStatus('✅ Full page read complete!');
        }
      };

      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    };

    speakNext();
    setStatus(`✅ Starting to read (${chunks.length} chunks)...`);
  };

  // ✅ Otsu Threshold Calculation (for adaptive binarization)
  const calculateOtsuThreshold = (data: Uint8ClampedArray, width: number, height: number): number => {
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      histogram[data[i]]++; // Use red channel (grayscale)
    }

    let total = width * height;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * histogram[i];

    let sumB = 0;
    let wB = 0;
    let wF = 0;
    let max = 0;
    let threshold = 0;

    for (let t = 0; t < 256; t++) {
      wB += histogram[t];
      if (wB === 0) continue;
      wF = total - wB;
      if (wF === 0) break;
      sumB += t * histogram[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > max) {
        max = between;
        threshold = t;
      }
    }
    return threshold;
  };

  // ✅ Advanced Preprocessing: Grayscale + Otsu Binarization + Sharpen
  const preprocessImage = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, video: HTMLVideoElement) => {
    // Resize to optimal (300 DPI equiv., height ~600px for books)
    const targetHeight = 600;
    let { videoWidth, videoHeight } = video;
    const aspectRatio = videoWidth / videoHeight;

    if (videoHeight > targetHeight) {
      videoHeight = targetHeight;
      videoWidth = videoHeight * aspectRatio;
    } else if (videoHeight < 300) {
      const scale = 300 / videoHeight;
      videoHeight *= scale;
      videoWidth *= scale;
    }

    canvas.width = videoWidth;
    canvas.height = videoHeight;
    ctx.drawImage(video, 0, 0, videoWidth, videoHeight);

    // Grayscale
    let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      data[i] = data[i + 1] = data[i + 2] = avg;
    }
    ctx.putImageData(imageData, 0, 0);

    // Otsu Binarization (invert for dark text on light bg)
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    data = imageData.data;
    const threshold = calculateOtsuThreshold(data, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) {
      const pixel = data[i];
      data[i] = data[i + 1] = data[i + 2] = pixel > threshold ? 255 : 0; // Binary
    }
    ctx.putImageData(imageData, 0, 0);

    // Mild sharpen (unsharp mask simulation)
    ctx.filter = 'contrast(1.1) brightness(1.05)';
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = 'none';

    // Add thin border to help segmentation
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

    return canvas.toDataURL('image/png');
  };

  // ✅ Start camera with high res
  const startCamera = async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      setStatus('❌ Camera not supported in this environment.');
      return;
    }

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: 'environment',
          width: { ideal: 1920, min: 1280 },
          height: { ideal: 1080, min: 720 }
        },
      });

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.play();
      }

      setStream(mediaStream);
      setIsCameraActive(true);
      setStatus('✅ Camera started. Point at a page (20-30cm away, good light).');
    } catch (err) {
      setStatus(`⚠️ Error accessing camera: ${(err as Error).message}`);
    }
  };

  // ✅ Stop everything
  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsCameraActive(false);
    setIsAutoScan(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    speechSynthesis.cancel(); // Stop any ongoing speech
    setStatus('🛑 Camera & speech stopped.');
  };

  // ✅ Perform OCR with advanced preprocessing
  const performOCR = useCallback(async (video: HTMLVideoElement, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    if (!video.videoWidth || !video.videoHeight || isProcessing) return;

    setIsProcessing(true);
    setStatus('🔍 Scanning page... (hold steady)');

    try {
      const processedImage = preprocessImage(ctx, canvas, video);

      const {
        data: { text, confidence: conf },
      } = await Tesseract.recognize(processedImage, 'eng', tesseractConfig);

      const cleanText = text.trim().replace(/\s+/g, ' '); // Clean whitespace
      setExtractedText(cleanText || 'No text detected');

      setConfidence(conf);
      if (!cleanText) {
        setStatus('❌ No text. Try better angle/light.');
        return;
      }

      setStatus(`✅ Page scanned! Confidence: ${Math.round(conf)}% | Words: ${cleanText.split(/\s+/).length}`);

      // Speak if high confidence (>75%) and meaningful text (no word limit now)
      if (conf > 75) {
        speakText(cleanText);
      } else {
        setStatus(`⚠️ Low confidence (${Math.round(conf)}%). Improve lighting for speech.`);
      }
    } catch (err) {
      setStatus(`❌ Error: ${(err as Error).message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing]);

  // ✅ Manual scan
  const captureAndRead = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    performOCR(videoRef.current, canvas, ctx);
  };

  // ✅ Live scan toggle (throttled to 2s for accuracy over speed)
  const toggleAutoScan = () => {
    setIsAutoScan(!isAutoScan);
    if (!isAutoScan) {
      let lastScan = 0;
      const scanLoop = (currentTime: number) => {
        if (currentTime - lastScan > 2000) { // Every 2s for better focus
          if (videoRef.current && canvasRef.current && isAutoScan) {
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              performOCR(videoRef.current!, canvas, ctx);
              lastScan = currentTime;
            }
          }
        }
        if (isAutoScan) {
          rafRef.current = requestAnimationFrame(scanLoop);
        }
      };
      rafRef.current = requestAnimationFrame(scanLoop);
      setStatus('🚀 Live scan on (every 2s). Keep steady!');
    } else {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setStatus('⏸️ Live scan paused.');
    }
  };

  // ✅ Load voices on init (async)
  useEffect(() => {
    const loadVoices = () => {
      if (speechSynthesis.getVoices().length > 0) return; // Already loaded
      speechSynthesis.onvoiceschanged = () => {
        console.log('Voices loaded:', speechSynthesis.getVoices().map(v => v.name));
      };
    };
    loadVoices();
  }, []);

  // ✅ Video ready handler
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      const handleReady = () => {
        if (canvasRef.current) {
          canvasRef.current.width = video.videoWidth;
          canvasRef.current.height = video.videoHeight;
        }
      };
      video.addEventListener('loadedmetadata', handleReady);
      video.addEventListener('canplay', handleReady);
      return () => {
        video.removeEventListener('loadedmetadata', handleReady);
        video.removeEventListener('canplay', handleReady);
      };
    }
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      speechSynthesis.cancel();
    };
  }, [stream]);

  return (
    <main className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full space-y-6">
        <h1 className="text-3xl font-bold text-center text-gray-800">📚 Unlimited Page Scanner</h1>

        <p className="text-center text-gray-600">Scans full pages (no word limit)—chunks long text for seamless speech with premium voice.</p>

        <div className="space-y-4">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full max-w-md mx-auto rounded-lg shadow-md border-2 border-gray-300"
          />
          <canvas ref={canvasRef} className="hidden" />
        </div>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <button
            onClick={startCamera}
            disabled={isCameraActive}
            className="px-6 py-3 bg-green-600 text-white font-semibold rounded-lg shadow-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Start Camera
          </button>

          <button
            onClick={captureAndRead}
            disabled={!isCameraActive || isProcessing}
            className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg shadow-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-1"
          >
            {isProcessing ? 'Scanning...' : 'Scan Full Page & Speak'}
          </button>

          <button
            onClick={stopCamera}
            disabled={!isCameraActive}
            className="px-6 py-3 bg-red-600 text-white font-semibold rounded-lg shadow-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Stop All
          </button>
        </div>

        {isCameraActive && (
          <div className="flex justify-center">
            <button
              onClick={toggleAutoScan}
              disabled={isProcessing}
              className={`px-6 py-3 font-semibold rounded-lg shadow-md transition-colors ${
                isAutoScan
                  ? 'bg-yellow-600 text-white hover:bg-yellow-700'
                  : 'bg-gray-500 text-white hover:bg-gray-600'
              }`}
            >
              {isAutoScan ? 'Pause Live' : 'Live Scan'}
            </button>
          </div>
        )}

        <div className="text-center space-y-1">
          <p className="font-semibold text-gray-700">{status}</p>
          {confidence > 0 && <p className="text-xs text-blue-600">Conf: {Math.round(confidence)}%</p>}
        </div>

        <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
          <h2 className="text-lg font-semibold mb-2 text-gray-800">Full Scanned Text:</h2>
          <pre className="whitespace-pre-wrap text-sm text-gray-700 overflow-auto max-h-48 bg-gray-50 p-3 rounded font-mono">
            {extractedText}
          </pre>
        </div>

      </div>
    </main>
  );
}