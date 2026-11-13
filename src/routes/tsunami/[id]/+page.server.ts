import { error } from "@sveltejs/kit";

import { app } from "#lib/server/receiver.ts";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const tsunami = app().store.tsunami(params.id);
  if (!tsunami) error(404, "この津波の情報はありません");
  return { tsunami };
};
