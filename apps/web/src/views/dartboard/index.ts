import type { View } from "../types";
import { DARTBOARD_TOOLS, mountDartboard } from "./board";

export const dartboard: View<typeof DARTBOARD_TOOLS> = {
  id: "dartboard",
  name: "dartboard",
  profile: "spatial: where a task sits says what it is (quadrant) and how near it is (ring)",
  affordances: DARTBOARD_TOOLS,
  mount: mountDartboard,
};
