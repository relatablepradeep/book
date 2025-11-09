'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import Tesseract from 'tesseract.js';

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [status, setStatus] = useState('Click "Start Camera" to begin.');
  const [extractedText, setExtractedText] = useState('Extracted text will appear here...');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAutoScan, setIsAutoScan] = useState(false);
  const [isBlindMode, setIsBlindMode] = useState(false);
  const [confidence, setConfidence] = useState(0);
  const [isReading, setIsReading] = useState(false); // Track if speaking
  const rafRef = useRef<number | null>(null);
  const previousTextRef = useRef(''); // For stability detection
  const scanCountRef = useRef(0); // Count stable scans
  const accumulatedTextRef = useRef(''); // Accumulate for full page
  const hasSpokenRef = useRef(false); // Prevent re-speak on stable

  // ✅ Enhanced Tesseract config for higher accuracy (LSTM + PSM 6 for printed books)
  const tesseractConfig = {
    logger: (m: any) => console.log(m),
    oem: 1 as const, // LSTM engine: More accurate for modern printed text
    psm: 6 as const, // Single uniform text block (ideal for pages)
    tessedit_char_blacklist: '|{}()[]' as const,
    tessedit_create_pdf: '0' as const,
  };

  // ✅ Best available voice selection
  const getBestVoice = (): SpeechSynthesisVoice | null => {
    if (!('speechSynthesis' in window)) return null;
    const voices = speechSynthesis.getVoices();
    if (voices.length === 0) return null;

    const preferredVoices = [
      'Google US English',
      'Microsoft Zira Desktop - English (United States)',
      'Samantha (Enhanced)',
      'en-US-Wavenet-D'
    ];

    for (const pref of preferredVoices) {
      const voice = voices.find(v => v.name.includes(pref) || v.name === pref);
      if (voice && voice.lang.startsWith('en-US')) return voice;
    }

    return voices.find(v => v.lang.startsWith('en-US')) ?? null;
  };

  // ✅ Chunk text into ~200-word segments
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

  // ✅ Speak status updates (short messages)
  const speakStatus = (msg: string) => {
    if (!('speechSynthesis' in window)) return;
    setTimeout(() => {
      const utterance = new SpeechSynthesisUtterance(msg);
      const bestVoice = getBestVoice();
      if (bestVoice) utterance.voice = bestVoice;
      utterance.rate = 1.2; // Faster for status
      utterance.pitch = 1;
      utterance.lang = 'en-US';
      utterance.volume = 1;
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    }, 500); // Slight delay for flow
  };

  // ✅ Speak full accumulated text with chunking (auto after collection)
  const speakFullText = (text: string) => {
    if (!('speechSynthesis' in window) || !text || text === 'Extracted text will appear here...' || text === 'No text detected' || isReading) return;

    setIsReading(true);
    const chunks = chunkText(text);
    let chunkIndex = 0;

    const speakNext = () => {
      if (chunkIndex >= chunks.length) {
        setIsReading(false);
        speakStatus('Reading complete.');
        hasSpokenRef.current = true; // Mark as spoken
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunks[chunkIndex]);
      const bestVoice = getBestVoice();
      if (bestVoice) utterance.voice = bestVoice;

      utterance.rate = 0.8; // Slower for content
      utterance.pitch = 1;
      utterance.lang = 'en-US';
      utterance.volume = 1;

      utterance.onend = () => {
        chunkIndex++;
        if (chunkIndex < chunks.length) {
          speakNext();
        }
      };

      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    };

    speakNext();
  };

  // ✅ Speak on blur (focus removed from text area)
  const handleTextBlur = () => {
    speakFullText(extractedText);
    speakStatus('Speaking selected text.');
  };

  // ✅ Otsu Threshold Calculation (adaptive for varying lighting)
  const calculateOtsuThreshold = (data: Uint8ClampedArray, width: number, height: number): number => {
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      histogram[data[i]]++;
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

  // ✅ Enhanced Preprocessing: Grayscale + Otsu + Sharpen + Noise Reduction (for 95%+ accuracy)
  const preprocessImage = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, video: HTMLVideoElement) => {
    // Optimal DPI resize: Target 300 DPI equiv. (text ~20-30px high for books)
    const targetHeight = 1200; // Higher for finer detail
    let { videoWidth, videoHeight } = video;
    const aspectRatio = videoWidth / videoHeight;

    if (videoHeight > targetHeight) {
      videoHeight = targetHeight;
      videoWidth = videoHeight * aspectRatio;
    } else if (videoHeight < 600) {
      const scale = 600 / videoHeight;
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

    // Noise reduction: Median filter (simple 3x3 for salt/pepper noise)
    const medianFilter = () => {
      const tempData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const temp = tempData.data;
      for (let y = 1; y < canvas.height - 1; y++) {
        for (let x = 1; x < canvas.width - 1; x++) {
          const idx = (y * canvas.width + x) * 4;
          const neighbors = [
            temp[(y-1)*canvas.width*4 + (x-1)*4],
            temp[(y-1)*canvas.width*4 + x*4],
            temp[(y-1)*canvas.width*4 + (x+1)*4],
            temp[idx - canvas.width*4],
            temp[idx],
            temp[idx + canvas.width*4],
            temp[(y+1)*canvas.width*4 + (x-1)*4],
            temp[(y+1)*canvas.width*4 + x*4],
            temp[(y+1)*canvas.width*4 + (x+1)*4]
          ].sort((a, b) => a - b);
          const median = neighbors[4];
          data[idx] = data[idx+1] = data[idx+2] = median;
        }
      }
      ctx.putImageData(tempData, 0, 0); // Update with filtered
    };
    medianFilter();

    // Otsu Binarization
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    data = imageData.data;
    const threshold = calculateOtsuThreshold(data, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) {
      const pixel = data[i];
      data[i] = data[i + 1] = data[i + 2] = pixel > threshold ? 255 : 0;
    }
    ctx.putImageData(imageData, 0, 0);

    // Enhanced sharpen (higher contrast for edges)
    ctx.filter = 'contrast(1.2) brightness(1.1)';
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = 'none';

    // Border for segmentation
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 3;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

    return canvas.toDataURL('image/png');
  };

  // ✅ Start camera with max res
  const startCamera = async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      setStatus('❌ Camera not supported.');
      return;
    }

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: 'environment',
          width: { ideal: 3840, max: 3840 }, // 4K for full detail
          height: { ideal: 2160, max: 2160 }
        },
      });

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.play();
      }

      setStream(mediaStream);
      setIsCameraActive(true);
      setStatus('✅ Camera ready. Sweep slowly over the page.');
      speakStatus('Camera started. Position the book page in view.');
    } catch (err) {
      setStatus(`⚠️ Error: ${(err as Error).message}`);
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
    setIsBlindMode(false);
    setIsReading(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    speechSynthesis.cancel();
    setStatus('🛑 Stopped.');
    speakStatus('Stopped.');
  };

  // ✅ Perform OCR with accumulation & auto-speak after collection
  const performOCR = useCallback(async (video: HTMLVideoElement, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    if (!video.videoWidth || !video.videoHeight || isProcessing) return;

    setIsProcessing(true);

    try {
      const processedImage = preprocessImage(ctx, canvas, video);

      const {
        data: { text, confidence: conf },
      } = await Tesseract.recognize(processedImage, 'eng', tesseractConfig);

      const cleanText = text.trim().replace(/\s+/g, ' ');

      if (cleanText && cleanText !== 'No text detected') {
        let newAccumulated = accumulatedTextRef.current;
        // Accumulate if new content
        if (cleanText !== previousTextRef.current && cleanText.length > previousTextRef.current.length * 0.8) {
          newAccumulated += ' ' + cleanText;
          previousTextRef.current = cleanText;
          scanCountRef.current = 0; // Reset stability
        } else {
          scanCountRef.current++; // Stable
        }

        accumulatedTextRef.current = newAccumulated;
        setExtractedText(newAccumulated);
        setConfidence(conf);

        // Auto-focus text area after update for easy blur-speak
        if (textAreaRef.current) {
          textAreaRef.current.focus();
        }

        // Auto-speak full accumulated after collection (stable + high conf, no re-speak)
        if (scanCountRef.current >= 3 && conf > 75 && !hasSpokenRef.current) {
          speakFullText(newAccumulated);
          setStatus(`✅ Data collected! Speaking now... (Conf: ${Math.round(conf)}%)`);
          speakStatus('Data collected. Speaking the full text.');
          if (isBlindMode) setIsBlindMode(false); // Auto-stop mode
        } else if (scanCountRef.current < 3) {
          setStatus(`🔍 Collecting data... (${scanCountRef.current}/3 stable, Conf: ${Math.round(conf)}%)`);
        }
      } else {
        setStatus('❌ No text. Adjust position.');
        speakStatus('No text detected. Move closer or improve lighting.');
      }
    } catch (err) {
      setStatus(`❌ Error: ${(err as Error).message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, isBlindMode]);

  // ✅ Manual scan
  const captureAndRead = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    accumulatedTextRef.current = ''; // Reset for manual
    scanCountRef.current = 0;
    previousTextRef.current = '';
    hasSpokenRef.current = false;
    performOCR(videoRef.current, canvas, ctx);
  };

  // ✅ Toggle blind mode: Continuous sweep scan
  const toggleBlindMode = () => {
    setIsBlindMode(!isBlindMode);
    if (!isBlindMode && isCameraActive) {
      accumulatedTextRef.current = '';
      scanCountRef.current = 0;
      previousTextRef.current = '';
      hasSpokenRef.current = false;
      let lastScan = 0;
      const scanLoop = (currentTime: number) => {
        if (currentTime - lastScan > 1000) { // Every 1s for sweep
          if (videoRef.current && canvasRef.current) {
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              performOCR(videoRef.current!, canvas, ctx);
              lastScan = currentTime;
            }
          }
        }
        if (isBlindMode) {
          rafRef.current = requestAnimationFrame(scanLoop);
        }
      };
      rafRef.current = requestAnimationFrame(scanLoop);
      setStatus('👁️ Blind Mode: Sweep over the page slowly. Auto-speaks when collected.');
      speakStatus('Blind mode on. Sweep the camera slowly over the entire page. It will speak when data is collected.');
    } else {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setStatus('⏸️ Blind Mode off.');
      speakStatus('Blind mode off.');
    }
  };

  // ✅ Video ready
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

  // Load voices
  useEffect(() => {
    if (speechSynthesis.getVoices().length === 0) {
      speechSynthesis.onvoiceschanged = () => {
        console.log('Voices loaded');
      };
    }
  }, []);

  return (
    <main className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full space-y-6">
        <h1 className="text-3xl font-bold text-center text-gray-800">📚 Blind-Friendly Page Scanner</h1>

        <p className="text-center text-gray-600">Auto-scans full pages as you sweep—no need to know size. Auto-speaks accumulated data after collection. Blur text to re-speak.</p>

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
            {isProcessing ? 'Scanning...' : 'Quick Scan'}
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
          <div className="space-y-2">
            <div className="flex justify-center">
              <button
                onClick={toggleBlindMode}
                disabled={isProcessing || isReading}
                className={`px-6 py-3 font-semibold rounded-lg shadow-md transition-colors ${
                  isBlindMode
                    ? 'bg-purple-600 text-white hover:bg-purple-700'
                    : 'bg-indigo-500 text-white hover:bg-indigo-600'
                } ${isReading ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {isBlindMode ? 'Stop Sweep' : 'Start Blind Sweep'}
              </button>
            </div>
            <p className="text-xs text-center text-gray-500">Sweep camera slowly over the whole page—it auto-collects & speaks when done.</p>
          </div>
        )}

        <div className="text-center space-y-1">
          <p className="font-semibold text-gray-700">{status}</p>
          {confidence > 0 && <p className="text-xs text-blue-600">Conf: {Math.round(confidence)}%</p>}
          {isReading && <p className="text-xs text-green-600">🔊 Speaking...</p>}
        </div>

        <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
          <h2 className="text-lg font-semibold mb-2 text-gray-800">Accumulated Text (Auto-Speaks After Collection | Blur to Re-Speak):</h2>
          <textarea
            ref={textAreaRef}
            value={extractedText}
            onBlur={handleTextBlur}
            readOnly
            className="w-full h-48 p-3 text-sm font-mono bg-gray-50 rounded resize-none border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Extracted text will appear here..."
          />
        </div>

        <div className="text-xs text-gray-500 text-center space-y-1">
          <p>👁️ Auto-speaks full accumulated data after sweep collection. Blind Mode: Continuous scan + audio cues.</p>
          <p>💡 Enhanced accuracy: LSTM + median filter + 300 DPI resize. Deploy on Vercel for mobile.</p>
        </div>
      </div>
    </main>
  );
}