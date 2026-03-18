import React, { useState, useEffect, useMemo } from 'react';
import { auth, db } from './firebase';
import { onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut, User } from 'firebase/auth';
import { collection, addDoc, query, where, orderBy, onSnapshot, doc, setDoc, getDoc, getDocs, limit, getDocFromServer } from 'firebase/firestore';
import { motion, AnimatePresence } from 'motion/react';
import { Languages, Trophy, History, LogIn, LogOut, ChevronRight, ChevronLeft, RefreshCw, Star, Volume2, Loader2, List, Play, AlertCircle } from 'lucide-react';
import { AudioRecorder } from './components/AudioRecorder';
import { ScoreCard } from './components/ScoreCard';
import { evaluatePronunciation, generateSpeech, generateExerciseImage, EvaluationResult } from './services/geminiService';
import { GERMAN_LEVELS, GermanLevel, EXERCISES, Exercise } from './constants';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function pcmToWav(pcmBase64: string, sampleRate: number = 24000): string {
  const binaryString = window.atob(pcmBase64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  const wavHeader = new ArrayBuffer(44);
  const view = new DataView(wavHeader);
  
  // RIFF identifier
  view.setUint32(0, 0x52494646, false); // "RIFF"
  // file length
  view.setUint32(4, 36 + len, true);
  // RIFF type
  view.setUint32(8, 0x57415645, false); // "WAVE"
  // format chunk identifier
  view.setUint32(12, 0x666d7420, false); // "fmt "
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (raw)
  view.setUint16(20, 1, true); // PCM
  // channel count
  view.setUint16(22, 1, true); // Mono
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sample rate * block align)
  view.setUint32(28, sampleRate * 2, true);
  // block align (channel count * bytes per sample)
  view.setUint16(32, 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier
  view.setUint32(36, 0x64617461, false); // "data"
  // data chunk length
  view.setUint32(40, len, true);
  
  const blob = new Blob([wavHeader, bytes], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration. ");
    }
  }
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "Something went wrong.";
      try {
        const parsed = JSON.parse(this.state.error?.message || "{}");
        if (parsed.error) errorMessage = `Firestore Error: ${parsed.error}`;
      } catch {
        errorMessage = this.state.error?.message || errorMessage;
      }
      return (
        <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center bg-gray-50">
          <AlertCircle className="w-16 h-16 text-red-500 mb-4" />
          <h1 className="text-2xl font-bold text-gray-900 mb-4">Oops!</h1>
          <p className="text-gray-600 mb-6 max-w-md mx-auto">{errorMessage}</p>
          <button 
            onClick={() => window.location.reload()} 
            className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium"
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [currentLevel, setCurrentLevel] = useState<GermanLevel>("Letters");
  const [currentExercise, setCurrentExercise] = useState<Exercise>(EXERCISES[0]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [lastResult, setLastResult] = useState<EvaluationResult | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [view, setView] = useState<'practice' | 'history'>('practice');
  const [currentPage, setCurrentPage] = useState(0);
  const [isListView, setIsListView] = useState(false);
  const [generatedImages, setGeneratedImages] = useState<Record<string, string>>({});
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);

  useEffect(() => {
    const fetchImage = async () => {
      if (currentExercise?.imageUrl === "GENERATE" && !generatedImages[currentExercise.phrase]) {
        setIsGeneratingImage(true);
        try {
          const url = await generateExerciseImage(currentExercise.phrase, currentExercise.translation);
          setGeneratedImages(prev => ({ ...prev, [currentExercise.phrase]: url }));
        } catch (err) {
          console.error("Failed to generate image:", err);
        } finally {
          setIsGeneratingImage(false);
        }
      }
    };
    fetchImage();
  }, [currentExercise, generatedImages]);

  useEffect(() => {
    testConnection();
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        // Load user profile
        try {
          const userDoc = await getDoc(doc(db, 'users', u.uid));
          if (userDoc.exists()) {
            setCurrentLevel(userDoc.data().currentLevel as GermanLevel);
          } else {
            // Create profile
            await setDoc(doc(db, 'users', u.uid), {
              uid: u.uid,
              displayName: u.displayName,
              currentLevel: "Letters",
              createdAt: new Date().toISOString()
            });
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.GET, `users/${u.uid}`);
        }

        // Load history
        const q = query(
          collection(db, 'scores'),
          where('userId', '==', u.uid),
          orderBy('timestamp', 'desc')
        );
        const unsubHistory = onSnapshot(q, (snapshot) => {
          setHistory(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
        }, (error) => {
          handleFirestoreError(error, OperationType.LIST, 'scores');
        });
        return () => unsubHistory();
      }
    });
    return () => unsubscribe();
  }, []);

  const filteredExercises = useMemo(() => 
    EXERCISES.filter(e => e.level === currentLevel),
  [currentLevel]);

  const pageSize = currentLevel === "Letters" ? filteredExercises.length : 10;
  const totalPages = Math.ceil(filteredExercises.length / pageSize);
  
  const paginatedExercises = useMemo(() => {
    const start = currentPage * pageSize;
    return filteredExercises.slice(start, start + pageSize);
  }, [filteredExercises, currentPage, pageSize]);

  const prevExercise = () => {
    if (!currentExercise || filteredExercises.length === 0) return;
    const currentIndex = filteredExercises.findIndex(e => e.phrase === currentExercise.phrase);
    const prevIndex = (currentIndex - 1 + filteredExercises.length) % filteredExercises.length;
    setCurrentExercise(filteredExercises[prevIndex]);
    setLastResult(null);
    
    // Update page if necessary
    const newPage = Math.floor(prevIndex / pageSize);
    if (newPage !== currentPage) {
      setCurrentPage(newPage);
    }
  };

  const nextExercise = () => {
    if (!currentExercise || filteredExercises.length === 0) return;
    const currentIndex = filteredExercises.findIndex(e => e.phrase === currentExercise.phrase);
    const nextIndex = (currentIndex + 1) % filteredExercises.length;
    setCurrentExercise(filteredExercises[nextIndex]);
    setLastResult(null);

    // Update page if necessary
    const newPage = Math.floor(nextIndex / pageSize);
    if (newPage !== currentPage) {
      setCurrentPage(newPage);
    }
  };

  useEffect(() => {
    if (filteredExercises.length > 0) {
      setCurrentExercise(filteredExercises[0]);
    }
    setLastResult(null);
  }, [currentLevel]);

  const handleLevelChange = async (level: GermanLevel) => {
    setCurrentLevel(level);
    setCurrentPage(0);
    if (user) {
      try {
        await setDoc(doc(db, 'users', user.uid), { currentLevel: level }, { merge: true });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`);
      }
    }
  };

  const handleListen = async () => {
    if (isSpeaking || !currentExercise) return;
    setIsSpeaking(true);
    try {
      // Check cache first
      const q = query(
        collection(db, 'audio_cache'),
        where('phrase', '==', currentExercise.phrase),
        where('voice', '==', 'Charon'),
        limit(1)
      );
      const cacheSnap = await getDocs(q);
      
      let audioData: string;
      let mimeType: string;
      
      if (!cacheSnap.empty) {
        const cached = cacheSnap.docs[0].data();
        audioData = cached.audioData;
        mimeType = cached.mimeType;
      } else {
        // Generate and cache
        const result = await generateSpeech(currentExercise.phrase);
        audioData = result.data;
        mimeType = result.mimeType;
        
        // Save to cache
        try {
          await addDoc(collection(db, 'audio_cache'), {
            phrase: currentExercise.phrase,
            voice: 'Charon',
            audioData: audioData,
            mimeType: mimeType,
            createdAt: new Date().toISOString()
          });
        } catch (error) {
          handleFirestoreError(error, OperationType.CREATE, 'audio_cache');
        }
      }
      
      let audioUrl: string;
      if (mimeType.includes('pcm')) {
        audioUrl = pcmToWav(audioData);
      } else {
        audioUrl = `data:${mimeType};base64,${audioData}`;
      }
      
      const audio = new Audio(audioUrl);
      await audio.play();
      
      if (audioUrl.startsWith('blob:')) {
        audio.onended = () => URL.revokeObjectURL(audioUrl);
      }
    } catch (err) {
      console.error("TTS error:", err);
      alert("Failed to play audio pronunciation.");
    } finally {
      setIsSpeaking(false);
    }
  };

  const handleRecordingComplete = async (audioBase64: string) => {
    if (!user || !currentExercise) {
      alert("Please sign in to save your progress.");
      return;
    }

    setIsProcessing(true);
    try {
      const result = await evaluatePronunciation(audioBase64, currentExercise.phrase, currentLevel);
      setLastResult(result);

      // Save to Firestore
      try {
        await addDoc(collection(db, 'scores'), {
          userId: user.uid,
          phrase: currentExercise.phrase,
          level: currentLevel,
          score: result.score,
          feedback: result.feedback,
          suggestions: result.suggestions,
          transcription: result.transcription,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, 'scores');
      }
    } catch (err) {
      console.error("Evaluation error:", err);
      alert("Failed to evaluate pronunciation. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  const login = () => signInWithPopup(auth, new GoogleAuthProvider());
  const logout = () => signOut(auth);

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <motion.div 
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="max-w-md w-full bg-white rounded-3xl p-12 shadow-2xl text-center border border-slate-100"
        >
          <div className="w-20 h-20 bg-emerald-100 rounded-2xl flex items-center justify-center mx-auto mb-8">
            <Languages className="w-10 h-10 text-emerald-600" />
          </div>
          <h1 className="text-4xl font-black text-slate-900 mb-4 tracking-tight">DeutschPronounce</h1>
          <p className="text-slate-500 mb-10 text-lg">Master your German pronunciation from A1 to C2 with AI-powered feedback.</p>
          <button
            onClick={login}
            className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-slate-800 transition-all shadow-lg active:scale-95"
          >
            <LogIn className="w-5 h-5" />
            Sign in with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-emerald-100 selection:text-emerald-900">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-slate-100 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-200">
              <Languages className="w-6 h-6" />
            </div>
            <span className="text-xl font-black tracking-tight hidden sm:block">DeutschPronounce</span>
          </div>

          <nav className="flex bg-slate-100 p-1 rounded-xl">
            <button
              onClick={() => setView('practice')}
              className={cn(
                "px-6 py-2 rounded-lg text-sm font-bold transition-all",
                view === 'practice' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              Practice
            </button>
            <button
              onClick={() => setView('history')}
              className={cn(
                "px-6 py-2 rounded-lg text-sm font-bold transition-all",
                view === 'history' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              History
            </button>
          </nav>

          <div className="flex items-center gap-4">
            <div className="hidden md:flex flex-col items-end">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Level</span>
              <span className="text-sm font-black text-emerald-600">{currentLevel}</span>
            </div>
            <button
              onClick={logout}
              className="p-2 hover:bg-slate-100 rounded-xl transition-colors text-slate-400 hover:text-red-500"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 md:p-12">
        <AnimatePresence mode="wait">
          {view === 'practice' ? (
            <motion.div
              key="practice"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="grid lg:grid-cols-[1fr_400px] gap-12 items-start"
            >
              <div className="space-y-12">
                {/* Level Selector */}
                <section>
                  <h2 className="text-xs font-bold text-slate-400 uppercase tracking-[0.2em] mb-6">Select Your Level</h2>
                  <div className="flex flex-wrap gap-3">
                    {GERMAN_LEVELS.map((l) => (
                      <button
                        key={l}
                        onClick={() => handleLevelChange(l)}
                        className={cn(
                          "px-6 py-3 rounded-2xl font-black transition-all border-2",
                          currentLevel === l 
                            ? "bg-emerald-500 border-emerald-500 text-white shadow-lg shadow-emerald-100 scale-105" 
                            : "bg-white border-slate-100 text-slate-400 hover:border-slate-200 hover:text-slate-600"
                        )}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </section>

                {/* Browse Exercises */}
                <section>
                  <div className="flex items-center justify-between mb-6 bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                    <div className="flex flex-col">
                      <h2 className="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">
                        {currentLevel === "Letters" ? "All Letters" : "Browse Exercises"}
                      </h2>
                      <p className="text-sm font-black text-slate-900">
                        Page {currentPage + 1} of {totalPages}
                      </p>
                    </div>
                    {totalPages > 1 && (
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setCurrentPage(prev => Math.max(0, prev - 1))}
                          disabled={currentPage === 0}
                          className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-slate-400 disabled:opacity-30 hover:text-slate-900 hover:bg-white transition-all shadow-sm"
                        >
                          <ChevronLeft className="w-5 h-5" />
                        </button>
                        <div className="flex gap-1">
                          {Array.from({ length: totalPages }).map((_, i) => (
                            <div 
                              key={i} 
                              className={cn(
                                "w-2 h-2 rounded-full transition-all",
                                currentPage === i ? "w-6 bg-emerald-500" : "bg-slate-200"
                              )}
                            />
                          ))}
                        </div>
                        <button
                          onClick={() => setCurrentPage(prev => Math.min(totalPages - 1, prev + 1))}
                          disabled={currentPage === totalPages - 1}
                          className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-slate-400 disabled:opacity-30 hover:text-slate-900 hover:bg-white transition-all shadow-sm"
                        >
                          <ChevronRight className="w-5 h-5" />
                        </button>
                      </div>
                    )}
                  </div>
                  
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
                    {paginatedExercises.map((ex) => (
                      <button
                        key={ex.phrase}
                        onClick={() => {
                          setCurrentExercise(ex);
                          setLastResult(null);
                        }}
                        className={cn(
                          "p-4 rounded-2xl text-center transition-all border-2 group",
                          currentExercise?.phrase === ex.phrase
                            ? "bg-emerald-50 border-emerald-500 text-emerald-900 shadow-sm"
                            : "bg-white border-slate-100 text-slate-600 hover:border-slate-200"
                        )}
                      >
                        <div className="text-lg font-black mb-1 group-hover:scale-110 transition-transform">
                          {ex.phrase}
                        </div>
                        <div className="text-[10px] text-slate-400 font-medium truncate">
                          {ex.translation}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>

                {/* Exercise Card */}
                <section className="bg-white rounded-[2.5rem] p-12 shadow-2xl shadow-slate-200/50 border border-slate-100 relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-8">
                    <Star className="w-12 h-12 text-slate-50 opacity-10" />
                  </div>
                  
                  <div className="relative z-10">
                    {currentExercise ? (
                      <>
                        <div className="flex items-center gap-2 mb-8">
                          <span className="px-3 py-1 bg-emerald-100 text-emerald-700 text-[10px] font-black uppercase tracking-widest rounded-full">
                            {currentLevel} Exercise
                          </span>
                        </div>

                        <div className="flex flex-col md:flex-row gap-8 mb-12">
                          {(currentExercise.imageUrl || generatedImages[currentExercise.phrase]) && (
                            <div className="w-full md:w-1/3 shrink-0 relative group">
                              {isGeneratingImage && !generatedImages[currentExercise.phrase] ? (
                                <div className="w-full aspect-video bg-slate-50 rounded-2xl flex flex-col items-center justify-center border-2 border-dashed border-slate-200 animate-pulse">
                                  <Loader2 className="w-8 h-8 text-slate-300 animate-spin mb-2" />
                                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Generating Visual...</span>
                                </div>
                              ) : (
                                <img 
                                  src={generatedImages[currentExercise.phrase] || currentExercise.imageUrl} 
                                  alt={currentExercise.phrase}
                                  className="w-full aspect-video object-cover rounded-2xl shadow-md border border-slate-100 group-hover:shadow-xl transition-shadow"
                                  referrerPolicy="no-referrer"
                                />
                              )}
                              <div className="absolute -bottom-2 -right-2 bg-white px-2 py-1 rounded-lg border border-slate-100 shadow-sm text-[8px] font-black text-slate-400 uppercase tracking-tighter">
                                Exam Material Style
                              </div>
                            </div>
                          )}
                          <div className="flex-1">
                            <h1 className="text-4xl md:text-5xl font-black text-slate-900 mb-4 leading-tight">
                              {currentExercise.phrase}
                            </h1>
                            <p className="text-xl text-slate-400 font-medium italic">
                              "{currentExercise.translation}"
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-6">
                          <button
                            onClick={handleListen}
                            disabled={isSpeaking}
                            className="w-16 h-16 rounded-2xl bg-indigo-100 hover:bg-indigo-200 flex items-center justify-center text-indigo-600 transition-all disabled:opacity-50"
                            title="Listen to pronunciation"
                          >
                            {isSpeaking ? <Loader2 className="w-6 h-6 animate-spin" /> : <Volume2 className="w-8 h-8" />}
                          </button>

                          <AudioRecorder 
                            onRecordingComplete={handleRecordingComplete}
                            isProcessing={isProcessing}
                          />
                          
                          <div className="flex items-center gap-4 ml-auto">
                            <button
                              onClick={prevExercise}
                              className="flex items-center gap-2 text-slate-400 hover:text-slate-900 font-bold transition-colors group"
                            >
                              <ChevronLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
                              Prev
                            </button>
                            <div className="h-8 w-px bg-slate-100 mx-2" />
                            <button
                              onClick={nextExercise}
                              className="flex items-center gap-2 text-slate-400 hover:text-slate-900 font-bold transition-colors group"
                            >
                              Next
                              <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                            </button>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="text-center py-20">
                        <Loader2 className="w-10 h-10 animate-spin text-slate-200 mx-auto mb-4" />
                        <p className="text-slate-400">Loading exercise...</p>
                      </div>
                    )}
                  </div>
                </section>

                {/* Result */}
                {lastResult && (
                  <ScoreCard 
                    score={lastResult.score}
                    feedback={lastResult.feedback}
                    suggestions={lastResult.suggestions}
                    transcription={lastResult.transcription}
                  />
                )}
              </div>

              {/* Sidebar Stats */}
              <aside className="space-y-8">
                <div className="bg-slate-900 rounded-[2rem] p-8 text-white shadow-xl">
                  <div className="flex items-center gap-3 mb-6">
                    <Trophy className="w-6 h-6 text-amber-400" />
                    <h3 className="text-lg font-bold">Your Progress</h3>
                  </div>
                  <div className="space-y-4">
                    <div className="flex justify-between items-end">
                      <span className="text-slate-400 text-sm">Average Score</span>
                      <span className="text-3xl font-black">
                        {history.length > 0 
                          ? Math.round(history.reduce((acc, curr) => acc + curr.score, 0) / history.length)
                          : 0}
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${history.length > 0 ? history.reduce((acc, curr) => acc + curr.score, 0) / history.length : 0}%` }}
                        className="h-full bg-emerald-500"
                      />
                    </div>
                    <div className="flex justify-between text-xs font-bold text-slate-500 uppercase tracking-widest pt-2">
                      <span>Total Attempts</span>
                      <span>{history.length}</span>
                    </div>
                  </div>
                </div>

                <div className="bg-white rounded-[2rem] p-8 border border-slate-100 shadow-lg">
                  <div className="flex items-center gap-3 mb-6">
                    <History className="w-5 h-5 text-indigo-500" />
                    <h3 className="text-lg font-bold">Recent Activity</h3>
                  </div>
                  <div className="space-y-4">
                    {history.slice(0, 3).map((item) => (
                      <div key={item.id} className="flex items-center justify-between p-3 rounded-xl hover:bg-slate-50 transition-colors">
                        <div className="min-w-0">
                          <p className="text-sm font-bold truncate pr-4">{item.phrase}</p>
                          <p className="text-[10px] text-slate-400 uppercase font-black">{item.level}</p>
                        </div>
                        <span className={cn(
                          "text-sm font-black",
                          item.score >= 80 ? "text-emerald-500" : item.score >= 50 ? "text-amber-500" : "text-red-500"
                        )}>
                          {item.score}
                        </span>
                      </div>
                    ))}
                    {history.length === 0 && (
                      <p className="text-sm text-slate-400 italic text-center py-4">No attempts yet</p>
                    )}
                  </div>
                </div>
              </aside>
            </motion.div>
          ) : (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-3xl font-black">Practice History</h2>
                <button 
                  onClick={() => setView('practice')}
                  className="flex items-center gap-2 text-emerald-600 font-bold hover:underline"
                >
                  Back to Practice
                </button>
              </div>

              <div className="grid gap-4">
                {history.map((item) => (
                  <div key={item.id} className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-black rounded uppercase">
                          {item.level}
                        </span>
                        <span className="text-xs text-slate-400">
                          {new Date(item.timestamp).toLocaleDateString()}
                        </span>
                      </div>
                      <h4 className="text-lg font-bold">{item.phrase}</h4>
                      <p className="text-sm text-slate-500 line-clamp-1">{item.feedback}</p>
                    </div>
                    <div className="flex items-center gap-6">
                      <div className="text-right">
                        <p className="text-[10px] text-slate-400 uppercase font-black tracking-widest">Score</p>
                        <p className={cn(
                          "text-2xl font-black",
                          item.score >= 80 ? "text-emerald-500" : item.score >= 50 ? "text-amber-500" : "text-red-500"
                        )}>
                          {item.score}
                        </p>
                      </div>
                      <button 
                        onClick={() => {
                          setCurrentLevel(item.level);
                          setCurrentExercise(EXERCISES.find(e => e.phrase === item.phrase) || EXERCISES[0]);
                          setView('practice');
                        }}
                        className="p-3 bg-slate-50 hover:bg-slate-100 rounded-2xl transition-colors text-slate-400 hover:text-slate-900"
                      >
                        <RefreshCw className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                ))}
                {history.length === 0 && (
                  <div className="text-center py-20 bg-white rounded-[3rem] border border-dashed border-slate-200">
                    <History className="w-12 h-12 text-slate-200 mx-auto mb-4" />
                    <p className="text-slate-400 font-medium">No history found. Start practicing to see your progress!</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

export default function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

