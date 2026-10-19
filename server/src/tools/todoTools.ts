import type { Tool } from "./ToolRegistry.js";
import { TodoStore } from "../agent/RunState.js";

const STATUSES = ["pending", "in_progress", "completed"] as const;

function schema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required } as const;
}

/**
 * todo_write — the model's task list. Sends the FULL list each time (like
 * Claude Code's TodoWrite): items with content + status. The UI renders it
 * as a live progress checklist and the system prompt instructs the model to
 * keep it updated while working through multi-step tasks.
 */
export const todoWriteTool: Tool = {
  name: "todo_write",
  description:
    "Write your task list (replaces the previous list entirely). Use for any task with 2+ steps: " +
    "first plan all steps as pending items, mark one item in_progress before starting it, and " +
    "mark items completed as soon as they are done. Keep statuses accurate at all times.",
  permission: "auto",
  parameters: schema(
    {
      todos: {
        type: "array",
        description: "The complete todo list (replaces the previous one)",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Short imperative description of the step" },
            status: { type: "string", enum: [...STATUSES], description: "pending | in_progress | completed" },
          },
          required: ["content", "status"],
        },
      },
    },
    ["todos"],
  ),
  async execute(args, ctx) {
    const raw = (args.todos ?? []) as unknown;
    if (!Array.isArray(raw)) return "Error: todos must be an array of {content, status}.";

    const items: { content: string; status: (typeof STATUSES)[number] }[] = [];
    for (const t of raw) {
      const obj = t as Record<string, unknown>;
      const content = typeof obj.content === "string" ? obj.content.trim() : "";
      const status = STATUSES.includes(obj.status as (typeof STATUSES)[number])
        ? (obj.status as (typeof STATUSES)[number])
        : "pending";
      if (content) items.push({ content: content.slice(0, 200), status });
    }
    if (items.length === 0) return "Error: todos must contain at least one item with content.";
    if (items.length > 50) return "Error: too many todos (max 50).";

    const saved = TodoStore.set(items);
    const done = saved.filter((t) => t.status === "completed").length;
    // Broadcast to the UI (ToolContext.emit is wired by the AgentLoop).
    ctx.emit?.({ type: "todos.updated", todos: saved });
    return `Todo list updated: ${done}/${saved.length} completed.`;
  },
};
