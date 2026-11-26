import type { View } from "../types";
import { AFFORDANCES } from "./sync";
import { mountBoard } from "./view";

/**
 * The dartboard, rebuilt: the same board as `dartboard`, laid out in closed form.
 * See scene.ts for what is drawn where, sync.ts for what is sent, view.ts for the DOM.
 */
export const dartboard2: View<typeof AFFORDANCES> = {
  id: "dartboard2",
  name: "dartboard 2",
  profile: "deadline-driven: what is due soon sits near the middle",
  affordances: AFFORDANCES,
  mount: mountBoard,
};
