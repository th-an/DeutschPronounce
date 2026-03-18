import React from 'react';
import { CheckCircle2, AlertCircle, Lightbulb } from 'lucide-react';
import { motion } from 'motion/react';
import ReactMarkdown from 'react-markdown';

interface ScoreCardProps {
  score: number;
  feedback: string;
  suggestions: string[];
  transcription: string;
}

export const ScoreCard: React.FC<ScoreCardProps> = ({ score, feedback, suggestions, transcription }) => {
  const getScoreColor = (s: number) => {
    if (s >= 80) return 'text-emerald-500 border-emerald-500';
    if (s >= 50) return 'text-amber-500 border-amber-500';
    return 'text-red-500 border-red-500';
  };

  return (
    <motion.div
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="w-full max-w-2xl bg-white rounded-3xl p-8 shadow-xl border border-slate-100"
    >
      <div className="flex items-center justify-between mb-8">
        <div>
          <h3 className="text-2xl font-bold text-slate-900">Evaluation Result</h3>
          <p className="text-slate-500">How you performed</p>
        </div>
        <div className={`w-24 h-24 rounded-full border-4 flex flex-col items-center justify-center ${getScoreColor(score)}`}>
          <span className="text-3xl font-black">{score}</span>
          <span className="text-[10px] uppercase font-bold tracking-widest">Score</span>
        </div>
      </div>

      <div className="space-y-6">
        <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
          <div className="flex items-center gap-2 mb-2 text-slate-900 font-semibold">
            <CheckCircle2 className="w-5 h-5 text-emerald-500" />
            <span>Transcription</span>
          </div>
          <p className="italic text-slate-700">"{transcription}"</p>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-2 text-slate-900 font-semibold">
            <AlertCircle className="w-5 h-5 text-amber-500" />
            <span>Feedback</span>
          </div>
          <div className="prose prose-slate max-w-none text-slate-600 text-sm">
            <ReactMarkdown>{feedback}</ReactMarkdown>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-2 text-slate-900 font-semibold">
            <Lightbulb className="w-5 h-5 text-indigo-500" />
            <span>Suggestions</span>
          </div>
          <ul className="grid gap-2">
            {suggestions.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0" />
                {s}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </motion.div>
  );
};
