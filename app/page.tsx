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
    setStatus('🛑 Camera stopped.');
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
      setStatus(cleanText ? `✅ Page scanned! Confidence: ${Math.round(conf)}%` : '❌ No text. Try better angle/light.');

      // Speak if high confidence (>75%) and meaningful text (>50 chars)
      if (conf > 75 && cleanText.length > 50) {
        if ('speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance(cleanText);
          utterance.rate = 0.8; // Slower for clarity
          utterance.pitch = 1;
          utterance.lang = 'en-US';
          utterance.volume = 1;
          speechSynthesis.cancel();
          speechSynthesis.speak(utterance);
          setStatus(`✅ Reading page aloud... (Conf: ${Math.round(conf)}%)`);
        } else {
          setStatus('✅ Text ready, but no speech support.');
        }
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
    };
  }, [stream]);

  return (
    <main className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full space-y-6">
        <h1 className="text-3xl font-bold text-center text-gray-800">📚 Perfect Page Scanner</h1>

        <p className="text-center text-gray-600">Scan a page once—gets clean text, then speaks it clearly. Optimized for books!</p>

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
            {isProcessing ? 'Scanning...' : 'Scan Page & Speak'}
          </button>

          <button
            onClick={stopCamera}
            disabled={!isCameraActive}
            className="px-6 py-3 bg-red-600 text-white font-semibold rounded-lg shadow-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Stop
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
          <h2 className="text-lg font-semibold mb-2 text-gray-800">Scanned Text:</h2>
          <pre className="whitespace-pre-wrap text-sm text-gray-700 overflow-auto max-h-48 bg-gray-50 p-3 rounded font-mono">
            {extractedText}
          </pre>
        </div>

        
      </div>
    </main>
  );
}