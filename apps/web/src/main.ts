import { getTasks, runCommand, type Tool } from "./api";
import type { View, ViewContext } from "./views/types";
import { dartboard } from "./views/dartboard";

const VIEWS: View[] = [dartboard];

/** A context whose dispatch refuses anything outside the view's affordances. */
function contextFor(view: View): ViewContext {
  return {
    tasks: getTasks,
    dispatch(tool: Tool, args, opts) {
      if (!view.affordances.includes(tool)) {
        return Promise.reject(new Error(`${view.id} has no ${tool} affordance`));
      }
      return runCommand(tool, args, { actorId: `web:${view.id}`, ...opts });
    },
  };
}

const requested = new URLSearchParams(location.search).get("view");
const view = VIEWS.find(v => v.id === requested) ?? VIEWS[0];
document.title = `misty · ${view.name}`;
view.mount(document.getElementById("app")!, contextFor(view));
