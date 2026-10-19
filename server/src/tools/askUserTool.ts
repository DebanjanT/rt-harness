import type { Tool } from "./ToolRegistry.js";

/**
 * ask_user — the model asks the user a clarification question with options.
 * Renders as an interactive card in the chat; resolves with the chosen option.
 * This closes the loop on ambiguity instead of the model guessing.
 */
export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "Ask the user a clarifying question with fixed answer options when the task is genuinely ambiguous (e.g. which of two conflicting approaches, which framework version, whether to overwrite). Use sparingly — prefer making reasonable assumptions for trivial ambiguity. The user sees the question as an interactive card and picks one option.",
  permission: "auto",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user" },
      options: {
        type: "array",
        items: { type: "string" },
        description: "2–5 concrete answer options the user can pick from",
      },
    },
    required: ["question", "options"],
  },
  async execute(args, ctx) {
    const question = String(args.question ?? "").trim();
    const options = Array.isArray(args.options)
      ? args.options.map((o) => String(o)).filter(Boolean).slice(0, 5)
      : [];

    if (!question) return "Error: empty question.";
    if (options.length < 2) {
      return "Error: provide at least 2 options so the user can answer with one click.";
    }

    if (!ctx.requestUserInput) {
      // Shouldn't happen (AgentLoop always wires it), but degrade gracefully.
      return `Error: user input unavailable right now. Defaulting to the first option: "${options[0]}".`;
    }

    const answer = await ctx.requestUserInput({ tool: "ask_user", question, options });
    if (answer === "__cancelled__") {
      return "User dismissed the question. Proceed with your best judgment and state your assumption.";
    }
    return `User answered: "${answer}"`;
  },
};
