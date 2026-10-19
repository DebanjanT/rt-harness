import type OpenAI from "openai";

export interface ToolContext {
  /** Emit a file.changed event to the UI. */
  onFileChanged?: (path: string) => void;
  autoApprove: boolean;
  /** Request user approval; resolves with the user's decision. */
  requestApproval: (req: {
    kind: "command" | "file_write";
    tool: string;
    summary: string;
    data: Record<string, unknown>;
    diff?: string;
  }) => Promise<boolean>;
  /**
   * Ask the user a multiple-choice question (ask_user tool). Resolves with
   * the chosen option text.
   */
  requestUserInput?: (req: {
    tool: string;
    question: string;
    options: string[];
  }) => Promise<string>;
  /** Emit a protocol event to the client (todos.updated etc). */
  emit?: (event: unknown) => void;
  /** AbortSignal tied to the current chat session. */
  signal: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** "auto" runs without approval, "approval" asks the user first. */
  permission: "auto" | "approval";
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

function schema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required } as const;
}

/** Convert a Tool registry into OpenAI tool schemas. */
export function toOpenAITools(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
