import { error } from "@sveltejs/kit";

import { app } from "#lib/server/receiver.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const quake = app().store.quake(params.id);
  if (!quake) error(404, "この地震の情報はありません");
  return { quake };
};
