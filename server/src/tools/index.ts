import type { Tool } from "./ToolRegistry.js";
import { readFileTool, writeFileTool, editFileTool, listDirectoryTool, searchFilesTool } from "./fsTools.js";
import { executeCommandTool, gitTools } from "./execTools.js";

/** The default toolset exposed to the model. */
export function createDefaultTools(): Tool[] {
  return [
    readFileTool,
    listDirectoryTool,
    searchFilesTool,
    writeFileTool,
    editFileTool,
    executeCommandTool,
    ...gitTools,
  ];
}

export * from "./ToolRegistry.js";
