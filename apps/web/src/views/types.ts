import type { DraftClient, Edit, Task, Tool } from "../api";

/**
 * A visualisation of the task database. Views read every task, but may only
 * write through the edits listed in `affordances`. All writes go through the
 * server's command endpoint, the same path the agent's tools use.
 */
export interface View<A extends readonly Tool[] = readonly Tool[]> {
  id: string;
  name: string;
  /** Which way of relating to tasks this view is built for. */
  profile: string;
  affordances: A;
  /** Render into `el`. Returns a function that tears the view down. */
  mount(el: HTMLElement, ctx: ViewContext<A[number]>): () => void;
}

export interface ViewContext<T extends Tool = Tool> {
  tasks(): Promise<{ head_seq: number; tasks: Task[] }>;
  /** Run one of this view's affordances. Rejects with CommandRejected. */
  dispatch(tool: T, args: Record<string, unknown>, opts?: { correlationId?: string }): Promise<Edit>;
  /**
   * Reorganisations (ADR 0003): describe them in the view's own vocabulary and let a
   * translator turn them into edits once they settle. Drafts are tagged with the view.
   */
  drafts: DraftClient;
}
