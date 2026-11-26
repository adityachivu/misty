import { draftClient, getTasks, runCommand, type Tool } from "./api";
import type { View, ViewContext } from "./views/types";

// Each view is loaded only when it is the one chosen. A view's stylesheet comes with
// its module, and stylesheets are global: loading two views would let one restyle the
// other. The first entry is the default.
const VIEWS: Record<string, () => Promise<View>> = {
  dartboard: () => import("./views/dartboard").then(m => m.dartboard),
  dartboard2: () => import("./views/dartboard2").then(m => m.dartboard2),
};

/** A context whose dispatch refuses anything outside the view's affordances. */
function contextFor(view: View): ViewContext {
  return {
    tasks: getTasks,
    drafts: draftClient(`web:${view.id}`),
    dispatch(tool: Tool, args, opts) {
      if (!view.affordances.includes(tool)) {
        return Promise.reject(new Error(`${view.id} has no ${tool} affordance`));
      }
      return runCommand(tool, args, { actorId: `web:${view.id}`, ...opts });
    },
  };
}

const requested = new URLSearchParams(location.search).get("view") ?? "";
const load = Object.hasOwn(VIEWS, requested) ? VIEWS[requested] : Object.values(VIEWS)[0];
void load().then(view => {
  document.title = `misty · ${view.name}`;
  view.mount(document.getElementById("app")!, contextFor(view));
});
