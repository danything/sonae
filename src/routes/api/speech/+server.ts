import { error, json } from "@sveltejs/kit";

import { app } from "#lib/server/receiver.ts";
import { serveSpeech } from "#lib/server/voicevox.ts";
import { DEFAULT_SPEAKER, type SpeechInfo } from "#lib/voices.ts";

import type { RequestHandler } from "./$types";

/**
 * 読み上げの音 (docs/design.md の 2.4)。どれもログインが要る (hooks)。
 * VOICEVOX が無い・つながらないときは `available: false` と 503 を返し、画面は端末の読み上げで読む。
 */

const OFF: SpeechInfo = {
  available: false,
  defaultSpeaker: DEFAULT_SPEAKER,
  voices: [],
};

/**
 * 選べる声と、つながっているか。`?voice=<id>` を付けると、その声が使われていると覚え、
 * 決まった文を合成しておく (端末が声を選んだとき・画面を開いたときに呼ぶ)
 */
export const GET: RequestHandler = ({ url }) => {
  const v = app().voice;
  if (!v) return json(OFF);
  const voice = Number(url.searchParams.get("voice") ?? "");
  if (url.searchParams.has("voice") && Number.isInteger(voice)) v.use(voice);
  return json(v.info());
};

/** 1 つの文の音 (WAV)。`{ text, voice }` */
export const POST: RequestHandler = async ({ request }) => {
  const v = app().voice;
  if (!v) error(503, "VOICEVOX は使っていません");
  let b: { text?: unknown; voice?: unknown };
  try {
    b = (await request.json()) as typeof b;
  } catch {
    error(400, "JSON の本文が要ります");
  }
  if (typeof b.text !== "string" || b.text.length > 500)
    error(400, "text が要ります");
  return serveSpeech(v, {
    text: b.text,
    voice: typeof b.voice === "number" ? b.voice : undefined,
  });
};
