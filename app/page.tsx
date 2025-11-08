'use client';

import { useRef, useState, useEffect } from 'react';
import Tesseract from 'tesseract.js';

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [status, setStatus] = useState('Click "Start Camera" to begin.');
  const [extractedText, setExtractedText] = useState('Extracted text will appear here...');
  const [isProcessing, setIsProcessing] = useState(false);

  // ✅ Start camera safely
  const startCamera = async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      setStatus('❌ Camera not supported in this environment.');
      return;
    }

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, // Prefer back camera on mobile
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

  // ✅ Stop camera
  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsCameraActive(false);
    setStatus('🛑 Camera stopped.');
  };

  // ✅ Capture and read text with OCR
  const captureAndRead = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setIsProcessing(true);
    setStatus('🔍 Extracting text... please wait.');

    // Draw the current video frame
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    ctx.drawImage(videoRef.current, 0, 0);
    const imageDataUrl = canvas.toDataURL('image/png');

    try {
      const {
        data: { text },
      } = await Tesseract.recognize(imageDataUrl, 'eng', {
        logger: (m) => console.log(m),
      });

      const cleanText = text.trim() || '(No text detected)';
      setExtractedText(cleanText);
      setStatus('✅ Text extracted successfully! Reading aloud...');

      // ✅ Read aloud using Web Speech API
      if ('speechSynthesis' in window && cleanText !== '(No text detected)') {
        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.rate = 0.85;
        utterance.pitch = 1;
        utterance.lang = 'en-US';
        speechSynthesis.cancel(); // Stop any existing speech
        speechSynthesis.speak(utterance);
      } else {
        setStatus('📖 Text extracted, but speech synthesis not supported.');
      }
    } catch (err) {
      setStatus(`❌ Error extracting text: ${(err as Error).message}`);
    } finally {
      setIsProcessing(false);
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

  return (
    <main className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full space-y-6">
        <h1 className="text-3xl font-bold text-center text-gray-800">
          📚 Book Reader with Camera
        </h1>

        <p className="text-center text-gray-600">
          Point your camera at a book page and click <strong>“Capture & Read”</strong> to extract and
          read the text aloud.
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
            {isProcessing ? 'Processing...' : 'Capture & Read'}
          </button>

          <button
            onClick={stopCamera}
            disabled={!isCameraActive}
            className="px-6 py-3 bg-red-600 text-white font-semibold rounded-lg shadow-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Stop Camera
          </button>
        </div>

        <div className="text-center">
          <p className="font-semibold text-gray-700">{status}</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
          <h2 className="text-lg font-semibold mb-2 text-gray-800">Extracted Text:</h2>
          <pre className="whitespace-pre-wrap text-sm text-gray-700 overflow-auto max-h-48">
            {extractedText}
          </pre>
        </div>

        <div className="text-xs text-gray-500 text-center">
          ⚠️ Works only on HTTPS connections or localhost. Deploy on{' '}
          <a href="https://vercel.com" className="underline text-blue-600" target="_blank">
            Vercel
          </a>{' '}
          for mobile camera access.
        </div>
      </div>
    </main>
  );
}
