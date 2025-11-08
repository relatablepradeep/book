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
  const [lastText, setLastText] = useState(''); // Track previous text for change detection
  const autoScanIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // ✅ Enhanced Tesseract config for printed books
  const tesseractConfig = {
    logger: (m: any) => console.log(m),
    tessedit_pageseg_mode: '6' as const, // PSM 6: Assume a single uniform block of text (ideal for book pages)
    tessedit_char_blacklist: '|' as const, // Remove common noise
    // Preprocessing is handled separately via canvas
  };

  // ✅ Image preprocessing for better OCR accuracy
  const preprocessImage = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, video: HTMLVideoElement) => {
    // Resize for better resolution (Tesseract prefers ~300 DPI equivalents)
    const maxWidth = 1200;
    const maxHeight = 800;
    let { videoWidth, videoHeight } = video;
    const aspectRatio = videoWidth / videoHeight;

    if (videoWidth > maxWidth || videoHeight > maxHeight) {
      videoWidth = maxWidth;
      videoHeight = videoWidth / aspectRatio;
    }

    canvas.width = videoWidth;
    canvas.height = videoHeight;
    ctx.drawImage(video, 0, 0, videoWidth, videoHeight);

    // Convert to grayscale
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      data[i] = avg; // Red
      data[i + 1] = avg; // Green
      data[i + 2] = avg; // Blue
    }
    ctx.putImageData(imageData, 0, 0);

    // Enhance contrast (simple threshold)
    const contrastData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const contrast = contrastData.data;
    for (let i = 0; i < contrast.length; i += 4) {
      const avg = (contrast[i] + contrast[i + 1] + contrast[i + 2]) / 3;
      const threshold = 128; // Adjust for book text (darker text on lighter bg)
      contrast[i] = contrast[i + 1] = contrast[i + 2] = avg > threshold ? 255 : 0;
    }
    ctx.putImageData(contrastData, 0, 0);

    return canvas.toDataURL('image/png');
  };

  // ✅ Start camera safely
  const startCamera = async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      setStatus('❌ Camera not supported in this environment.');
      return;
    }

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }, // Higher res for better OCR
      });

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }

      setStream(mediaStream);
      setIsCameraActive(true);
      setStatus('✅ Camera started. Point at a page of your book.');
    } catch (err) {
      setStatus(`⚠️ Error accessing camera: ${(err as Error).message}`);
    }
  };

  // ✅ Stop camera and auto-scan
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
    if (autoScanIntervalRef.current) {
      clearInterval(autoScanIntervalRef.current);
      autoScanIntervalRef.current = null;
    }
    setStatus('🛑 Camera stopped.');
  };

  // ✅ Perform OCR with preprocessing
  const performOCR = useCallback(async (video: HTMLVideoElement, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    if (isProcessing || !video.videoWidth || !video.videoHeight) return;

    setIsProcessing(true);
    setStatus('🔍 Scanning text...');

    try {
      const processedImage = preprocessImage(ctx, canvas, video);

      const {
        data: { text },
      } = await Tesseract.recognize(processedImage, 'eng', tesseractConfig);

      const cleanText = text.trim();
      if (cleanText && cleanText !== lastText && cleanText.length > 10) { // Only update if significant change
        setExtractedText(cleanText);
        setLastText(cleanText);
        setStatus('✅ New text detected! Reading aloud...');

        // ✅ Read aloud with improved settings
        if ('speechSynthesis' in window && cleanText) {
          const utterance = new SpeechSynthesisUtterance(cleanText);
          utterance.rate = 0.85;
          utterance.pitch = 1;
          utterance.lang = 'en-US';
          utterance.volume = 0.9;
          speechSynthesis.cancel();
          speechSynthesis.speak(utterance);
        }
      } else if (cleanText) {
        setStatus('🔍 Text stable, continuing scan...');
      } else {
        setStatus('❌ No clear text detected. Adjust lighting/angle.');
      }
    } catch (err) {
      setStatus(`❌ OCR error: ${(err as Error).message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, lastText]);

  // ✅ Manual capture
  const captureAndRead = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    performOCR(videoRef.current, canvas, ctx);
  };

  // ✅ Toggle auto-scan
  const toggleAutoScan = () => {
    setIsAutoScan(!isAutoScan);
    if (!isAutoScan) {
      // Start auto-scan every 2.5 seconds
      autoScanIntervalRef.current = setInterval(() => {
        if (videoRef.current && canvasRef.current) {
          const canvas = canvasRef.current;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            performOCR(videoRef.current!, canvas, ctx);
          }
        }
      }, 2500);
      setStatus('🚀 Auto-scan enabled. Hold steady for best results.');
    } else {
      if (autoScanIntervalRef.current) {
        clearInterval(autoScanIntervalRef.current);
        autoScanIntervalRef.current = null;
      }
      setStatus('⏸️ Auto-scan paused.');
    }
  };

  // ✅ Adjust canvas on video metadata load
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      const handleLoadedMetadata = () => {
        if (canvasRef.current) {
          canvasRef.current.width = video.videoWidth;
          canvasRef.current.height = video.videoHeight;
        }
      };
      video.addEventListener('loadedmetadata', handleLoadedMetadata);
      return () => video.removeEventListener('loadedmetadata', handleLoadedMetadata);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (autoScanIntervalRef.current) {
        clearInterval(autoScanIntervalRef.current);
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [stream]);

  return (
    <main className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full space-y-6">
        <h1 className="text-3xl font-bold text-center text-gray-800">
          📚 Enhanced Book Reader
        </h1>

        <p className="text-center text-gray-600">
          Auto-detects and reads text from your camera feed. For best accuracy: good lighting, steady hold, printed text.
        </p>

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
            className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg shadow-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isProcessing ? 'Scanning...' : 'Manual Scan'}
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
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <button
              onClick={toggleAutoScan}
              disabled={isProcessing}
              className={`px-6 py-3 font-semibold rounded-lg shadow-md transition-colors ${
                isAutoScan
                  ? 'bg-yellow-600 text-white hover:bg-yellow-700'
                  : 'bg-gray-500 text-white hover:bg-gray-600'
              }`}
            >
              {isAutoScan ? 'Pause Auto-Scan' : 'Start Auto-Scan'}
            </button>
          </div>
        )}

        <div className="text-center">
          <p className="font-semibold text-gray-700">{status}</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
          <h2 className="text-lg font-semibold mb-2 text-gray-800">Extracted Text:</h2>
          <pre className="whitespace-pre-wrap text-sm text-gray-700 overflow-auto max-h-48 bg-gray-50 p-3 rounded">
            {extractedText}
          </pre>
        </div>

        <div className="text-xs text-gray-500 text-center">
          ⚠️ Optimized for printed books. Auto-scan runs every 2.5s to balance speed & accuracy. Deploy on{' '}
          <a href="https://vercel.com" className="underline text-blue-600" target="_blank" rel="noopener noreferrer">
            Vercel
          </a>{' '}
          for mobile.
        </div>
      </div>
    </main>
  );
}