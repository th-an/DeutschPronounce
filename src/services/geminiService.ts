import { GoogleGenAI, Type, Modality } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface EvaluationResult {
  score: number;
  feedback: string;
  suggestions: string[];
  transcription: string;
}

export async function generateSpeech(text: string): Promise<{ data: string; mimeType: string }> {
  let attempts = 0;
  const maxAttempts = 2;

  while (attempts < maxAttempts) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Pronounce the following German text clearly: ${text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Charon' },
            },
          },
        },
      });

      const candidate = response.candidates?.[0];
      if (!candidate?.content?.parts) {
        throw new Error("No candidates or parts in response");
      }

      for (const part of candidate.content.parts) {
        if (part.inlineData) {
          return { data: part.inlineData.data, mimeType: part.inlineData.mimeType };
        }
      }
      throw new Error("No audio data found in response parts");
    } catch (error) {
      attempts++;
      if (attempts === maxAttempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
    }
  }
  throw new Error("Failed to generate speech after retries");
}

export async function evaluatePronunciation(
  audioBase64: string,
  targetPhrase: string,
  level: string
): Promise<EvaluationResult> {
  const model = "gemini-3-flash-preview";
  
  const prompt = `
    Evaluate the German pronunciation of the following phrase: "${targetPhrase}".
    The learner is at level ${level}.
    Compare the provided audio with the target phrase.
    Provide a score from 0 to 100, detailed feedback on pronunciation, and specific suggestions for improvement.
    Also provide a transcription of what you heard.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "audio/webm",
              data: audioBase64,
            },
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          score: { type: Type.NUMBER },
          feedback: { type: Type.STRING },
          suggestions: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          transcription: { type: Type.STRING },
        },
        required: ["score", "feedback", "suggestions", "transcription"],
      },
    },
  });

  const text = response.text;
  if (!text) throw new Error("No response from AI");
  return JSON.parse(text);
}

export async function generateExerciseImage(phrase: string, translation: string): Promise<string> {
  try {
    const prompt = `
      Create a simple, minimalist, black and white line drawing illustration for a German language learning app.
      The style should match the "Start Deutsch 1" exam paper: clear, thick outlines, hand-drawn sketch aesthetic, no background, high contrast.
      The illustration should represent this phrase: "${phrase}" (${translation}).
      If it's a room number, show a simple door or sign with the number.
      If it's a price, show the item with a clear price tag.
      If it's a clock, show a simple clock face with the correct time.
      If it's food, show a simple plate with the food item.
      Keep it very simple and educational.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          {
            text: prompt,
          },
        ],
      },
      config: {
        imageConfig: {
          aspectRatio: "4:3",
          imageSize: "1K"
        },
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
    throw new Error("No image data found in response");
  } catch (error) {
    console.error("Image generation failed:", error);
    // Fallback to a relevant picsum image if generation fails
    return `https://picsum.photos/seed/${encodeURIComponent(phrase)}/400/300`;
  }
}
