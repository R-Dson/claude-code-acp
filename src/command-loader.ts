import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AvailableCommand } from "@zed-industries/agent-client-protocol";

// Helper function to parse frontmatter from markdown
function parseFrontmatter(content: string): { [key: string]: string } {
  const frontmatter: { [key: string]: string } = {};
  const match = content.match(/^---\s*([\s\S]*?)\s*---/);
  if (match) {
    const frontmatterStr = match[1];
    const lines = frontmatterStr.split("\n");
    for (const line of lines) {
      const parts = line.split(":");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join(":").trim();
        if (key && value) {
          frontmatter[key] = value;
        }
      }
    }
  }
  return frontmatter;
}

export async function loadAvailableCommands(cwd: string): Promise<AvailableCommand[]> {
  const builtInCommands: AvailableCommand[] = [
    {
      name: "compact",
      description: "Compact the current session.",
      input: { hint: "<optional custom summarization instructions>" },
    },
    {
      name: "summarize",
      description: "Alias for /compact",
      input: { hint: "<optional custom summarization instructions>" },
    },
    { name: "help", description: "Show the help dialog.", input: null },
    { name: "init", description: "Create or update AGENTS.md file.", input: null },
    { name: "models", description: "List available models.", input: null },
    { name: "redo", description: "Redo a previously undone message.", input: null },
    { name: "undo", description: "Undo last message in the conversation.", input: null },
    { name: "share", description: "Share current session.", input: null },
    { name: "unshare", description: "Unshare current session.", input: null },

    // not implemented or disabled commands
    // { name: "new", description: "Start a new session. Alias: /clear", input: null },
    // { name: "clear", description: "Alias for /new", input: null },
    // { name: "sessions", description: "List and switch between sessions. Aliases: /resume, /continue (not implemented)", input: null },
    // { name: "resume", description: "Alias for /sessions (not implemented)", input: null },
    // { name: "continue", description: "Alias for /sessions (not implemented)", input: null },
    // { name: "themes", description: "List available themes. (not implemented)", input: null },
    // { name: "details", description: "Toggle tool execution details. (not implemented)", input: null },
    // { name: "editor", description: "Open external editor for composing messages. (not implemented)", input: null },
    // { name: "exit", description: "Exit opencode. Aliases: /quit, /q (not implemented)", input: null },
    // { name: "quit", description: "Alias for /exit (not implemented)", input: null },
    // { name: "q", description: "Alias for /exit (not implemented)", input: null },
    // { name: "export", description: "Export current conversation to Markdown and open in your default editor. (not implemented)", input: null },
  ];

  const customCommands: AvailableCommand[] = [];
  const customCommandNames = new Set<string>();

  // 1. Load from opencode.json
  const configPath = path.join(cwd, "opencode.json");
  try {
    const configContent = await fs.readFile(configPath, "utf-8");
    // Strip comments from JSONC
    const json = configContent.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) =>
      g ? "" : m,
    );
    const config = JSON.parse(json);

    interface CommandDetails {
      description?: string;
      template?: string;
    }

    if (config.command) {
      for (const [name, unknownDetails] of Object.entries(config.command)) {
        const details = unknownDetails as CommandDetails;
        if (!customCommandNames.has(name)) {
          customCommands.push({
            name: name,
            description: details.description || "",
            input: details.template?.includes("$ARGUMENTS") ? { hint: "arguments" } : null,
          });
          customCommandNames.add(name);
        }
      }
    }
  } catch (error) {
    if ((error as any).code !== "ENOENT") {
      console.error("Error reading opencode.json:", error);
    }
  }

  // 2. Load from .opencode/command/*.md
  const projectCommandDir = path.join(cwd, ".opencode", "command");
  try {
    const files = await fs.readdir(projectCommandDir);
    for (const file of files) {
      if (file.endsWith(".md")) {
        const commandName = path.basename(file, ".md");
        if (!customCommandNames.has(commandName)) {
          const filePath = path.join(projectCommandDir, file);
          const content = await fs.readFile(filePath, "utf-8");
          const frontmatter = parseFrontmatter(content);
          const template = content.replace(/^---[\s\S]*?---/, "").trim();

          customCommands.push({
            name: commandName,
            description: frontmatter.description || "",
            input: template.includes("$ARGUMENTS") ? { hint: "arguments" } : null,
          });
          customCommandNames.add(commandName);
        }
      }
    }
  } catch (error) {
    if ((error as any).code !== "ENOENT") {
      console.error("Error reading project command directory:", error);
    }
  }

  // Merge built-in and custom commands, with custom commands overriding built-in ones.
  const finalCommands = [
    ...builtInCommands.filter((c) => !customCommandNames.has(c.name)),
    ...customCommands,
  ];

  return finalCommands;
}
