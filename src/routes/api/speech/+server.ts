import { error, json } from "@sveltejs/kit";

import { app } from "#lib/server/receiver.ts";
import { serveSpeech } from "#lib/server/voicevox.ts";
import { DEFAULT_SPEAKER, type SpeechInfo } from "#lib/voices.ts";

import type { RequestHandler } from "./$types";

/**
 * 読み上げの音 (docs/design.md の 2.4)。どれもログインが要る (hooks)。
 * VOICEVOX が無い・つながらないときは `available: false` と 503 を返し、画面は端末の読み上げで読む。
 * 声はこの家で 1 つ (サーバーの DB)。全部の端末が同じ声で読む。
 */

const OFF: SpeechInfo = {
  available: false,
  defaultSpeaker: DEFAULT_SPEAKER,
  voice: DEFAULT_SPEAKER,
  voices: [],
};

/** 選べる声・読む声と、つながっているか */
export const GET: RequestHandler = () => {
  const v = app().voice;
  return json(v ? v.info() : OFF);
};

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await request.json();
    if (typeof v === "object" && v !== null)
      return v as Record<string, unknown>;
  } catch {
    // 下で 400
  }
  error(400, "JSON の本文が要ります");
}

/**
 * この家の声を替える。`{ voice }` (VOICEVOX のスタイルの id)。ログインした人なら誰でも替えられる
 * (通すロールは 1 つで、ログインした人はみな同じロールを持つ。2.6)。
 * 本文は JSON だけ受ける (ほかのサイトから JSON で送るにはプリフライトが要り、通らない。
 * フォームの形はそもそも SvelteKit が別のオリジンから受けない)
 */
export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) error(401, "login required");
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json")) error(415, "JSON の本文が要ります");
  const v = app().voice;
  if (!v) error(404, "VOICEVOX は使っていません");
  const b = await body(request);
  const id = b.voice;
  if (typeof id !== "number" || !Number.isInteger(id))
    error(400, "voice が要ります");
  if (!v.setVoice(id, locals.user.subject)) error(400, "選べない声です");
  return json(v.info());
};

/** 1 つの文の音 (WAV)。`{ text }`。声はこの家で選んである声 */
export const POST: RequestHandler = async ({ request }) => {
  const v = app().voice;
  if (!v) error(503, "VOICEVOX は使っていません");
  const b = await body(request);
  if (typeof b.text !== "string" || b.text.length > 500)
    error(400, "text が要ります");
  return serveSpeech(v, b.text);
};
