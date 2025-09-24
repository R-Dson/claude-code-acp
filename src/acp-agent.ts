import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
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
  TerminalOutputResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalCommandRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
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
import { loadAvailableCommands } from "./command-loader.js";

type BackgroundTerminal = {
  shellId: string;
  output: string;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
  status: "started" | "aborted" | "exited" | "killed" | "timedOut";
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

// Define PlanEntry types for structured plan updates
enum PlanEntryPriority {
  High = "high",
  Medium = "medium",
  Low = "low",
}

enum PlanEntryStatus {
  Pending = "pending",
  InProgress = "in_progress",
  Completed = "completed",
}

type PlanEntry = {
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
};


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
      if (event.type === "message.part.updated") {
        const partUpdatedEvent = event as EventMessagePartUpdated; // Explicitly cast the event
        const { part } = partUpdatedEvent.properties; // Get the part object
        const sessionID = part.sessionID; // Extract sessionID from the part object

        console.error(
          `[setupEventHandlers] Processing message.part.updated for sessionID: ${sessionID}, partID: ${part.id}, type: ${part.type}`,
        );

        // Simplified echo filter: if part.type is 'text' and has no 'time' property, it's an echo of user input.
        if (part.type === "text" && !part.time) {
          console.error(
            `[ECHO FILTER]: Dropping echo of user input (text part with no timestamp) for sessionID: ${sessionID}, partID: ${part.id}`,
          );
          continue; // Skip this echo
        }

        if (!sessionID || !part) {
          console.warn(
            `[Event Handler] Missing sessionID or part in message.part.updated event properties: ${JSON.stringify(partUpdatedEvent.properties)}`,
          );
          continue; // Skip this malformed event
        }

        const session = this.sessions[sessionID];
        if (session) {
          // Implement Delta Calculation for Text Parts
          if (part.type === "text") {
            const currentText = part.text;
            const previousText = session.lastSentTextByMessagePartId.get(part.id) || "";
            const deltaText = currentText.substring(previousText.length);

            session.lastSentTextByMessagePartId.set(part.id, currentText);

            if (deltaText.length > 0) {
              await this.client.sessionUpdate({
                sessionId: sessionID,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: deltaText },
                },
              });
              console.error(
                `[setupEventHandlers] Sent agent_message_chunk delta for part ${part.id}`,
              );
            }
            continue; // Skip further processing for this text part, as its delta has been handled.
          }

          // Implement Delta Calculation for Reasoning Parts
          if (part.type === "reasoning") {
            const currentText = part.text;
            const previousText = session.lastSentTextByMessagePartId.get(part.id) || "";
            const deltaText = currentText.substring(previousText.length);
            session.lastSentTextByMessagePartId.set(part.id, currentText);

            if (deltaText.length > 0) {
              await this.client.sessionUpdate({
                sessionId: sessionID,
                update: {
                  sessionUpdate: "agent_thought_chunk",
                  content: { type: "text", text: deltaText },
                },
              });
              console.error(
                `[setupEventHandlers] Sent agent_thought_chunk delta for part ${part.id}`,
              );
            }
            continue; // Skip further processing for this reasoning part, as its delta has been handled.
          }

          // Handle tool parts with permission requests
          if (part.type === "tool" && part.state.status === "pending") {
            const { callID, tool } = part;
            const toolDescription = `Allow agent to run tool: ${tool}?`;

            let permissionGranted = false;
            if (
              session.permissionMode === "bypassPermissions" ||
              session.permissionMode === "acceptEdits"
            ) {
              permissionGranted = true;
            } else if (session.permissionMode === "plan") {
              await this.client.sessionUpdate({
                sessionId: sessionID,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: callID,
                  status: ToolCallStatus.Failed,
                  content: [
                    {
                      type: "content",
                      content: { type: "text", text: `Tool execution blocked in Plan Mode.` },
                    },
                  ],
                },
              });
              continue; // Skip further processing for this tool
            } else {
              // "default" mode - Always Ask
              await this.client.sessionUpdate({
                sessionId: sessionID,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: callID,
                  title: tool,
                  status: ToolCallStatus.Pending,
                  kind: mapToolKind(tool),
                  content: (part as any).content || [],
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

              if (
                permissionResponse.outcome.outcome !== "selected" ||
                permissionResponse.outcome.optionId !== "allow_once"
              ) {
                await this.client.sessionUpdate({
                  sessionId: sessionID,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: callID,
                    status: ToolCallStatus.Failed,
                    content: [
                      {
                        type: "content",
                        content: { type: "text", text: `Permission for tool '${tool}' denied.` },
                      },
                    ],
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
                    content: (part as any).content || [],
                  },
                });
              }
            }
          }

          // Ensure Other Part Types are Handled or remaining tool parts
          const notifications = toAcpNotifications(
            {} as AssistantMessage, // Placeholder, as full message info is not in part update
            part,
            sessionID,
          );
          for (const notification of notifications) {
            await this.client.sessionUpdate(notification);
            // console.error(`[setupEventHandlers] Sent notification for part ${part.id}, type: ${part.type}`); // Removed to prevent parsing errors
          }
        }
      } else if (event.type === "message.updated") {
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
        loadSession: true,
        _meta: {
          "opencode.dev": {
            "slashCommands": true,
            "extensible": true,
          },
        },
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
      const errorDetails = sessionError ? JSON.stringify(sessionError) : "undefined response";
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

    // Fetch and send available slash commands
    // Add a delay to allow the server to initialize before fetching commands
    setTimeout(async () => {
      const availableCommands = await loadAvailableCommands(params.cwd);
      this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands,
        },
      });
    }, 250);

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

    // Check for slash commands
    const firstPart = params.prompt[0];
    if (firstPart && firstPart.type === 'text' && firstPart.text.startsWith('/')) {
      const [command, ...args] = firstPart.text.substring(1).split(' ');
      const handled = await this.handleCommand(params.sessionId, command, args.join(' '));
      if (handled) {
        return { stopReason: "end_turn" };
      }
    }

    // Convert ACP prompt to Opencode prompt parts
    const opencodePromptParts: (TextPartInput | FilePartInput)[] = params.prompt.map(
      (part: ContentBlock) => {
        switch (part.type) {
          case "text":
            return { type: "text", text: part.text };
          case "resource_link": {
            let linkText = `Resource Link: ${part.name} (${part.uri})`;
            if (part.description) {
              linkText += ` - ${part.description}`;
            }
            if (part.size) {
              linkText += ` [${part.size} bytes]`;
            }
            return { type: "text", text: linkText };
          }
          case "resource":
            if ("text" in part.resource) {
              return { type: "text", text: `Resource ${part.resource.uri}: ${part.resource.text}` };
            }
            return {
              type: "text",
              text: `Binary Resource: ${part.resource.uri} (MIME: ${part.resource.mimeType || "unknown"})`,
            };
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
      },
    );

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

    console.error(
      `[prompt] Returning stopReason: ${stopReason} for session ID: ${params.sessionId}`,
    );
    return { stopReason };
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    this.sessions[params.sessionId].cancelled = true;
    await this.sessions[params.sessionId].opencodeClient.session.abort({
      path: { id: params.sessionId },
    });
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

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    // Verify the session exists
    const { data: sessionData, error: sessionError } = await this.opencodeClient.session.get({
      path: { id: params.sessionId },
    });

    if (sessionError || !sessionData) {
      const errorDetails = sessionError ? JSON.stringify(sessionError) : "undefined response";
      throw new Error(`Failed to verify opencode session: ${errorDetails}`);
    }

    // Create and store a new Session object
    const input = new Pushable<UserMessage>();
    this.sessions[params.sessionId] = {
      input: input,
      cancelled: false,
      permissionMode: "default",
      opencodeClient: this.opencodeClient,
      lastSentTextByMessagePartId: new Map<string, string>(), // Initialize the map
    };

    // Fetch the conversation history
    const { data: messagesData, error: messagesError } = await this.opencodeClient.session.messages({
      path: { id: params.sessionId },
    });

    if (messagesError || !messagesData) {
      const errorDetails = messagesError ? JSON.stringify(messagesError) : "undefined response";
      throw new Error(`Failed to fetch conversation history: ${errorDetails}`);
    }

    // Replay the conversation history
    for (const message of messagesData) {
      // Handle user messages
      if (message.info.role === "user") {
        for (const part of message.parts) {
          if (part.type === "text") {
            await this.client.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: part.text },
              },
            });
          }
          // Note: Other part types for user messages could be handled here if needed
        }
      }
      // Handle assistant messages
      else if (message.info.role === "assistant") {
        for (const part of message.parts) {
          const notifications = toAcpNotifications(message.info as AssistantMessage, part, params.sessionId);
          for (const notification of notifications) {
            await this.client.sessionUpdate(notification);
          }
        }
      }
    }

    // Return the LoadSessionResponse with mode state
    return {
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

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      // Construct the full command string
      const fullCommand = params.args ? `${params.command} ${params.args.join(' ')}` : params.command;

      const { data: shellData, error: shellError } = await this.opencodeClient.session.shell({
        path: { id: params.sessionId },
        body: {
          agent: "terminal",
          command: fullCommand,
        },
      });

      if (shellError || !shellData || !shellData.id) {
        const errorDetails = shellError ? JSON.stringify(shellError) : "undefined shell data";
        throw new Error(`Failed to create terminal: ${errorDetails}`);
      }

      // Store the terminal in backgroundTerminals
      this.backgroundTerminals[terminalId] = {
        shellId: shellData.id,
        output: "", // Initialize with empty output
        exitStatus: null, // Initialize with null exit status
        status: "started",
      };

      return { terminalId };
    } catch (error) {
      throw new Error(`Failed to create terminal: ${error}`);
    }
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.backgroundTerminals[params.terminalId];
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }
    return {
      output: terminal.output,
      truncated: false,
      exitStatus: terminal.exitStatus,
    };
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const terminal = this.backgroundTerminals[params.terminalId];
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }
    while (terminal.status === "started") {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return {
      exitCode: terminal.exitStatus?.exitCode ?? null,
      signal: terminal.exitStatus?.signal ?? null,
    };
  }

  async "terminal/kill"(params: KillTerminalCommandRequest): Promise<KillTerminalResponse> {
    const terminal = this.backgroundTerminals[params.terminalId];
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }
    console.warn("SDK does not support killing terminals directly. Marking as killed.");
    terminal.status = "killed";
    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const terminal = this.backgroundTerminals[params.terminalId];
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }
    console.warn("SDK does not support releasing terminals directly. Deleting internal reference.");
    delete this.backgroundTerminals[params.terminalId];
    return {};
  }

  private async getModelInfo(opencodeClient: ReturnType<typeof createOpencodeClient>, sessionId: string): Promise<{ providerID: string, modelID: string }> {
    // First, try to get from the last assistant message
    const { data: messages, error: messagesError } = await opencodeClient.session.messages({ path: { id: sessionId } });
    if (!messagesError && messages && messages.length > 0) {
      const lastAssistantMessage = messages.filter(m => m.info.role === 'assistant').pop()?.info as AssistantMessage | undefined;
      if (lastAssistantMessage && lastAssistantMessage.providerID && lastAssistantMessage.modelID) {
        return { providerID: lastAssistantMessage.providerID, modelID: lastAssistantMessage.modelID };
      }
    }

    // Second, try to get the default model from the main config
    const { data: config, error: configError } = await opencodeClient.config.get();
    if (!configError && config && config.model) {
      const [providerID, modelID] = config.model.split('/');
      if (providerID && modelID) {
        return { providerID, modelID };
      }
    }

    // Third, try to get the first available model from providers
    const { data: providersData, error: providersError } = await opencodeClient.config.providers();
    if (!providersError && providersData && providersData.providers.length > 0) {
      const firstProvider = providersData.providers[0];
      const firstModelId = Object.keys(firstProvider.models)[0];
      if (firstProvider && firstModelId) {
        return { providerID: firstProvider.id, modelID: firstModelId };
      }
    }

    throw new Error("Could not determine a model to use.");
  }

  async handleCommand(sessionId: string, command: string, args: string): Promise<boolean> {
    const session = this.sessions[sessionId];
    if (!session) return false;

    const { opencodeClient } = session;

    switch (command) {
      case "help": {
        const helpMessage = `
Available slash commands:
- /init: Analyze project structure and create/update AGENTS.md.
- /models: List all available models from configured providers.
- /compact or /summarize: Compact the current session.
- /undo: Undo the last message and any associated file changes.
- /redo: Redo a previously undone message and restore file changes.
- /share: Share the current session.
- /unshare: Unshare the current session.

For more detailed information on all commands, including client-side commands and keybinds, please run 'opencode' in your terminal and use the '/help' command within the OpenCode TUI.
`;
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: helpMessage },
          },
        });
        return true;
      }
      
      case "models": {
        const { data, error } = await opencodeClient.config.providers();
        if (error || !data) {
          console.error("Error fetching models:", error);
          return true;
        }
        let modelList = "Available models:\n";
        for (const provider of data.providers) {
          for (const modelId in provider.models) {
            modelList += `- ${provider.id}/${modelId}\n`;
          }
        }
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: modelList },
          },
        });
        return true;
      }

      case "compact":
      case "summarize": {
        try {
          const { providerID, modelID } = await this.getModelInfo(opencodeClient, sessionId);
          await opencodeClient.session.summarize({
            path: { id: sessionId },
            body: {
              providerID,
              modelID,
            },
          });
        } catch (error) {
          console.error("Error during /compact or /summarize command:", error);
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}\n\nCould not compact the session.` },
            },
          });
        }
        return true;
      }

      case "init": {
        // Send a processing message to the user
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "🔍 Analyzing project structure and creating AGENTS.md file...\n" },
          },
        });
        
        try {
          const { providerID, modelID } = await this.getModelInfo(opencodeClient, sessionId);
          
          // Generate a temporary, client-side message ID for this operation
          const tempMessageID = `temp_init_${Date.now()}`;
          
          const response = await opencodeClient.session.init({
            path: { id: sessionId },
            body: {
              messageID: tempMessageID,
              providerID,
              modelID,
            }
          });
          
          if (!response.error) {
            await this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "✅ The AGENTS.md file has been created to help me understand your project structure and coding standards." },
              },
            });
          } else {
            await this.client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `❌ Error during project analysis: ${JSON.stringify(response.error)}. The AGENTS.md file may not have been created or updated.` },
              },
            });
          }
        } catch (error) {
          console.error("Error during /init command:", error);
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease try again or check your project structure.` },
            },
          });
        }
        
        return true;
      }

      case "new":
      case "clear":
        // This is a client-side command in the TUI. The agent cannot create a new session for the client.
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "The `/new` and `/clear` commands are used to start a new session in the OpenCode TUI. This agent does not support session management on behalf of the client." },
          },
        });
        return true;

      case "redo": {
        try {
          await opencodeClient.session.unrevert({ path: { id: sessionId } });
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "✅ Last action has been redone." },
            },
          });
        } catch (error) {
          console.error("Error during /redo command:", error);
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `❌ Error redoing last action: ${error instanceof Error ? error.message : 'Unknown error'}` },
            },
          });
        }
        return true;
      }
      
      case "share": {
        await opencodeClient.session.share({ path: { id: sessionId } });
        return true;
      }

      case "undo": {
        try {
          const { data: messages, error: messagesError } = await opencodeClient.session.messages({ path: { id: sessionId } });
          if (messagesError || !messages || messages.length === 0) {
            const errorDetails = messagesError ? JSON.stringify(messagesError) : "no messages found";
            throw new Error(`Could not retrieve message history to undo: ${errorDetails}`);
          }

          const lastMessage = messages[messages.length - 1];
          if (!lastMessage) {
            throw new Error("No last message found to undo.");
          }

          await opencodeClient.session.revert({
            path: { id: sessionId },
            body: { messageID: lastMessage.info.id },
          });

          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "✅ Last message has been undone." },
            },
          });
        } catch (error) {
          console.error("Error during /undo command:", error);
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `❌ Error undoing last message: ${error instanceof Error ? error.message : 'Unknown error'}` },
            },
          });
        }
        return true;
      }

      case "unshare": {
        await opencodeClient.session.unshare({ path: { id: sessionId } });
        return true;
      }

      default:
        // Assume it's a custom command
        await opencodeClient.session.command({
          path: { id: sessionId },
          body: {
            command: command,
            arguments: args,
          },
        });
        return true;
    }
  }
}

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
          content: (messagePart as any).content || [],
          locations: (messagePart as any).locations || [],
        };
      } else if (state.status === "running") {
        update = {
          sessionUpdate: "tool_call_update",
          toolCallId: callID,
          title: state.title || tool,
          status: ToolCallStatus.InProgress,
          locations: (messagePart as any).locations || [],
          content: [
            {
              type: "content",
              content: { type: "text", text: `Tool input: ${JSON.stringify(state.input || {})}` },
            },
          ],
        };
      } else if (state.status === "completed") {
        const toolKind = mapToolKind(tool);
        if (
          toolKind === ToolKind.Edit &&
          state.output &&
          typeof state.output === "object" &&
          "path" in state.output &&
          "newText" in state.output
        ) {
          update = {
            sessionUpdate: "tool_call_update",
            toolCallId: callID,
            status: ToolCallStatus.Completed,
            content: [
              {
                type: "diff",
                path: (state.output as any).path,
                oldText: (state.output as any).oldText ?? null,
                newText: (state.output as any).newText,
              },
            ],
          };
        } else {
          update = {
            sessionUpdate: "tool_call_update",
            toolCallId: callID,
            status: ToolCallStatus.Completed,
            content: [
              { type: "content", content: { type: "text", text: JSON.stringify(state.output) } },
            ],
          };
        }
      } else if (state.status === "error") {
        update = {
          sessionUpdate: "tool_call_update",
          toolCallId: callID,
          status: ToolCallStatus.Failed,
          content: [
            { type: "content", content: { type: "text", text: JSON.stringify(state.error) } },
          ],
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
          : {
              type: "text",
              text: `File: ${messagePart.filename || messagePart.url} (${messagePart.mime})`,
            },
      };
      break;
    case "reasoning": {
      // Create a plan entry for the reasoning part
      const planEntry: PlanEntry = {
        content: messagePart.text,
        priority: PlanEntryPriority.Medium,
        status: PlanEntryStatus.Pending,
      };

      update = {
        sessionUpdate: "plan",
        entries: [planEntry],
      };
      break;
    }
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
  if (
    toolName.startsWith("write") ||
    toolName.startsWith("edit") ||
    toolName.startsWith("apply") ||
    toolName.startsWith("insert")
  )
    return ToolKind.Edit;
  if (toolName.startsWith("execute")) return ToolKind.Execute;
  if (toolName.startsWith("search") || toolName.startsWith("list")) return ToolKind.Search;
  if (toolName.startsWith("browser")) return ToolKind.Fetch;
  if (
    toolName.startsWith("update") ||
    toolName.startsWith("ask") ||
    toolName.startsWith("new_task")
  )
    return ToolKind.Think;
  if (toolName.startsWith("switch")) return ToolKind.SwitchMode;
  return ToolKind.Other;
}

export function runAcp(baseUrl: string) {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);

  new AgentSideConnection((client) => new OpenCodeAcpAgent(client, baseUrl), stream);
}
