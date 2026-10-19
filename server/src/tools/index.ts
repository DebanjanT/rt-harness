import type { Tool } from "./ToolRegistry.js";
import { readFileTool, writeFileTool, editFileTool, listDirectoryTool, searchFilesTool } from "./fsTools.js";
import { executeCommandTool, gitTools } from "./execTools.js";
import { webSearchTool, fetchUrlTool } from "./webTools.js";
import { mkdirTool, deleteFileTool, moveFileTool, workspaceInfoTool } from "./workspaceTools.js";
import { askUserTool } from "./askUserTool.js";
import { todoWriteTool } from "./todoTools.js";

/** The default toolset exposed to the model. */
export function createDefaultTools(): Tool[] {
  return [
    readFileTool,
    listDirectoryTool,
    searchFilesTool,
    writeFileTool,
    editFileTool,
    executeCommandTool,
    mkdirTool,
    deleteFileTool,
    moveFileTool,
    workspaceInfoTool,
    webSearchTool,
    fetchUrlTool,
    ...gitTools,
    askUserTool,
    todoWriteTool,
  ];
}

export * from "./ToolRegistry.js";
