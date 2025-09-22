import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ContentBlock,
  SessionNotification,
  TerminalHandle, // Import TerminalHandle from ACP
  TerminalOutputResponse,
} from "@zed-industries/agent-client-protocol";

// Define StopReason locally as it's not exported as a type from the ACP protocol library
type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

import {
  AssistantMessage,
  UserMessage,
  Part,
  TextPartInput,
  FilePartInput,
  createOpencodeClient,
  EventMessagePartUpdated,
  EventMessageUpdated,
} from "@opencode-ai/sdk";
import { nodeToWebReadable, nodeToWebWritable, Pushable } from "./utils.js";

// Use the imported TerminalHandle type
type BackgroundTerminal = {
  handle: TerminalHandle;
  lastOutput: TerminalOutputResponse | null;
  status: "started" | "aborted" | "exited" | "killed" | "timedOut";
  pendingOutput?: TerminalOutputResponse;
};

// Define local enums for ToolCallStatus and ToolKind based on ACP schema
enum ToolCallStatus {
  Pending = "pending",
  InProgress = "in_progress",
  Completed = "completed",
  Failed = "failed",
}

enum ToolKind {
  Read = "read",
  Edit = "edit",
  Delete = "delete",
  Move = "move",
  Search = "search",
  Execute = "execute",
  Think = "think",
  Fetch = "fetch",
  SwitchMode = "switch_mode",
  Other = "other",
}

type Session = {
  input: Pushable<UserMessage>;
  cancelled: boolean;
  permissionMode: string;
  opencodeClient: ReturnType<typeof createOpencodeClient>;
  messageUpdateResolver?: (message: AssistantMessage) => void;
  lastSentTextByMessagePartId: Map<string, string>; // Add this to store the last sent text for delta calculation
};

// Implement the ACP Agent interface
export class OpenCodeAcpAgent implements Agent {
  sessions: {
    [key: string]: Session;
  };
  client: AgentSideConnection;
  opencodeClient: ReturnType<typeof createOpencodeClient>;
  clientCapabilities?: ClientCapabilities;
  backgroundTerminals: { [id: string]: BackgroundTerminal }; // Add this line

  constructor(client: AgentSideConnection, baseUrl: string) {
    this.sessions = {};
    this.client = client;
    this.opencodeClient = createOpencodeClient({
      baseUrl: baseUrl,
    });
    this.backgroundTerminals = {}; // Initialize backgroundTerminals

    this.setupEventHandlers();
  }

  private async setupEventHandlers() {
    console.error(`[setupEventHandlers] Subscribing to OpenCode events.`);
    const events = await this.opencodeClient.event.subscribe();
    console.error(`[setupEventHandlers] Event stream started.`);
    for await (const event of events.stream) {
      console.error(`[setupEventHandlers] Received event: ${event.type}`);
      if (event.type === 'message.part.updated') {
        const partUpdatedEvent = event as EventMessagePartUpdated; // Explicitly cast the event
        const { part } = partUpdatedEvent.properties; // Get the part object
        const sessionID = part.sessionID; // Extract sessionID from the part object
        
        console.error(`[setupEventHandlers] Processing message.part.updated for sessionID: ${sessionID}, partID: ${part.id}, type: ${part.type}`);

        // Simplified echo filter: if part.type is 'text' and has no 'time' property, it's an echo of user input.
        if (part.type === 'text' && !part.time) {
            console.error(`[ECHO FILTER]: Dropping echo of user input (text part with no timestamp) for sessionID: ${sessionID}, partID: ${part.id}`);
            continue; // Skip this echo
        }

        if (!sessionID || !part) {
          console.warn(`[Event Handler] Missing sessionID or part in message.part.updated event properties: ${JSON.stringify(partUpdatedEvent.properties)}`);
          continue; // Skip this malformed event
        }

        const session = this.sessions[sessionID];
        if (session) {
          // Implement Delta Calculation for Text Parts
          if (part.type === 'text') {
            const currentText = part.text;
            const previousText = session.lastSentTextByMessagePartId.get(part.id) || '';
            const deltaText = currentText.substring(previousText.length);
            
            session.lastSentTextByMessagePartId.set(part.id, currentText);

            if (deltaText.length > 0) {
              await this.client.sessionUpdate({
                sessionId: sessionID,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: deltaText }
                }
              });
              console.error(`[setupEventHandlers] Sent agent_message_chunk delta for part ${part.id}`);
            }
            continue; // Skip further processing for this text part, as its delta has been handled.
          }

          // Implement Delta Calculation for Reasoning Parts
          if (part.type === 'reasoning') {
            const currentText = part.text;
            const previousText = session.lastSentTextByMessagePartId.get(part.id) || '';
            const deltaText = currentText.substring(previousText.length);
            session.lastSentTextByMessagePartId.set(part.id, currentText);

            if (deltaText.length > 0) {
              await this.client.sessionUpdate({
                sessionId: sessionID,
                update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: deltaText } }
              });
              console.error(`[setupEventHandlers] Sent agent_thought_chunk delta for part ${part.id}`);
            }
            continue; // Skip further processing for this reasoning part, as its delta has been handled.
          }

          // Handle tool parts with permission requests
          if (part.type === 'tool' && part.state.status === 'pending') {
            const { callID, tool } = part;
            const toolDescription = `Allow agent to run tool: ${tool}?`;
            
            let permissionGranted = false;
            if (session.permissionMode === "bypassPermissions" || session.permissionMode === "acceptEdits") {
              permissionGranted = true;
            } else if (session.permissionMode === "plan") {
              await this.client.sessionUpdate({
                sessionId: sessionID,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: callID,
                  status: ToolCallStatus.Failed,
                  content: [{ type: "content", content: { type: "text", text: `Tool execution blocked in Plan Mode.` } }],
                },
              });
              continue; // Skip further processing for this tool
            } else { // "default" mode - Always Ask
              await this.client.sessionUpdate({
                sessionId: sessionID,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: callID,
                  title: tool,
                  status: ToolCallStatus.Pending,
                  kind: mapToolKind(tool),
                },
              });

              const permissionResponse = await this.client.requestPermission({
                sessionId: sessionID,
                toolCall: {
                  toolCallId: callID,
                  title: toolDescription,
                },
                options: [
                  { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
                  { optionId: "reject_once", name: "Deny", kind: "reject_once" },
                ],
              });

              if (permissionResponse.outcome.outcome !== "selected" || permissionResponse.outcome.optionId !== "allow_once") {
                await this.client.sessionUpdate({
                  sessionId: sessionID,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: callID,
                    status: ToolCallStatus.Failed,
                    content: [{ type: "content", content: { type: "text", text: `Permission for tool '${tool}' denied.` } }],
                  },
                });
                continue; // Skip further processing for this tool
              }
            }

            if (permissionGranted) {
              // If permission is granted (or automatically accepted), then send the tool_call notification.
              // Note: The tool_call notification for pending status is already sent above if permissionMode is "default".
              // For other modes, we need to send it here.
              if (session.permissionMode !== "default") {
                await this.client.sessionUpdate({
                  sessionId: sessionID,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: callID,
                    title: tool,
                    status: ToolCallStatus.Pending,
                    kind: mapToolKind(tool),
                  },
                });
              }
            }
          }

          // Ensure Other Part Types are Handled or remaining tool parts
          const notifications = toAcpNotifications(
            {} as AssistantMessage, // Placeholder, as full message info is not in part update
            part,
            sessionID
          );
          for (const notification of notifications) {
            await this.client.sessionUpdate(notification);
            // console.error(`[setupEventHandlers] Sent notification for part ${part.id}, type: ${part.type}`); // Removed to prevent parsing errors
          }
        }
      } else if (event.type === 'message.updated') {
        const messageUpdatedEvent = event as EventMessageUpdated;
        const { info: messageInfo } = messageUpdatedEvent.properties;
        const session = this.sessions[messageInfo.sessionID];
        if (session && session.messageUpdateResolver) {
          session.messageUpdateResolver(messageInfo as AssistantMessage);
        }
      }
    }
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: false,
        },
        loadSession: false,
      },
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    console.error(`[newSession] CWD received: ${params.cwd}`);
    const { data: sessionData, error: sessionError } = await this.opencodeClient.session.create({
      query: { directory: params.cwd },
      body: {}, // Add empty body
    });

    if (sessionError || !sessionData) {
      const errorDetails = sessionError ? JSON.stringify(sessionError) : 'undefined response';
      throw new Error(`Failed to create opencode session: ${errorDetails}`);
    }
    const sessionId = sessionData.id;
    const input = new Pushable<UserMessage>();

    this.sessions[sessionId] = {
      input: input,
      cancelled: false,
      permissionMode: "default",
      opencodeClient: this.opencodeClient,
      lastSentTextByMessagePartId: new Map<string, string>(), // Initialize the map
    };

    // Since getAvailableSlashCommands is commented out, we send an empty array.
    // If it were active, we would call it here.
    this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      },
    });

    console.error(`[newSession] Created session ID: ${sessionId}`);
    console.error(`[newSession] Returning modes for session ID: ${sessionId}`);

    // Align with the expected modes from the user's example
    return {
      sessionId,
      modes: {
        currentModeId: "default",
        availableModes: [
          {
            id: "default",
            name: "Always Ask",
            description: "Prompts for permission on first use of each tool",
          },
          {
            id: "acceptEdits",
            name: "Accept Edits",
            description: "Automatically accepts file edit permissions for the session",
          },
          {
            id: "bypassPermissions",
            name: "Bypass Permissions",
            description: "Skips all permission prompts",
          },
          {
            id: "plan",
            name: "Plan Mode",
            description: "Claude can analyze but not modify files or execute commands",
          },
        ],
      },
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    throw new Error("Method not implemented.");
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    console.error(`[prompt] Received prompt for session ID: ${params.sessionId}`);

    if (!this.sessions[params.sessionId]) {
      console.error(`[prompt] Error: Session not found for ID: ${params.sessionId}`);
      throw new Error("Session not found");
    }

    this.sessions[params.sessionId].cancelled = false;

    const session = this.sessions[params.sessionId];
    const opencodeClient = session.opencodeClient;

    // Convert ACP prompt to Opencode prompt parts
    const opencodePromptParts: (TextPartInput | FilePartInput)[] = params.prompt.map((part: ContentBlock) => {
      switch (part.type) {
        case "text":
          return { type: "text", text: part.text };
        case "resource_link":
          return { type: "text", text: `Resource Link: ${part.uri} (${part.name})` };
        case "resource":
          if ("text" in part.resource) {
            return { type: "text", text: part.resource.text };
          }
          return { type: "text", text: `Binary Resource: ${part.resource.uri}` };
        case "image":
          return {
            type: "file",
            mime: part.mimeType,
            url: part.uri || `data:${part.mimeType};base64,${part.data}`,
          };
        case "audio":
          return {
            type: "file",
            mime: part.mimeType,
            url: `data:${part.mimeType};base64,${part.data}`,
          };
        default:
          return { type: "text", text: `Unsupported content type: ${(part as any).type}` };
      }
    });

    // Send the prompt to the Opencode server
    console.error(`[prompt] Sending prompt to Opencode server for session ID: ${params.sessionId}`);
    const { data: promptData, error: promptError } = await opencodeClient.session.prompt({
      path: { id: params.sessionId },
      body: {
        parts: opencodePromptParts,
      },
    });

    if (promptError) {
      console.error("Opencode prompt returned an error:", promptError);
      throw promptError;
    }

    if (!promptData) {
      console.error("Opencode prompt returned an unexpected empty response");
      throw new Error("Unexpected empty response from Opencode prompt.");
    }

    // Determine the stop reason based on the final message information received directly from the prompt call
    let stopReason: StopReason = "end_turn";
    if (promptData.info.error) {
        // If there's an error in the final message info, it's either cancelled or a refusal
        if (promptData.info.error.name === "MessageAbortedError") {
            stopReason = "cancelled";
        } else {
            stopReason = "refusal";
        }
    }
    // Other stop reasons like max_tokens, max_turn_requests are not directly available
    // from AssistantMessage, so default to end_turn if no error.

    console.error(`[prompt] Returning stopReason: ${stopReason} for session ID: ${params.sessionId}`);
    return { stopReason };
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    this.sessions[params.sessionId].cancelled = true;
    await this.sessions[params.sessionId].opencodeClient.session.abort({ path: { id: params.sessionId } });
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    switch (params.modeId) {
      case "default":
      case "acceptEdits":
      case "plan":
      case "bypassPermissions":
        this.sessions[params.sessionId].permissionMode = params.modeId;
        return {};
      default:
        throw new Error("Invalid mode");
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.client.readTextFile(params);
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.client.writeTextFile(params);
  }
}

// async function getAvailableSlashCommands(opencodeClient: ReturnType<typeof createOpencodeClient>): Promise<AvailableCommand[]> {
//   const UNSUPPORTED_COMMANDS = [
//     "add-dir", "agents", "bashes", "bug", "clear", "config", "context", "cost",
//     "doctor", "exit", "export", "help", "hooks", "ide", "install-github-app",
//     "login", "logout", "memory", "mcp", "migrate-installer", "output-style",
//     "output-style:new", "permissions", "privacy-settings", "release-notes",
//     "resume", "status", "statusline", "terminal-setup", "todos", "vim",
//     "run", "serve", "upgrade",
//   ];
// 
//   try {
//     const response = await opencodeClient.command.list();
//     if (!response.data) {
//       return [];
//     }
//     return response.data
//       .map((command: any) => ({
//         name: command.name,
//         description: command.description || "",
//         input: command.inputHint ? { hint: command.inputHint } : null,
//       }))
//       .filter((command: AvailableCommand) =>
//         !(command.name.match(/\(MCP\)/) || UNSUPPORTED_COMMANDS.includes(command.name))
//       );
//   } catch (error) {
//     console.error("Error fetching available commands from Opencode SDK:", error);
//     return [];
//   }
// }

export function toAcpNotifications(
  // messageInfo is now primarily for error handling, or specific message-level properties
  messageInfo: AssistantMessage,
  messagePart: Part,
  sessionId: string,
): SessionNotification[] {
  const output: SessionNotification[] = [];

  let update: SessionNotification["update"] | null = null;
  switch (messagePart.type) {
    case "text":
      // For streaming, text parts are typically chunks
      update = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: messagePart.text },
      };
      break;
    case "tool": {
      // Tool parts can represent calls, updates, completion, or errors
      const { state, callID, tool } = messagePart;
      if (state.status === "pending") {
        update = {
          sessionUpdate: "tool_call",
          toolCallId: callID,
          title: tool,
          status: ToolCallStatus.Pending,
          kind: mapToolKind(tool),
        };
      } else if (state.status === "running") {
        update = {
          sessionUpdate: "tool_call_update",
          toolCallId: callID,
          title: state.title || tool,
          status: ToolCallStatus.InProgress,
          content: [{ type: "content", content: { type: "text", text: `Tool input: ${JSON.stringify(state.input || {})}` } }],
        };
      } else if (state.status === "completed") {
        update = {
          sessionUpdate: "tool_call_update",
          toolCallId: callID,
          status: ToolCallStatus.Completed,
          content: [{ type: "content", content: { type: "text", text: JSON.stringify(state.output) } }],
        };
      } else if (state.status === "error") {
        update = {
          sessionUpdate: "tool_call_update",
          toolCallId: callID,
          status: ToolCallStatus.Failed,
          content: [{ type: "content", content: { type: "text", text: JSON.stringify(state.error) } }],
        };
      }
      break;
    }
    case "file":
      // Files are typically sent as part of the message content
      update = {
        sessionUpdate: "agent_message_chunk", // Or a more specific "file" update if ACP supported it
        content: messagePart.mime.startsWith("image/")
          ? { type: "image", mimeType: messagePart.mime, uri: messagePart.url, data: "" }
          : { type: "text", text: `File: ${messagePart.filename || messagePart.url} (${messagePart.mime})` },
      };
      break;
    case "reasoning":
      update = {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: messagePart.text },
      };
      break;
    case "patch":
      update = {
        sessionUpdate: "tool_call", // Or tool_call_update if it's an update to an existing one
        toolCallId: `patch-${messagePart.hash}`, // Generate a unique ID
        title: `Applying patch to ${messagePart.files.join(", ")}`,
        status: ToolCallStatus.Completed, // Patch is usually completed upon receipt
        kind: ToolKind.Edit,
        content: [
          {
            type: "content",
            content: { type: "text", text: `Patch applied with hash: ${messagePart.hash}` },
          },
        ],
      };
      break;
    case "snapshot":
    case "agent":
    case "step-start":
    case "step-finish":
      // These types are internal to OpenCode or handled by message.updated events
      // console.log(`Ignoring '${messagePart.type}' part from Opencode SDK event.`); // Removed to prevent parsing errors
      break;
    default: {
      const unknownPart = messagePart as any;
      console.warn(`Unhandled OpenCode message part type from event: ${unknownPart.type}`);
      break;
    }
  }

  if (update) {
    output.push({ sessionId, update });
  }

  // Handle message-level errors if present
  if (messageInfo && messageInfo.error) {
    const error = messageInfo.error as any;
    output.push({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Error from OpenCode: ${error.name} - ${error.message || JSON.stringify(error.data)}`,
        },
      },
    });
  }

  return output;
}

function mapToolKind(toolName: string): ToolKind {
  if (toolName.startsWith("read")) return ToolKind.Read;
  if (toolName.startsWith("write") || toolName.startsWith("edit") || toolName.startsWith("apply") || toolName.startsWith("insert")) return ToolKind.Edit;
  if (toolName.startsWith("execute")) return ToolKind.Execute;
  if (toolName.startsWith("search") || toolName.startsWith("list")) return ToolKind.Search;
  if (toolName.startsWith("browser")) return ToolKind.Fetch;
  if (toolName.startsWith("update") || toolName.startsWith("ask") || toolName.startsWith("new_task")) return ToolKind.Think;
  if (toolName.startsWith("switch")) return ToolKind.SwitchMode;
  return ToolKind.Other;
}

export function runAcp(baseUrl: string) {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);

  new AgentSideConnection(
    (client) => new OpenCodeAcpAgent(client, baseUrl),
    stream
  );
}
